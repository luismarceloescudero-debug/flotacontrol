/**
 * Motor de diagnóstico automático — sin IA ni servicios externos.
 *
 * Incorpora reglas de dominio que los números solos no muestran:
 *  - Un grupo electrógeno trabaja quieto: sus horas "en ralentí" SON su trabajo, no desperdicio.
 *  - Un mixer o una bomba esperan en obra para descargar: parte del ralentí es operativo.
 *  - Un equipo sin cargas en el período no es un hallazgo, es un equipo que no operó
 *    (la empresa trabaja en dos provincias y no todo el parque se usa en todos lados).
 *  - Un consumo calculado sobre pocas cargas o un solo período no es confiable y se avisa.
 */

import { getPrefijo, clasificarIdentificador, MESES, normalizeEquipoKey, TIPO_POR_PREFIJO, provinciaDeCentroCosto, sugerirPosibleTypo } from './normalizer.js';
import { diasHabiles, esDiaHabil } from './feriados.js';
import { jornadaEsperada } from './analyzer.js';

// `hallazgo.detalle` se renderiza como HTML crudo en panel.js (para poder llevar <strong>
// intencional alrededor de los números) — cualquier texto libre del Excel (combustible,
// centro de costo, etc.) que se interpole ahí adentro tiene que pasar por esc() primero,
// igual que en el resto de la app, o un valor con HTML/JS en una celda se ejecutaría al
// mostrarse en el panel.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TOLERANCIA = 0.15;
const META_ALTA = 2.5;
const META_BAJA = 0.4;
export const MIN_CARGAS_CONFIABLE = 3;
export const COBERTURA_MINIMA_PCT = 40; // % de días hábiles del período con al menos una carga

/**
 * Clases de equipo "fuera de flota" que igual se dan de alta en el maestro para que su gasto
 * quede imputado a un centro de costo. Ver abrirAltaNoFlota() en panel.js.
 *  - prestamo:    unidad ajena a la empresa que igual carga con nuestra cuenta (préstamo, demo,
 *                 alquiler). Tiene patente y es un vehículo real, pero no es del parque propio.
 *  - herramienta: motocompresor, caloventor, grupo portátil… gasta gasoil pero no recorre ni
 *                 reporta horas por GPS.
 *  - servicio:    caldera, limpieza, calefacción de planta: consumo fijo de instalación.
 */
export const CLASES_NO_FLOTA = {
    prestamo: 'PRÉSTAMO / ALQUILER',
    herramienta: 'HERRAMIENTA / MANTENIMIENTO',
    servicio: 'SERVICIO DE PLANTA'
};

/**
 * Equipos que trabajan ESTACIONARIOS: el motor encendido sin desplazarse es exactamente
 * su función. Contarles el ralentí como desperdicio sería un error de lectura.
 * EX (excavadoras): son equipos de trabajo estacionario, NO de desplazamiento.
 */
export const OPERA_ESTACIONARIO = ['GE', 'MT', 'MH', 'CL', 'MC', 'AE', 'EX'];

/**
 * Equipos con espera operativa legítima: mixers y bombas pasan tiempo detenidos con el
 * motor en marcha esperando descargar o bombear en obra. Su ralentí se sigue midiendo,
 * pero se informa como "a revisar según la obra", no como desperdicio puro.
 */
export const ESPERA_OPERATIVA = ['MX', 'BM'];

const fmt = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Mediana. Se exporta para que no haya dos implementaciones dando vueltas: panel.js tenía la
 * suya, que con una cantidad par de valores devolvía el de arriba en vez del promedio de los
 * dos del medio — así que "mediana" significaba una cosa en la meta sugerida y otra en el
 * precio de referencia.
 */
export const mediana = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function categoriaRalenti(interno) {
    const p = getPrefijo(interno);
    if (OPERA_ESTACIONARIO.includes(p)) return 'estacionario';
    if (ESPERA_OPERATIVA.includes(p)) return 'espera';
    return 'desperdicio';
}

/**
 * Camionetas (CM): dentro de "desperdicio" son un caso aparte. Un tractor o una cargadora
 * quietos con el motor encendido no tienen excusa operativa; una camioneta sí la tiene con
 * frecuencia (esperar a una cuadrilla, esperar en portería/acceso, uso como apoyo de
 * seguridad) — motivos que no aplican al resto del grupo. Agruparlas juntas evita que se
 * traten como si fueran lo mismo que un tractor parado, y permite revisarlas/aceptarlas o
 * reclamarlas en bloque sin mezclarlas con el resto de "equipos de desplazamiento".
 */
export function esCamioneta(interno) {
    return getPrefijo(interno) === 'CM';
}

/**
 * ¿El consumo calculado se apoya en suficientes datos como para tomarlo en serio?
 *
 * `periodo` ({ desde, hasta }, fechas ISO) es opcional: cuando se pasa, además del umbral fijo
 * de cantidad de cargas se calcula la COBERTURA real — cuántos de los días hábiles del período
 * analizado tuvieron al menos una carga. Un umbral fijo ("3 cargas ya es confiable") no
 * distingue "3 cargas en una semana" de "3 cargas en 6 meses" (130 días hábiles): la segunda
 * es un dato mucho más débil aunque pase el mismo umbral. Se reutiliza diasHabiles() de
 * feriados.js (la misma cuenta que ya se muestra en el KPI de período del panel) para no
 * duplicar el calendario de feriados en dos lugares.
 */
/**
 * El RITMO real con el que carga un equipo, contra los meses del período.
 *
 * Existe porque la cobertura sobre días hábiles es la medida equivocada para un equipo que
 * carga poco pero regularmente. Una camioneta que carga una vez por mes, todos los meses,
 * tiene 6 cargas en 120 días hábiles (5% de cobertura) y el umbral la marca como dato flojo —
 * cuando en realidad su patrón es perfectamente estable y lo que gasta por mes SÍ se conoce.
 * Al revés, un equipo con 6 cargas todas en la misma semana de marzo tiene la misma cobertura
 * y no se sabe nada de él fuera de esa semana. Son casos opuestos que el porcentaje solo no
 * distingue; la cadencia sí.
 *
 * Lo que SÍ vuelve confiable una cadencia regular son los LITROS POR MES, no el consumo
 * específico: saber que carga 70 L todos los meses no dice cuántos km hizo. Por eso
 * `regular` habilita a confiar en el gasto, y el consumo en L/100km o L/hora sigue
 * necesitando actividad medida (GPS) o declarada (ver consumoDesdeActividadDeclarada).
 */
export function cadenciaCargas(fila, periodo = null) {
    const cargas = (fila.cargas || []).filter(c => c.fecha);
    if (!cargas.length) return null;
    const meses = new Set(cargas.map(c => String(c.fecha).slice(0, 7)));
    let mesesPeriodo = meses.size;
    if (periodo && periodo.desde && periodo.hasta) {
        const [a1, m1] = periodo.desde.slice(0, 7).split('-').map(Number);
        const [a2, m2] = periodo.hasta.slice(0, 7).split('-').map(Number);
        const n = (a2 - a1) * 12 + (m2 - m1) + 1;
        if (n > 0) mesesPeriodo = n;
    }
    const litros = cargas.reduce((s, c) => s + (parseFloat(c.litros) || 0), 0);
    const mesesConCarga = meses.size;
    const cargasPorMes = mesesConCarga ? cargas.length / mesesConCarga : 0;
    // "Regular" = cargó en al menos 3 meses y en la gran mayoría de los meses del período.
    // Con menos de 3 meses no hay patrón que sostener, es una racha.
    const cobMeses = mesesPeriodo ? mesesConCarga / mesesPeriodo : 0;
    const regular = mesesConCarga >= 3 && cobMeses >= 0.75;
    return {
        cargas: cargas.length, mesesConCarga, mesesPeriodo,
        cargasPorMes: Math.round(cargasPorMes * 10) / 10,
        litrosPorMes: mesesConCarga ? litros / mesesConCarga : 0,
        regular,
        texto: `${Math.round(cargasPorMes * 10) / 10} carga${cargasPorMes === 1 ? '' : 's'}/mes en ${mesesConCarga} de ${mesesPeriodo} mes${mesesPeriodo === 1 ? '' : 'es'}`
    };
}

/**
 * Consumo calculado a partir de la actividad DECLARADA a mano, para los equipos que no reportan
 * GPS. Es el cálculo inverso que pedía el caso "carga afuera de la empresa y el dato se pierde":
 * los litros sí los tenemos (están en la planilla de cargas); lo que falta son los km o las horas.
 * Si alguien los declara — aunque sea como rango aproximado — el consumo sale de ahí.
 *
 * Se usa el punto medio del rango. A propósito NO pisa el consumo medido: solo aplica cuando no
 * hay actividad de GPS, y siempre queda marcado como estimado con su base a la vista.
 */
export function consumoDesdeActividadDeclarada(fila, actividades = [], periodo = null) {
    const m = fila.metrics;
    const key = normalizeEquipoKey(fila.equipo.interno);
    const propias = actividades.filter(a => normalizeEquipoKey(a.interno) === key);
    if (!propias.length) return null;

    // Si hay una declaración para todo el período y otras por mes, se usan las mensuales (más
    // específicas); la de 'TODO' se usa solo si no hay ninguna mensual.
    const mensuales = propias.filter(a => a.periodo && a.periodo !== 'TODO');
    const usadas = mensuales.length ? mensuales : propias.filter(a => a.periodo === 'TODO');
    if (!usadas.length) return null;

    // Cuánto vale "1" de la base elegida dentro de cada declaración. Declarar "10 a 12 horas por
    // día" o "1 carga de 70 L por mes" es la forma natural de decirlo — nadie sabe el total del
    // semestre de memoria — así que la app expande esa base contra el período que le toca a cada
    // declaración: la de un mes puntual vale 1 mes; la de 'TODO', todos los meses del período.
    const factores = (a) => {
        const esMes = a.periodo && a.periodo !== 'TODO';
        let meses = 1, dias = 22;
        if (esMes) {
            const [an, mm] = a.periodo.split('-').map(Number);
            const desde = `${a.periodo}-01`;
            const ult = new Date(Date.UTC(an, mm, 0)).getUTCDate();
            const dh = diasHabiles(desde, `${a.periodo}-${String(ult).padStart(2, '0')}`);
            dias = dh.diasPonderados || 22;
        } else if (periodo && periodo.desde && periodo.hasta) {
            const [a1, m1] = periodo.desde.slice(0, 7).split('-').map(Number);
            const [a2, m2] = periodo.hasta.slice(0, 7).split('-').map(Number);
            meses = Math.max(1, (a2 - a1) * 12 + (m2 - m1) + 1);
            const dh = diasHabiles(periodo.desde, periodo.hasta);
            dias = dh.diasPonderados || meses * 22;
        }
        return { meses, dias };
    };
    const expandir = (a, min, max) => {
        const medio = (min + (max || min)) / 2;
        const f = factores(a);
        if (a.base === 'mes') return medio * f.meses;
        if (a.base === 'dia') return medio * f.dias;
        return medio; // 'total' (o declaraciones viejas sin base)
    };

    // LITROS: cuando la empresa solo ve algunas de las cargas (el equipo carga afuera y ese
    // ticket no entra a la planilla), los litros registrados subestiman el consumo real. Si
    // alguien declara el promedio mensual, se usa ese — pero los registrados NO se pisan: se
    // devuelven los dos para poder mostrar la diferencia, que es justamente el dato que faltaba.
    const conLitros = usadas.filter(a => (parseFloat(a.litros_min) || 0) > 0 || (parseFloat(a.litros_max) || 0) > 0);
    let litros = m.total_litros;
    let litrosDeclarados = null;
    if (conLitros.length) {
        litrosDeclarados = conLitros.reduce((s, a) =>
            s + expandir(a, parseFloat(a.litros_min) || 0, parseFloat(a.litros_max) || 0), 0);
        if (litrosDeclarados > 0) litros = litrosDeclarados;
    }
    if (litros <= 0) return null;

    // ACTIVIDAD: si ya hay medición real de GPS no se estima nada — salvo que lo único declarado
    // sean litros, en cuyo caso el aporte es el consumo corregido sobre la actividad medida.
    const conActividad = usadas.filter(a => (parseFloat(a.valor_min) || 0) > 0 || (parseFloat(a.valor_max) || 0) > 0);
    const hayMedicion = m.total_km > 0 || m.total_horas > 0;

    let total = 0, unidad = null, fuenteAct = '';
    if (hayMedicion) {
        if (!litrosDeclarados) return null; // nada nuevo que aportar
        if (m.total_horas > 0) { total = m.total_horas; unidad = 'horas'; fuenteAct = 'hs medidas por GPS'; }
        else { total = m.total_km; unidad = 'km'; fuenteAct = 'km medidos por GPS'; }
    } else {
        if (!conActividad.length) return null;
        unidad = conActividad[0].unidad;
        total = conActividad.reduce((s, a) =>
            s + expandir(a, parseFloat(a.valor_min) || 0, parseFloat(a.valor_max) || 0), 0);
        fuenteAct = unidad === 'horas' ? 'hs declaradas' : 'km declarados';
    }
    if (total <= 0) return null;

    const notaLitros = litrosDeclarados
        ? `${fmt(litros, 1)} L estimados (declarados; registrados ${fmt(m.total_litros, 1)} L)`
        : `${fmt(litros, 1)} L`;

    if (unidad === 'horas') {
        return {
            valor: litros / total, unidad: 'L/Hora', actividad: total, unidad_actividad: 'hs',
            litros, litros_registrados: m.total_litros, litros_declarados: litrosDeclarados,
            base: `${notaLitros} ÷ ${fmt(total, 1)} ${fuenteAct}`,
            declaraciones: usadas.length
        };
    }
    return {
        valor: (litros / total) * 100, unidad: 'L/100Km', actividad: total, unidad_actividad: 'km',
        litros, litros_registrados: m.total_litros, litros_declarados: litrosDeclarados,
        base: `${notaLitros} ÷ ${fmt(total)} ${fuenteAct} × 100`,
        declaraciones: usadas.length
    };
}

export function confiabilidad(fila, periodo = null) {
    const m = fila.metrics;
    const avisos = [];
    const cadencia = cadenciaCargas(fila, periodo);
    // Una cadencia regular (cargó en casi todos los meses del período) explica por sí sola que
    // haya pocas cargas: no es un dato faltante, es un equipo de uso liviano. Se deja de avisar
    // por "pocas cargas" y por cobertura baja, y se dice cuál es el patrón.
    if (m.cantidad_cargas > 0 && m.cantidad_cargas < MIN_CARGAS_CONFIABLE && !(cadencia && cadencia.regular)) avisos.push(`solo ${m.cantidad_cargas} carga${m.cantidad_cargas === 1 ? '' : 's'}`);
    if (m.cantidad_gps === 1) avisos.push('un solo período de GPS');
    if (m.total_horas > 0 && m.total_horas < 20) avisos.push(`solo ${fmt(m.total_horas, 1)} hs registradas`);
    if (m.total_km > 0 && m.total_km < 200 && m.tipo_calculo === 'L/100Km') avisos.push(`solo ${fmt(m.total_km)} km`);

    let cobertura = null;
    if (periodo && periodo.desde && periodo.hasta && Array.isArray(fila.cargas) && fila.cargas.length) {
        const diasConCarga = new Set(fila.cargas.map(c => c.fecha).filter(Boolean)).size;
        const dh = diasHabiles(periodo.desde, periodo.hasta);
        if (dh.diasPonderados > 0) {
            const pct = Math.round((diasConCarga / dh.diasPonderados) * 100);
            cobertura = { diasConCarga, diasHabiles: dh.dias, sabados: dh.sabados, diasPonderados: dh.diasPonderados, pct };
            if (pct < COBERTURA_MINIMA_PCT && !(cadencia && cadencia.regular)) {
                avisos.push(`cargó ${diasConCarga} de ${Math.round(dh.diasPonderados)} días hábiles del período (${pct}%)`);
            }
        }
    }

    // Sin actividad medida no hay consumo específico posible, por más cargas que haya: es la
    // diferencia entre "consume 0" y "no sabemos cuánto consume". Antes esto salía como
    // "0,00 L/100km" con cara de medición, que es peor que no mostrar nada.
    const sinActividad = m.total_km <= 0 && m.total_horas <= 0 && m.total_litros > 0;
    if (sinActividad) avisos.push('sin actividad medida (0 km y 0 hs de GPS): no se puede calcular consumo');

    return { confiable: avisos.length === 0, avisos, cobertura, cadencia, sinActividad };
}

/**
 * Cobertura de cargas de un equipo contra los días hábiles de su propio período activo (unión
 * de fechas de cargas + GPS). La usan tanto la franja "cobertura" de la tarjeta del panel como
 * la vista de Seguimiento, para que las dos lean siempre el mismo número — antes cada una lo
 * calculaba por su cuenta y corrían el riesgo de desalinearse. A propósito NO se recorta a 100:
 * pasarse de 100% (más cargas que días hábiles) es justamente el caso que hay que poder detectar.
 */
/**
 * Utilización: horas de GPS por día hábil del período, contra la jornada de referencia que
 * informa la operación (ver JORNADA_REFERENCIA en analyzer.js).
 *
 * Es la pieza que faltaba para leer bien un consumo bajo. Hoy un equipo que consume menos que
 * su meta aparece como "eficiente" sin más, pero hay dos causas muy distintas detrás:
 *   - trabajó lo esperado y rindió mejor → eso sí es eficiencia;
 *   - trabajó mucho menos de lo esperado → el consumo bajo solo dice que estuvo parado, y su
 *     L/hora ni siquiera es representativo para fijarle una meta.
 * El caso concreto que motivó esto: los equipos de ÁRIDOS durante la obra de la ripiera.
 */
export function utilizacion(fila, periodo = null, ubicacion = null) {
    const m = fila.metrics;
    const ref = jornadaEsperada(fila.equipo, ubicacion || fila.ubicacion);
    if (!ref) return null;

    // Numerador y denominador TIENEN que salir del mismo tramo. Si se usan las horas
    // alineadas (meses con cargas y GPS), el denominador son los días hábiles de esos meses;
    // si se usa el total de horas del equipo, el denominador son los días hábiles de todos
    // los meses que cubre su GPS. Mezclarlos —horas de siete meses divididas por los días
    // hábiles de uno— daba resultados imposibles como 48 hs por día.
    const alin = m.alineacion || {};
    const usaAlineadas = m.horas_alineadas > 0;
    const horas = usaAlineadas ? m.horas_alineadas : m.total_horas;
    if (!horas || horas <= 0) return null;

    const meses = usaAlineadas
        ? (alin.meses && alin.meses.length ? alin.meses : null)
        : (alin.meses_gps && alin.meses_gps.length ? alin.meses_gps : null);

    let desde, hasta;
    if (meses) {
        desde = `${meses[0]}-01`;
        const [uy, um] = meses[meses.length - 1].split('-').map(Number);
        hasta = `${meses[meses.length - 1]}-${String(new Date(uy, um, 0).getDate()).padStart(2, '0')}`;
    } else if (periodo && periodo.desde && periodo.hasta) {
        desde = periodo.desde; hasta = periodo.hasta;
    } else return null;

    const dh = diasHabiles(desde, hasta);
    if (!dh || dh.diasPonderados <= 0) return null;

    // Denominador ponderado: Lun-Vie=1, Sab=0.5 (4-6 hs confirmado por operaciones).
    // El GPS registra horas reales incluyendo sábados, así que el denominador debe incluirlos
    // para que el ratio tenga sentido.
    const hsPorDia = horas / dh.diasPonderados;
    // Más de 24 hs por día ponderado: GPS reportando horas imposibles (problema de dato, no
    // de operación — ya tiene su hallazgo propio).
    const estado = hsPorDia > 24 ? 'no_representativa'
        : hsPorDia < ref.min * 0.6 ? 'muy_baja'
        : hsPorDia < ref.min ? 'baja'
        : hsPorDia > ref.max * 1.25 ? 'alta'
        : 'normal';
    return {
        hsPorDia, diasHabiles: dh.dias, sabados: dh.sabados, diasPonderados: dh.diasPonderados,
        horas, desde, hasta,
        esperadoMin: ref.min, esperadoMax: ref.max, base: ref.base, nota: ref.nota,
        estado,
        pct: Math.round((hsPorDia / ref.min) * 100)
    };
}

/**
 * Calcula cuántos días hábiles dentro de [desde, hasta] caen en alguno de los rangos
 * marcados como fuera de servicio. Los rangos se recortan al período analizado.
 */
function diasHabilesEnRangos(rangos, desde, hasta) {
    let total = 0;
    for (const r of (rangos || [])) {
        if (!r.desde || !r.hasta) continue;
        const rDesde = r.desde > desde ? r.desde : desde;
        const rHasta = r.hasta < hasta ? r.hasta : hasta;
        if (rDesde > rHasta) continue;
        total += diasHabiles(rDesde, rHasta).diasPonderados;
    }
    return total;
}

export function coberturaEquipo(fila, periodo = null, rangos = []) {
    // Se cuentan DÍAS DISTINTOS con carga, no cantidad de cargas: cargar dos veces el mismo
    // día (doble turno, carga parcial y después completa) es normal y no es "más cobertura".
    // Es la misma cuenta que hace confiabilidad(), a propósito: antes esta función contaba
    // cargas y aquella contaba días, así que la tarjeta y el modal de detalle mostraban dos
    // números distintos ("53 de 60" vs "46 de 60") para el mismo equipo y el mismo período.
    const diasConCarga = new Set((fila.cargas || []).map(c => c.fecha).filter(Boolean)).size;
    if (!diasConCarga) return null;

    // Denominador: el período analizado de la flota cuando se lo pasan (para que todos los
    // equipos se midan contra la misma vara), y si no, el rango propio del equipo.
    let desde, hasta;
    if (periodo && periodo.desde && periodo.hasta) {
        desde = periodo.desde; hasta = periodo.hasta;
    } else {
        const fechasC = (fila.cargas || []).map(c => c.fecha).filter(Boolean);
        const fechasG = (fila.gps || []).map(g => g.fecha).filter(Boolean);
        const todas = [...fechasC, ...fechasG].sort();
        if (todas.length < 2) return null;
        desde = todas[0]; hasta = todas[todas.length - 1];
    }

    const dh = diasHabiles(desde, hasta);
    if (!dh || dh.totalCorridos <= 0 || dh.diasPonderados <= 0) return null;

    // Días hábiles marcados como fuera de servicio, taller, sin chofer, etc.
    // diasHabilesEnRangos ya devuelve días ponderados (Sab=0.5).
    const diasFueraServicio = rangos.length ? diasHabilesEnRangos(rangos, desde, hasta) : 0;
    // Denominador ponderado: Lun-Vie=1, Sab=0.5; nunca cae a 0.
    const diasTrabajados = Math.max(0.5, dh.diasPonderados - diasFueraServicio);
    const pct = Math.round((diasConCarga / diasTrabajados) * 100);

    // Pasarse de 100% (cargó en más días trabajados de los que tuvo el período) sigue siendo
    // detectable: ahí sí hay algo mal en el dato, no una carga doble legítima.
    return {
        cargas: fila.metrics.cantidad_cargas, diasConCarga,
        diasHabiles: dh.dias, sabados: dh.sabados, diasPonderados: dh.diasPonderados,
        diasTrabajados, diasFueraServicio,
        totalCorridos: dh.totalCorridos, completo: dh.completo,
        pct, exceso: pct > 100
    };
}

/**
 * Cuántos litros de más (o de menos) gastó el equipo respecto de lo que su meta predice para
 * la actividad que realmente midió.
 *
 * Los dos lados de la resta tienen que salir del MISMO tramo de meses — es el invariante 1
 * (ver CLAUDE.md), el mismo que ya respeta `consumo_real`. Por eso se usa la BASE ALINEADA
 * (`litros_alineados` / `km_alineados` / `horas_alineadas`: los meses que tienen cargas Y GPS)
 * y no los totales del período. Restar todos los litros del semestre menos lo esperado para
 * los meses que sí tienen GPS cuenta como "exceso" el combustible de meses que nadie midió:
 * en los datos reales de 2026 eso afectaba a 26 equipos, y en CF37 la diferencia entre una
 * base y la otra era de 1.437 L (2.474 L de exceso informado contra 3.911 L reales sobre el
 * tramo medido). No es un ajuste cosmético: `exceso_costo` es el número que encabeza el
 * hallazgo de sobreconsumo y el de ahorro.
 *
 * `litros_periodo` se devuelve aparte para poder decir cuánto gasto quedó FUERA de la
 * comparación — ese combustible existió y sigue contando en los totales de la flota, lo que
 * no se puede hacer es medirlo contra una actividad que no se registró.
 */
export function calcularExceso(fila) {
    const { metrics: m, confirmed } = fila;
    if (!confirmed || !confirmed.valor || confirmed.valor <= 0) return null;
    if (!m.consumo_real || m.consumo_real <= 0) return null;

    const litrosBase = m.litros_alineados > 0 ? m.litros_alineados : m.total_litros;
    let litrosEsperados, actividad, unidadActividad;
    if (m.tipo_calculo === 'L/100Km') {
        actividad = m.km_alineados > 0 ? m.km_alineados : m.total_km;
        if (actividad <= 0) return null;
        litrosEsperados = (confirmed.valor * actividad) / 100;
        unidadActividad = 'km';
    } else if (m.tipo_calculo === 'L/Hora') {
        actividad = m.horas_alineadas > 0 ? m.horas_alineadas : m.total_horas;
        if (actividad <= 0) return null;
        litrosEsperados = confirmed.valor * actividad;
        unidadActividad = 'hs';
    } else return null;

    const excesoLitros = litrosBase - litrosEsperados;
    // Precio por litro del período completo: es un promedio de precio, no una tasa de consumo,
    // así que no depende del tramo y usar todas las cargas lo hace más estable.
    const precioLitro = m.total_litros > 0 ? m.total_costo / m.total_litros : 0;
    return {
        litros_esperados: litrosEsperados,
        exceso_litros: excesoLitros,
        exceso_costo: excesoLitros * precioLitro,
        precio_litro: precioLitro,
        litros_base: litrosBase,
        litros_periodo: m.total_litros,
        litros_fuera_de_base: Math.max(0, m.total_litros - litrosBase),
        actividad, unidad_actividad: unidadActividad,
        meses_base: (m.alineacion && m.alineacion.meses) || [],
        base_alineada: m.litros_alineados > 0
    };
}

/**
 * Sugiere una meta a partir del consumo real medido de los pares comparables.
 * Compara primero contra misma marca+modelo; si no hay suficientes, cae a denominación.
 * Devuelve además la lista de esos pares, para poder mostrar CONTRA QUIÉN se compara.
 */
export function sugerirMeta(fila, todas = []) {
    const tipo = fila.metrics.tipo_calculo;
    if (tipo !== 'L/Hora' && tipo !== 'L/100Km') return null;

    const eq = fila.equipo;
    const filtroBase = f =>
        f.equipo.interno !== eq.interno &&
        f.metrics.tipo_calculo === tipo &&
        f.metrics.consumo_real > 0 &&
        confiabilidad(f).confiable;

    // Intentar primero con marca+modelo (comparación justa)
    let pares = [];
    let etiqueta = '';
    if (eq.marca && eq.modelo) {
        pares = todas.filter(f => filtroBase(f) && f.equipo.marca === eq.marca && f.equipo.modelo === eq.modelo);
        etiqueta = `${eq.denominacion} ${eq.marca} ${eq.modelo}`;
    }
    // Fallback a denominación si no hay suficientes pares con marca+modelo
    if (pares.length < 2) {
        pares = todas.filter(f => filtroBase(f) && f.equipo.denominacion === eq.denominacion);
        etiqueta = eq.denominacion || 'equipos';
    }
    if (pares.length < 2) return null;

    const valores = pares.map(f => f.metrics.consumo_real);
    const med = mediana(valores);
    if (med <= 0) return null;

    return {
        valor: Math.round(med * 100) / 100,
        unidad: tipo,
        n: pares.length,
        minimo: Math.min(...valores),
        maximo: Math.max(...valores),
        base: `mediana de ${pares.length} ${etiqueta.toLowerCase()} medidos`,
        pares: pares.sort((a, b) => a.metrics.consumo_real - b.metrics.consumo_real)
            .map(p => ({ interno: p.equipo.interno, valor: p.metrics.consumo_real, cargas: p.metrics.cantidad_cargas }))
    };
}

/**
 * Meta implícita a partir de las cargas reales del propio equipo: sirve cuando no hay meta
 * cargada ni pares suficientes. Es literalmente "lo que este equipo viene consumiendo".
 */
export function metaDesdeConsumoReal(fila) {
    const m = fila.metrics;
    if (!m.consumo_real || m.consumo_real <= 0) return null;
    const c = confiabilidad(fila);
    return {
        valor: Math.round(m.consumo_real * 100) / 100,
        unidad: m.tipo_calculo,
        base: `consumo real medido sobre ${m.cantidad_cargas} cargas`,
        confiable: c.confiable,
        avisos: c.avisos
    };
}

/**
 * Suma días hábiles reales de una lista de meses "YYYY-MM" (los meses en que el equipo REALMENTE
 * cargó combustible — nunca un rango inventado). Cada mes se cuenta de punta a punta con
 * diasHabiles(), que ya descuenta fines de semana y feriados.
 */
function diasHabilesDeMeses(meses = []) {
    let total = 0, totalPonderado = 0, totalSabados = 0;
    for (const ym of meses) {
        const [anio, mes] = String(ym).split('-').map(Number);
        if (!anio || !mes) continue;
        const desde = `${ym}-01`;
        const ultimoDia = new Date(anio, mes, 0).getDate();
        const hasta = `${ym}-${String(ultimoDia).padStart(2, '0')}`;
        const dh = diasHabiles(desde, hasta);
        total += dh.dias;
        totalPonderado += dh.diasPonderados;
        totalSabados += dh.sabados;
    }
    return { total, ponderado: totalPonderado, sabados: totalSabados };
}

/**
 * Cálculo inverso: para equipos que cargan combustible pero no tienen GPS, la meta permite
 * estimar cuánta actividad DEBERÍAN haber tenido. No reemplaza al GPS, pero convierte un
 * "no se puede calcular" en un número con el que sí se puede trabajar.
 *
 * Esa estimación depende por completo de que la meta cargada sea correcta — es la única fuente
 * que la sostiene. Cuando el equipo tiene una jornada de referencia conocida (JORNADA_REFERENCIA
 * en analyzer.js: horas/día que informa la propia operación, no un promedio sacado de los
 * datos), se agrega una SEGUNDA estimación independiente: días hábiles realmente cargados ×
 * jornada esperada. Si las dos coinciden, la estimación por meta queda respaldada por una fuente
 * que no depende de ella. Si no coinciden, es una señal de que la meta (o la actividad) no es
 * creíble, aunque los pares y la potencia no digan nada — ver estimacionCreible().
 */
export function actividadImplicita(fila) {
    const m = fila.metrics;
    const c = fila.confirmed;
    if (!c || !c.valor || c.valor <= 0 || m.total_litros <= 0) return null;
    let imp = null;
    if (m.tipo_calculo === 'L/Hora') {
        imp = { valor: m.total_litros / c.valor, unidad: 'horas', formula: `${fmt(m.total_litros, 1)} L ÷ ${fmt(c.valor, 2)} L/hora` };
    } else if (m.tipo_calculo === 'L/100Km') {
        imp = { valor: (m.total_litros / c.valor) * 100, unidad: 'km', formula: `${fmt(m.total_litros, 1)} L ÷ ${fmt(c.valor, 2)} L/100km × 100` };
    } else {
        return null;
    }

    if (imp.unidad === 'horas') {
        const ref = jornadaEsperada(fila.equipo, fila.ubicacion);
        const mesesCargas = (m.alineacion && m.alineacion.meses_cargas) || [];
        if (ref && mesesCargas.length) {
            const dh = diasHabilesDeMeses(mesesCargas);
            // Horas esperadas: Lun-Vie a jornada completa + sábados a jornada reducida (4-6 hs).
            // Usar días ponderados (Sab=0.5) en el denominador asume que la proporción Lun-Vie/Sab
            // se refleja en la actividad total; sumarlo explícito da el rango real más ajustado.
            const jorSab = { min: 4, max: 6 }; // JORNADA_REFERENCIA.sabado
            const horasMin = dh.total * ref.min + dh.sabados * jorSab.min;
            const horasMax = dh.total * ref.max + dh.sabados * jorSab.max;
            if (horasMin > 0) {
                // Tolerancia amplia (mitad del piso a el doble del techo): esto no busca precisión,
                // busca detectar cuando el número está en otro orden de magnitud.
                const respalda = imp.valor >= horasMin * 0.5 && imp.valor <= horasMax * 2;
                imp.referencia = {
                    dias_habiles: dh.total, sabados: dh.sabados, dias_ponderados: dh.ponderado,
                    horas_min: horasMin, horas_max: horasMax, jornada: ref, respalda,
                    formula: `${dh.total} días Lun-Vie × ${ref.min}-${ref.max} hs + ${dh.sabados} sáb × ${jorSab.min}-${jorSab.max} hs`
                };
            }
        }
    }
    return imp;
}

/**
 * Clasifica el consumo que NO pertenece a la flota rodante pero igual es gasto:
 * vehículos con patente pero sin interno asignado, y servicios de planta
 * (calderas, caloventores, limpieza, jardinería, herramientas a combustión).
 */
export function clasificarNoFlota(huerfanos = [], rawRecords = [], codigosAceptados = new Set()) {
    const cargasPorClave = new Map();
    rawRecords.filter(r => r.type === 'carga').forEach(r => {
        const k = r.interno_key || r.dominio_key;
        if (!cargasPorClave.has(k)) cargasPorClave.set(k, []);
        cargasPorClave.get(k).push(r);
    });

    const grupos = {
        vehiculo_sin_interno: { id: 'vehiculo_sin_interno', etiqueta: 'Vehículos con patente pero sin interno en el padrón', detalle: 'Tienen dominio válido: pueden ser unidades propias que faltan dar de alta en el maestro, o vehículos ajenos a la flota (préstamo, alquiler, tercero) que cargan con esta cuenta y nunca van a tener interno propio. Marcá "Así está bien" en los que correspondan a este segundo caso — no son un dato faltante.', items: [], litros: 0, costo: 0 },
        planta: { id: 'planta', etiqueta: 'Servicios y mantenimiento de planta', detalle: 'Calderas, caloventores, limpieza y consumos fijos de planta. No son flota rodante: no se les puede calcular L/100km ni L/hora, pero son gasto y conviene seguirlos por centro de costo.', items: [], litros: 0, costo: 0 },
        otros: { id: 'otros', etiqueta: 'Otros consumos sin identificar', detalle: 'Códigos que no siguen la nomenclatura ni son patentes. Conviene normalizarlos en la planilla de cargas.', items: [], litros: 0, costo: 0 }
    };

    const PALABRAS_PLANTA = /CALDERA|CALOVENTOR|LIMPIEZA|JARDIN|PLANTA|TALLER|SURTIDOR|CANALETA|BOMBEO|HERRAMIENT/;

    huerfanos.forEach(h => {
        // Bug real, no cosmético: `h` (huérfano) nunca trae `interno_key` — analizarFlota() solo
        // guarda el interno "crudo" tal como vino del Excel (ver huerfanosMap en analyzer.js).
        // Buscarlo tal cual contra cargasPorClave (que sí está indexado por la clave normalizada)
        // fallaba en silencio para cualquier código con cero a la izquierda — "GR01"/"CL03" no
        // encontraban sus propias cargas, así que quedaban con costo, centro de costo y sector
        // vacíos aunque sí tuvieran cargas. Se normaliza acá mismo antes de buscar.
        const cargas = cargasPorClave.get(normalizeEquipoKey(h.interno)) || cargasPorClave.get(h.interno) || [];
        const costo = cargas.reduce((s, c) => s + (parseFloat(c.importe) || 0), 0);
        const centros = {};
        const sectores = {};
        cargas.forEach(c => {
            if (c.centro_costo) centros[c.centro_costo] = (centros[c.centro_costo] || 0) + 1;
            if (c.sector) sectores[c.sector] = (sectores[c.sector] || 0) + 1;
        });
        const topCentro = Object.keys(centros).sort((a, b) => centros[b] - centros[a])[0] || '—';
        const topSector = Object.keys(sectores).sort((a, b) => sectores[b] - sectores[a])[0] || '';

        const esDominio = clasificarIdentificador(h.interno).tipo === 'dominio';
        const g = esDominio ? grupos.vehiculo_sin_interno
            : (PALABRAS_PLANTA.test(h.interno) || PALABRAS_PLANTA.test(topSector) ? grupos.planta : grupos.otros);

        // Código marcado como "así está bien" (ej. un vehículo de un programa de préstamo/demo
        // que nunca va a tener un interno propio en el padrón): se cuenta aparte para el aviso
        // de "quedaron afuera", pero no entra en la lista ni en los totales del hallazgo.
        if (codigosAceptados.has(h.interno)) {
            g.excluidos = (g.excluidos || 0) + 1;
            g.excluidosLitros = (g.excluidosLitros || 0) + h.litros;
            return;
        }

        // `dominio` se arrastra para que el alta como no-flota pueda crear la ficha con interno
        // Y patente cuando el huérfano trae las dos cosas (ej. "DEMO SCANIA" + AH685WR): si se
        // diera de alta solo por una de las dos claves, las cargas indexadas por la otra
        // seguirían sin resolver y el código volvería a aparecer como huérfano.
        g.items.push({ codigo: h.interno, dominio: h.dominio || '', litros: h.litros, costo, cargas: h.cargas, centro_costo: topCentro, sector: topSector });
        g.litros += h.litros;
        g.costo += costo;
    });

    Object.values(grupos).forEach(g => g.items.sort((a, b) => b.litros - a.litros));
    return Object.values(grupos).filter(g => g.items.length);
}

/**
 * Prefijos nuevos, agrupados: códigos huérfanos (sin fila en el maestro) cuyo prefijo de letras
 * todavía no está reconocido ni en TIPO_POR_PREFIJO (la lista fija) ni en `prefijosOficiales`
 * (lo que se fue dando de alta a mano). No es lo mismo que "consumo fuera de la flota" en
 * general — clasificarNoFlota() ya agrupa TODO lo huérfano; esto filtra específicamente los
 * prefijos que la app directamente no sabe nombrar, para ofrecer sumarlos a la base oficial.
 *
 * A propósito restringido a evidencia de Mendoza (centro de costo del grupo): agregar un código
 * como "oficial" le pone nombre y lo saca de las listas de "sin identificar" en TODA la app, así
 * que antes de ofrecerlo hace falta la certeza de qué operación es — y esa certeza hoy solo la
 * tenemos armada para Mendoza (ver provinciaDeCentroCosto). Un prefijo nuevo de San Juan sigue
 * viéndose igual que antes, agrupado dentro de "Otros consumos sin identificar".
 */
export function detectarPrefijosNuevos(huerfanos = [], rawRecords = [], prefijosOficiales = []) {
    const prefijosConocidos = new Set([...Object.keys(TIPO_POR_PREFIJO), ...prefijosOficiales.map(p => p.prefijo)]);

    const cargasPorClave = new Map();
    rawRecords.filter(r => r.type === 'carga').forEach(r => {
        const k = r.interno_key || r.dominio_key;
        if (!cargasPorClave.has(k)) cargasPorClave.set(k, []);
        cargasPorClave.get(k).push(r);
    });

    const porPrefijo = new Map();
    huerfanos.forEach(h => {
        if (clasificarIdentificador(h.interno).tipo === 'dominio') return; // es patente, no un código con prefijo
        const prefijo = getPrefijo(h.interno);
        if (!prefijo || prefijo.length > 4 || prefijosConocidos.has(prefijo)) return;

        // Bug real, no cosmético: `h` (huérfano) nunca trae `interno_key` — analizarFlota() solo
        // guarda el interno "crudo" tal como vino del Excel (ver huerfanosMap en analyzer.js).
        // Buscarlo tal cual contra cargasPorClave (que sí está indexado por la clave normalizada)
        // fallaba en silencio para cualquier código con cero a la izquierda — "GR01"/"CL03" no
        // encontraban sus propias cargas, así que quedaban con costo, centro de costo y sector
        // vacíos aunque sí tuvieran cargas. Se normaliza acá mismo antes de buscar.
        const cargas = cargasPorClave.get(normalizeEquipoKey(h.interno)) || cargasPorClave.get(h.interno) || [];
        const centros = {};
        cargas.forEach(c => { if (c.centro_costo) centros[c.centro_costo] = (centros[c.centro_costo] || 0) + 1; });
        const topCentro = Object.keys(centros).sort((a, b) => centros[b] - centros[a])[0] || '';

        if (!porPrefijo.has(prefijo)) porPrefijo.set(prefijo, { prefijo, codigos: new Set(), litros: 0, costo: 0, cargas: 0, centros: {} });
        const g = porPrefijo.get(prefijo);
        g.codigos.add(h.interno);
        g.litros += h.litros || 0;
        g.costo += cargas.reduce((s, c) => s + (parseFloat(c.importe) || 0), 0);
        g.cargas += cargas.length;
        if (topCentro) g.centros[topCentro] = (g.centros[topCentro] || 0) + 1;
    });

    return [...porPrefijo.values()].map(g => {
        const topCentro = Object.keys(g.centros).sort((a, b) => g.centros[b] - g.centros[a])[0] || '';
        const provincia = provinciaDeCentroCosto(topCentro);
        return {
            prefijo: g.prefijo, codigos: [...g.codigos].sort(),
            litros: g.litros, costo: g.costo, cargas: g.cargas,
            centro_costo: topCentro, provincia, esMendoza: provincia === 'MENDOZA'
        };
    }).sort((a, b) => b.litros - a.litros);
}

/**
 * Compara una métrica mes a mes para ver si un desvío se sostiene o fue puntual.
 * Es la respuesta a "ver condiciones puntuales a un mes y si se normaliza en otro".
 */
export function evolucionMensual(fila) {
    const porMes = new Map();
    const agregar = (r, campo, valor) => {
        if (!r.periodo) return;
        if (!porMes.has(r.periodo)) porMes.set(r.periodo, { periodo: r.periodo, litros: 0, km: 0, horas: 0, parado: 0, cargas: 0 });
        porMes.get(r.periodo)[campo] += valor;
    };
    fila.cargas.forEach(c => { agregar(c, 'litros', parseFloat(c.litros) || 0); agregar(c, 'cargas', 1); });
    fila.gps.forEach(g => {
        agregar(g, 'km', parseFloat(g.distancia) || 0);
        agregar(g, 'horas', (g.horas && g.horas.total) || 0);
        // Horas "parado": el GPS reportó y el equipo estaba quieto con el motor apagado. No entra
        // en ningún cálculo de consumo, pero distingue "no hay dato de ese mes" de "hay dato y
        // dice que no trabajó" — que son dos conclusiones muy distintas.
        agregar(g, 'parado', (g.horas && g.horas.parado) || 0);
    });

    const esHora = fila.metrics.tipo_calculo === 'L/Hora';
    return [...porMes.values()].sort((a, b) => a.periodo.localeCompare(b.periodo)).map(m => {
        const factor = esHora ? m.horas : m.km;
        const consumo = factor > 0 ? (esHora ? m.litros / factor : (m.litros / factor) * 100) : 0;
        return { ...m, factor, consumo, unidad: fila.metrics.tipo_calculo };
    });
}

/**
 * Completitud de datos de un equipo: cuánto alcanza lo que hay para decidir sobre él.
 * Sirve para ordenar y agrupar los hallazgos "primero los que tienen datos completos, último
 * los que apenas registran una carga" — así se empieza a corregir por donde el dato alcanza,
 * en vez de discutir la meta de un equipo del que se sabe una sola cosa.
 */
export function completitudDatos(fila) {
    const m = fila.metrics || {};
    const cargas = m.cantidad_cargas || 0;
    const meses = new Set();
    (fila.cargas || []).forEach(c => { if (c.periodo) meses.add(c.periodo); });
    (fila.gps || []).forEach(g => { if (g.periodo) meses.add(g.periodo); });
    const tieneGps = (fila.gps || []).length > 0 && ((m.total_km || 0) > 0 || (m.total_horas || 0) > 0);
    const tieneMeta = !!(fila.confirmed && fila.confirmed.valor > 0);
    // Escala pensada para ORDENAR, no para mostrarse como un porcentaje con pretensión de exactitud.
    const score = Math.min(cargas, 20) * 3 + meses.size * 5 + (tieneGps ? 25 : 0) + (tieneMeta ? 5 : 0);
    let nivel = 'bajo';
    if (tieneGps && cargas >= 4 && meses.size >= 2) nivel = 'alto';
    else if ((tieneGps && cargas >= 2) || cargas >= 4) nivel = 'medio';
    return {
        score, nivel, cargas, meses: meses.size, tieneGps, tieneMeta,
        etiqueta: `${cargas} carga${cargas === 1 ? '' : 's'} · ${meses.size} mes${meses.size === 1 ? '' : 'es'} · ${tieneGps ? 'con GPS' : 'sin GPS'}`
    };
}

export const NIVELES_COMPLETITUD = {
    alto: { etiqueta: 'Datos completos', detalle: 'GPS, varias cargas y más de un mes: alcanza para decidir con confianza.' },
    medio: { etiqueta: 'Datos parciales', detalle: 'Hay con qué trabajar, pero conviene mirar el detalle antes de tocar la meta.' },
    bajo: { etiqueta: 'Apenas hay datos', detalle: 'Una o dos cargas, o ningún dato de actividad: cualquier promedio acá es frágil. Corregir estos al final.' }
};

/**
 * Meses en los que el equipo registró actividad (km/hs) pero NO cargó combustible, o al revés.
 * Un equipo parado, en taller o fuera de servicio parte del período arrastra el promedio hacia
 * abajo y hace que su consumo real parezca imposible contra la meta — sin que la meta esté mal.
 * `consumoSaneado` es el consumo recalculado dejando afuera esos meses raros: si con eso la meta
 * cierra, el problema nunca fue la meta.
 */
export function mesesFueraDeServicio(fila) {
    const meses = evolucionMensual(fila);
    const conActividadSinCarga = meses.filter(m => m.factor > 0 && m.litros <= 0);
    const conCargaSinActividad = meses.filter(m => m.litros > 0 && m.factor <= 0);
    const normales = meses.filter(m => m.factor > 0 && m.litros > 0);
    const litrosN = normales.reduce((s, m) => s + m.litros, 0);
    const factorN = normales.reduce((s, m) => s + m.factor, 0);
    const esHora = fila.metrics.tipo_calculo === 'L/Hora';
    const consumoSaneado = factorN > 0 ? (esHora ? litrosN / factorN : (litrosN / factorN) * 100) : null;
    return { meses, conActividadSinCarga, conCargaSinActividad, normales, consumoSaneado };
}

/**
 * Por qué una meta "parece mal cargada". No siempre es la meta: puede ser un período fuera de
 * servicio, una unidad distinta o simplemente que hay muy pocos datos. Cada causa tiene otro
 * siguiente paso, y confundirlas lleva a "corregir" una meta que estaba bien — que es
 * exactamente cómo se generan observaciones nuevas del mismo tipo el mes siguiente.
 */
export function causaMetaRara(fila, todas = []) {
    const m = fila.metrics;
    const meta = fila.confirmed && fila.confirmed.valor ? fila.confirmed.valor : 0;
    if (!meta || !m.consumo_real) return null;
    const ratio = m.consumo_real / meta;
    const comp = completitudDatos(fila);
    const fs = mesesFueraDeServicio(fila);
    const sug = sugerirMeta(fila, todas);
    const cercaDe = (v, obj, tol = 0.4) => v > 0 && Math.abs(Math.log(v / obj)) < tol;

    // 1. Unidad equivocada: el salto típico es ×100 (L/km cargado donde la app mide L/100Km).
    if (cercaDe(ratio, 100) || cercaDe(ratio, 0.01)) {
        return {
            causa: 'unidad', etiqueta: 'posible unidad distinta',
            resumen: 'la diferencia es de casi exactamente 100×',
            consejo: 'Casi seguro la meta está cargada en L/km y la app mide en L/100Km (o al revés). Corregí la unidad en "Consumos Estimados"; el número está bien, lo que está mal es en qué se expresa.'
        };
    }
    // 2. Fuera de servicio: hay meses con actividad registrada y cero litros, y sacándolos cierra.
    if (fs.conActividadSinCarga.length && fs.consumoSaneado) {
        const rs = fs.consumoSaneado / meta;
        if (rs > META_BAJA && rs < META_ALTA) {
            const ms = fs.conActividadSinCarga.map(x => x.periodo).join(', ');
            return {
                causa: 'fuera_de_servicio', etiqueta: 'período fuera de servicio',
                resumen: `${fs.conActividadSinCarga.length} mes${fs.conActividadSinCarga.length === 1 ? '' : 'es'} con actividad y sin cargas (${ms})`,
                consejo: `Sacando ${fs.conActividadSinCarga.length === 1 ? 'ese mes' : 'esos meses'}, el consumo da ${fmt(fs.consumoSaneado, 2)} contra una meta de ${fmt(meta, 2)}: la meta está bien. Lo que hay que revisar es por qué el GPS registró actividad sin cargas — equipo en taller, motor encendido sin operar, o cargas del período que faltan cargar en la planilla.`
            };
        }
    }
    // 3. La rara es la meta, no el equipo: está lejos de lo que miden sus pares.
    const potM = potenciaEquipo(fila.equipo);
    const rpM = potM ? ratioPotenciaFlota(todas, potM.unidad) : null;
    if (rpM && potM) {
        const esperado = rpM.ratio * potM.valor;
        if (esperado > 0 && meta / esperado >= 0.6 && meta / esperado <= 1.7) {
            return {
                causa: 'meta_ok_equipo_grande', etiqueta: 'la meta está bien: el equipo es más grande',
                resumen: `${potM.valor} ${potM.unidad} · lo esperable para esa potencia es ${fmt(esperado, 1)} y la meta es ${fmt(meta, 1)}`,
                consejo: `No toques esta meta. Para un equipo de ${potM.valor} ${potM.unidad}, ${fmt(meta, 1)} ${fila.metrics.tipo_calculo} es lo que corresponde según lo que la propia flota tiene cargado (${fmt(rpM.ratio, 3)} por ${potM.unidad} sobre ${rpM.n} equipos). Lo que hay que revisar es por qué midió tan distinto: lo más probable es que haya trabajado a carga parcial o muy pocas horas.`
            };
        }
    }
    if (sug && sug.valor > 0) {
        const r = meta / sug.valor;
        if (r >= 3 || r <= 1 / 3) {
            return {
                causa: 'meta_vs_pares', etiqueta: 'meta lejos de sus pares',
                resumen: `la meta es ${r >= 3 ? `${fmt(r, 1)}× ` : `la ${fmt(1 / r, 1)}ª parte de `}la mediana de sus pares (${fmt(sug.valor, 2)})`,
                consejo: `Sus pares medidos dan ${fmt(sug.valor, 2)} ${sug.unidad}. Reemplazar la meta por el consumo real o por la mediana de pares es lo correcto acá: el equipo no está fallando, el valor de referencia nunca fue realista.`
            };
        }
    }
    // 4. Pocos datos: no alcanza para afirmar nada todavía.
    if (comp.nivel === 'bajo') {
        return {
            causa: 'pocos_datos', etiqueta: 'pocos datos',
            resumen: comp.etiqueta,
            consejo: 'Con estos datos cualquier promedio es frágil. Antes de tocar la meta, esperá a que el equipo acumule cargas o confirmá que no falten cargas del período sin registrar.'
        };
    }
    return {
        causa: 'meta', etiqueta: 'meta a revisar',
        resumen: `consume ${ratio >= META_ALTA ? `${fmt(ratio, 1)}× la meta` : `el ${fmt(ratio * 100)}% de la meta`}`,
        consejo: 'Los datos son consistentes y aun así la meta no cierra: reemplazala por el consumo real medido desde "Ajustar metas".'
    };
}

/**
 * ¿Es creíble la actividad estimada por cálculo inverso? El cálculo divide litros ÷ meta: si la
 * meta está mal, el resultado no es "aproximado", es inventado — y encima se muestra con cara de
 * dato ("≈ 1,6 hs"). Este chequeo es el que evita que ese número se use como si fuera medido.
 */
export function estimacionCreible(fila, todas = []) {
    const imp = actividadImplicita(fila);
    if (!imp) return null;
    const meta = fila.confirmed.valor;
    const sug = sugerirMeta(fila, todas);
    const comp = completitudDatos(fila);
    const motivos = [];
    let factorPares = null;

    // Antes de acusar a la meta, hay que ver si el equipo es simplemente MÁS GRANDE que sus
    // pares. Un grupo electrógeno de 440 KVA consume ~85 L/hora y uno de 120 KVA ~25: comparar
    // los dos en L/hora crudo marca como error una meta perfectamente correcta. Si la meta es
    // coherente con la potencia declarada según lo que la propia flota tiene cargado, se acepta.
    const pot = potenciaEquipo(fila.equipo);
    const rp = pot ? ratioPotenciaFlota(todas, pot.unidad) : null;
    let respaldadaPorPotencia = false;
    if (rp && pot) {
        const esperado = rp.ratio * pot.valor;
        if (esperado > 0 && meta / esperado >= 0.6 && meta / esperado <= 1.7) respaldadaPorPotencia = true;
    }

    if (sug && sug.valor > 0 && !respaldadaPorPotencia) {
        factorPares = meta / sug.valor;
        if (factorPares >= 3) motivos.push(`la meta cargada (${fmt(meta, 2)}) es ${fmt(factorPares, 1)}× la mediana de sus pares medidos (${fmt(sug.valor, 2)})`);
        else if (factorPares <= 1 / 3) motivos.push(`la meta cargada (${fmt(meta, 2)}) es la ${fmt(1 / factorPares, 1)}ª parte de la mediana de sus pares medidos (${fmt(sug.valor, 2)})`);
    }
    // Actividad implícita absurda para la cantidad de cargas: si hubiera trabajado tan poco,
    // no habría hecho falta ir al surtidor tantas veces.
    //
    // OJO: esta regla vale para equipos que se desplazan hasta un surtidor. Un grupo electrógeno
    // de 440 KVA quema 85 L/hora, así que 135 litros SON una hora y media de trabajo — y eso es
    // perfectamente normal, no un error. Si la meta está respaldada por la potencia declarada,
    // la actividad implícita también lo está y no hay nada que objetar.
    const cargas = respaldadaPorPotencia ? 0 : (fila.metrics.cantidad_cargas || 0);
    if (cargas > 0) {
        if (imp.unidad === 'horas' && imp.valor < cargas * 2) motivos.push(`daría ${fmt(imp.valor, 1)} horas para ${cargas} carga${cargas === 1 ? '' : 's'}: menos de 2 horas de trabajo por carga`);
        if (imp.unidad === 'km' && imp.valor < cargas * 20) motivos.push(`daría ${fmt(imp.valor)} km para ${cargas} carga${cargas === 1 ? '' : 's'}: menos de 20 km por carga`);
    }

    // Tercer respaldo, independiente de la meta y de los pares: cuánto DEBERÍA haber trabajado
    // según la jornada de referencia que informa la propia operación (JORNADA_REFERENCIA), sobre
    // los días hábiles que realmente cargó. No depende de ningún otro equipo ni de la meta —
    // por eso, cuando contradice la estimación por meta, es la señal más fuerte de las tres.
    if (imp.referencia && !imp.referencia.respalda) {
        motivos.push(`daría ${fmt(imp.valor, 1)} hs, pero la jornada de referencia (${imp.referencia.jornada.nota}) espera entre ${fmt(imp.referencia.horas_min, 0)} y ${fmt(imp.referencia.horas_max, 0)} hs para los ${imp.referencia.dias_habiles} días hábiles que cargó`);
    }

    return { implicita: imp, meta, creible: motivos.length === 0, motivos, sugerida: sug, factorPares, completitud: comp, respaldadaPorPotencia, potencia: pot, respaldadaPorJornada: !!(imp.referencia && imp.referencia.respalda) };
}

/**
 * Meses en los que el equipo tiene datos REALES (cargas con litros, o GPS con km/horas), contra
 * los meses que abarca el período cargado. Un equipo que aparece en las seis planillas pero solo
 * tiene actividad en enero no es un equipo con seis meses de datos: es un equipo con uno. Los
 * registros en cero ya vienen filtrados desde el analyzer, así que acá simplemente se cuentan
 * los meses que quedaron.
 */
export function coberturaMensual(fila, periodo = {}) {
    const meses = new Set();
    (fila.cargas || []).forEach(c => { if (c.periodo) meses.add(c.periodo); });
    (fila.gps || []).forEach(g => { if (g.periodo) meses.add(g.periodo); });
    let mesesPeriodo = 0;
    if (periodo.desde && periodo.hasta) {
        const [a1, m1] = periodo.desde.slice(0, 7).split('-').map(Number);
        const [a2, m2] = periodo.hasta.slice(0, 7).split('-').map(Number);
        if (a1 && m1 && a2 && m2) mesesPeriodo = (a2 - a1) * 12 + (m2 - m1) + 1;
    }
    const conDatos = meses.size;
    const listaMeses = [...meses].sort();
    const ratio = mesesPeriodo > 0 ? conDatos / mesesPeriodo : null;
    return { conDatos, mesesPeriodo, listaMeses, ratio, parcial: mesesPeriodo >= 3 && conDatos > 0 && (conDatos <= 1 || ratio <= 0.34) };
}


/**
 * Qué corresponde hacer con UN equipo dentro de UN hallazgo. Es la respuesta a "¿y esto cómo lo
 * resuelvo?": en vez de dejar la decisión a criterio de quien mire la lista, se mira el dato y se
 * dice qué escenario es y cuál es el siguiente paso concreto — con la acción ya elegida, para que
 * se pueda aplicar de a uno o en bloque.
 *
 * `accion` es lo que la interfaz sabe ejecutar: 'aceptar' (ralentí aceptable), 'reclamo' (reclamo
 * de revisión de GPS), 'seguimiento', 'meta' (ir a ajustar la meta), 'excluir' (apartar del
 * análisis), 'tabla' (ir a los registros) o 'nada' (no corresponde tocar nada).
 */
export function resolverEquipo(hallazgoId, fila, todas = []) {
    const m = fila.metrics;
    const ralenti = m.horas_ralenti || 0;
    const totalHs = m.total_horas || 0;
    const pct = totalHs > 0 ? (ralenti / totalHs) * 100 : null;

    // --- Ralentí en equipos cuyo trabajo es desplazarse (y camionetas) ---
    if (hallazgoId === 'ralenti' || hallazgoId === 'ralenti_camionetas') {
        const grupo = todas.filter(f => f.metrics.horas_ralenti > 0 && categoriaRalenti(f.equipo.interno) === categoriaRalenti(fila.equipo.interno));
        const prom = grupo.length ? grupo.reduce((s, f) => s + f.metrics.horas_ralenti, 0) / grupo.length : 0;
        if (pct !== null && pct >= 60) {
            return { escenario: 'desproporcionado', etiqueta: 'desproporcionado', accion: 'reclamo',
                veredicto: `${fmt(pct)}% de sus horas en ralentí: más tiempo encendido sin trabajar que trabajando. Antes de asumir desperdicio hay que descartar que el GPS esté contando mal — pedir revisión del equipo.`,
                textoAccion: 'Reclamo GPS' };
        }
        if (prom > 0 && ralenti <= prom) {
            return { escenario: 'en_promedio', etiqueta: 'dentro del promedio del grupo', accion: 'aceptar',
                veredicto: `${fmt(ralenti)} hs contra un promedio de ${fmt(prom)} hs de su grupo: está en la media para abajo. Se promedia y se acepta — no hay nada que corregir acá.`,
                textoAccion: 'Marcar aceptable' };
        }
        if (prom > 0 && ralenti < prom * 2) {
            return { escenario: 'sobre_promedio', etiqueta: 'por encima del grupo', accion: 'seguimiento',
                veredicto: `${fmt(ralenti)} hs contra ${fmt(prom)} hs de promedio del grupo: está arriba pero no es imposible. Conviene confirmarlo con el operador antes de aceptarlo o accionar.`,
                textoAccion: 'Marcar para seguimiento' };
        }
        return { escenario: 'muy_alto', etiqueta: 'muy por encima del grupo', accion: 'seguimiento',
            veredicto: `${fmt(ralenti)} hs: más del doble del promedio de su grupo (${fmt(prom)} hs). Vale revisar la operación de este equipo puntual antes de aceptar el número.`,
            textoAccion: 'Marcar para seguimiento' };
    }

    // --- Ralentí inverosímil: acá NO se acepta nada, el número no puede ser real ---
    if (hallazgoId === 'ralenti_inverosimil') {
        if (totalHs > 0 && ralenti > totalHs) {
            return { escenario: 'ralenti_mayor_total', etiqueta: 'imposible', accion: 'reclamo',
                veredicto: `El GPS reporta ${fmt(ralenti)} hs de ralentí sobre ${fmt(totalHs)} hs totales: más ralentí que tiempo transcurrido. Es una falla de medición, no una forma de operar — corresponde reclamo, no "aceptable".`,
                textoAccion: 'Reclamo GPS' };
        }
        if (ralenti > 0 && (m.horas_movimiento || 0) <= 0) {
            return { escenario: 'sin_movimiento', etiqueta: 'ralentí sin trabajo', accion: 'reclamo',
                veredicto: `${fmt(ralenti)} hs de ralentí y cero horas de movimiento: el equipo figura encendido todo el período sin haber trabajado nunca. O el sensor quedó trabado, o el equipo está mal identificado.`,
                textoAccion: 'Reclamo GPS' };
        }
        return { escenario: 'revisar', etiqueta: 'a verificar', accion: 'reclamo',
            veredicto: 'El número no resiste una lectura razonable. Antes de usarlo para cualquier conclusión, pedir revisión del equipo GPS.',
            textoAccion: 'Reclamo GPS' };
    }

    // --- Mixers y bombas: parte de la espera es operativa ---
    if (hallazgoId === 'ralenti_espera') {
        if (pct !== null && pct >= 70) {
            return { escenario: 'espera_excesiva', etiqueta: 'espera excesiva', accion: 'seguimiento',
                veredicto: `${fmt(pct)}% del tiempo en espera. Aguardar descarga en obra es parte del trabajo, pero a este nivel el problema es de programación de obra, no del equipo: vale llevarlo a quien coordina.`,
                textoAccion: 'Marcar para seguimiento' };
        }
        return { escenario: 'espera_normal', etiqueta: 'espera operativa', accion: 'aceptar',
            veredicto: `${pct !== null ? fmt(pct) + '% ' : ''}en espera: para un mixer o una bomba, aguardar la descarga en obra ES el trabajo. Se acepta y deja de aparecer.`,
            textoAccion: 'Marcar aceptable' };
    }

    // --- Cargan combustible sin ningún dato de actividad ---
    if (hallazgoId === 'sin_medicion') {
        const tuvoGpsAlgunaVez = (fila.gps || []).length > 0;
        const cat = categoriaRalenti(fila.equipo.interno);
        if (tuvoGpsAlgunaVez) {
            return { escenario: 'gps_dejo_de_reportar', etiqueta: 'el GPS dejó de reportar', accion: 'reclamo',
                veredicto: 'Tiene filas de GPS pero sin km ni horas útiles: el equipo está instalado y no está midiendo. Eso se reclama, no se compensa con una meta.',
                textoAccion: 'Reclamo GPS' };
        }
        if (cat === 'estacionario') {
            return { escenario: 'estacionario_sin_gps', etiqueta: 'equipo estacionario sin GPS', accion: 'meta',
                veredicto: 'Es un equipo que trabaja quieto (grupo electrógeno, motobomba, compresor): nunca va a tener km. Cargándole una meta en L/hora se puede estimar la actividad por cálculo inverso y al menos controlarlo.',
                textoAccion: 'Cargar meta' };
        }
        return { escenario: 'sin_gps', etiqueta: 'sin GPS instalado', accion: 'meta',
            veredicto: 'No hay telemetría de este equipo. Cargarle una meta es el único camino para pasar de "no se puede calcular" a un número con el que trabajar; si carga muchos litros, es candidato a que se le instale GPS.',
            textoAccion: 'Cargar meta' };
    }

    return null;
}


/**
 * Auditoría de calidad de las cargas. No mira el consumo de los equipos sino el DATO en sí:
 * si falta el archivo de un mes, si hay cargas sin valorizar, si el mismo combustible está
 * escrito de dos formas, si hay filas repetidas. Son los errores que no se ven mirando una
 * tarjeta — se ven mirando la planilla entera de una — y que ensucian todo lo que se calcule
 * después: un mes sin Resumen de Flota deja a decenas de equipos "sin dato de actividad", y una
 * carga con costo cero baja el total de gasto sin que nadie se entere.
 */
export function auditarCalidadCargas(rawRecords = []) {
    const cargas = rawRecords.filter(r => r.type === 'carga');
    const gps = rawRecords.filter(r => r.type === 'gps');
    const mesDe = (r) => r.periodo || (r.fecha ? String(r.fecha).slice(0, 7) : null);
    const mesesGps = new Set(gps.map(mesDe).filter(Boolean));

    // 1. Meses con cargas y sin ningún Resumen de Flota cargado.
    const porMes = new Map();
    cargas.forEach(c => {
        const p = mesDe(c);
        if (!p) return;
        if (!porMes.has(p)) porMes.set(p, { periodo: p, cargas: 0, litros: 0, costo: 0, internos: new Set() });
        const m = porMes.get(p);
        m.cargas++;
        m.litros += parseFloat(c.litros) || 0;
        m.costo += parseFloat(c.importe) || 0;
        if (c.interno) m.internos.add(c.interno);
    });
    const mesesSinGps = [...porMes.values()]
        .filter(m => !mesesGps.has(m.periodo))
        .sort((a, b) => a.periodo.localeCompare(b.periodo))
        .map(m => ({ ...m, equipos: m.internos.size }));

    // 2. Cargas sin valorizar: hay litros pero el precio o el costo vienen en cero.
    const sinValor = cargas.filter(c => (parseFloat(c.litros) || 0) > 0 &&
        ((parseFloat(c.importe) || 0) <= 0 || (parseFloat(c.precio_unitario) || 0) <= 0));

    // 3. El mismo combustible escrito de dos formas ("YPF 500" y "YPF500"): la app los cuenta
    //    como productos distintos y se rompen los totales por tipo de combustible.
    const soloLetras = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const porNorm = new Map();
    cargas.forEach(c => {
        const k = soloLetras(c.combustible);
        if (!k) return;
        if (!porNorm.has(k)) porNorm.set(k, new Map());
        const m = porNorm.get(k);
        m.set(c.combustible, (m.get(c.combustible) || 0) + 1);
    });
    const variantes = [...porNorm.entries()]
        .filter(([, m]) => m.size > 1)
        .map(([clave, m]) => ({ clave, formas: [...m.entries()].sort((a, b) => b[1] - a[1]) }));

    // 4. Filas repetidas, separadas en dos categorías que NO se resuelven igual.
    //
    // EXACTO: coincide absolutamente todo — equipo, fecha, litros, importe, precio unitario,
    // combustible, lugar, centro de costo y chofer. Dos cargas reales del mismo equipo el mismo
    // día jamás dan idénticos hasta el centavo y el litro con un decimal; eso es la misma fila
    // entrada dos veces. Se puede corregir sola con seguridad, dejando una y descartando la copia.
    //
    // POSIBLE: coincide equipo + fecha + litros, pero alguno de los otros campos difiere (otro
    // importe, otro lugar de carga, otro chofer). Ahí sí puede ser legítimo — dos cargas del
    // mismo día en surtidores distintos, o un precio corregido a mano. Eso NO se toca solo: se
    // muestra el detalle de qué campos difieren para poder decidir contra el comprobante.
    const CAMPOS_IDENTIDAD = ['importe', 'precio_unitario', 'combustible', 'lugar_carga', 'centro_costo', 'chofer', 'hora'];
    const normCampo = (v) => String(v == null ? '' : v).trim().toUpperCase();
    const vistos = new Map();
    const duplicados = [];
    cargas.forEach(c => {
        const k = `${c.interno_key || c.interno}|${c.fecha}|${Math.round((parseFloat(c.litros) || 0) * 10)}`;
        if (vistos.has(k)) {
            const original = vistos.get(k);
            const difieren = CAMPOS_IDENTIDAD.filter(campo => {
                if (campo === 'importe' || campo === 'precio_unitario') {
                    return Math.round((parseFloat(original[campo]) || 0) * 100) !== Math.round((parseFloat(c[campo]) || 0) * 100);
                }
                return normCampo(original[campo]) !== normCampo(c[campo]);
            });
            duplicados.push({ original, repetida: c, exacto: difieren.length === 0, difieren });
        } else vistos.set(k, c);
    });
    const duplicadosExactos = duplicados.filter(d => d.exacto);
    const duplicadosPosibles = duplicados.filter(d => !d.exacto);

    // 5. La misma normalización del punto 3 (espacio/guion/mayúsculas de más), pero aplicada a
    // TODO texto libre de la carga, no solo el combustible: lugar de carga, centro de costo y
    // chofer. A esta altura del sistema una variante de escritura no debería pasar inadvertida
    // — pero unificarla es una decisión del usuario, no algo que la app resuelva sola: acá solo
    // se detecta y se agrupa, la corrección se ofrece (y se aplica) desde "Unificar variantes"
    // en el Panel, nunca de manera automática.
    const CAMPOS_VARIANTES_TEXTO = [
        { campo: 'lugar_carga', etiqueta: 'Lugar de carga' },
        { campo: 'centro_costo', etiqueta: 'Centro de costo' },
        { campo: 'chofer', etiqueta: 'Chofer' }
    ];
    const variantesCampos = [];
    CAMPOS_VARIANTES_TEXTO.forEach(({ campo, etiqueta }) => {
        const porClave = new Map();
        cargas.forEach(c => {
            const valor = String(c[campo] || '').trim();
            if (valor.length < 3) return; // "S/D", "-", etc: ruido, no una variante real
            const k = soloLetras(valor);
            if (!k) return;
            if (!porClave.has(k)) porClave.set(k, new Map());
            const m = porClave.get(k);
            m.set(valor, (m.get(valor) || 0) + 1);
        });
        porClave.forEach((m, clave) => {
            if (m.size < 2) return;
            const formas = [...m.entries()].sort((a, b) => b[1] - a[1]);
            variantesCampos.push({
                campo, etiqueta, clave, formas,
                total: formas.reduce((s, [, n]) => s + n, 0)
            });
        });
    });
    variantesCampos.sort((a, b) => b.total - a.total);

    // 6. Precio unitario que no coincide con el resto de las cargas del MISMO combustible.
    // Verificado contra los datos reales: cada combustible (INFINIA DIESEL, YPF 500, X10,
    // QUANTIUM DIESEL, QUANTIUM NAFTA, NAFTA SUPER) tiene un único precio por litro en TODA la
    // planilla, sin excepción — no varía por lugar de carga ni por mes. Con esa base, una carga
    // del mismo combustible a un precio distinto no es una variación de mercado (el resto de la
    // flota prueba que el precio no se mueve): es un error de tipeo, una fila mal completada, o
    // — si son varias y son recientes — el inicio real de un aumento de precio, que hay que
    // confirmar a mano antes de tocar nada. Por eso esto solo detecta y junta la evidencia; no
    // corrige nada solo.
    const porCombustiblePrecio = new Map();
    cargas.forEach(c => {
        const comb = String(c.combustible || '').trim();
        const precio = parseFloat(c.precio_unitario) || 0;
        if (!comb || precio <= 0) return;
        if (!porCombustiblePrecio.has(comb)) porCombustiblePrecio.set(comb, new Map());
        const m = porCombustiblePrecio.get(comb);
        if (!m.has(precio)) m.set(precio, []);
        m.get(precio).push(c);
    });
    const preciosInconsistentes = [];
    porCombustiblePrecio.forEach((porPrecio, comb) => {
        if (porPrecio.size < 2) return; // un solo precio para este combustible: nada que señalar
        const ordenados = [...porPrecio.entries()].sort((a, b) => b[1].length - a[1].length);
        const [precioMayoritario, cargasMayoria] = ordenados[0];
        ordenados.slice(1).forEach(([precio, cs]) => {
            preciosInconsistentes.push({ combustible: comb, precio_esperado: precioMayoritario, precio_real: precio, cargas: cs, referencia_n: cargasMayoria.length });
        });
    });
    preciosInconsistentes.sort((a, b) => b.cargas.length - a.cargas.length);

    return { mesesSinGps, sinValor, variantes, variantesCampos, duplicados, duplicadosExactos, duplicadosPosibles, preciosInconsistentes, totalCargas: cargas.length, mesesGps: [...mesesGps].sort() };
}


/**
 * Potencia declarada del equipo, normalizada. El maestro la trae como "440 KVA" o "180 HP".
 * Sirve para comparar equipos de distinto tamaño: 85 L/hora es altísimo para un grupo de 120 KVA
 * y perfectamente normal para uno de 440. Sin normalizar por potencia, la comparación contra
 * "pares" mezcla peras con manzanas y marca como error una meta que está bien.
 */
export function potenciaEquipo(eq) {
    const t = String(eq?.potencia || '').toUpperCase().replace(',', '.');
    const m = t.match(/([\d.]+)\s*(KVA|KW|HP|CV)/);
    if (!m) return null;
    const valor = parseFloat(m[1]);
    if (!valor || valor <= 0) return null;
    return { valor, unidad: m[2] === 'CV' ? 'HP' : m[2] };
}

/**
 * Ratio litros/hora por unidad de potencia, calculado sobre los ESTIMADOS OFICIALES de la flota
 * que sí tienen potencia declarada. Es el dato que permite decir "para un equipo de esta
 * potencia, lo esperable es tanto" sin inventar coeficientes de manual.
 */
export function ratioPotenciaFlota(filas = [], unidad = 'KVA') {
    const puntos = [];
    filas.forEach(f => {
        const p = potenciaEquipo(f.equipo);
        const meta = f.confirmed && f.confirmed.valor > 0 && f.metrics.tipo_calculo === 'L/Hora' ? f.confirmed.valor : 0;
        if (p && p.unidad === unidad && meta > 0) puntos.push({ interno: f.equipo.interno, potencia: p.valor, meta, ratio: meta / p.valor });
    });
    if (puntos.length < 2) return null;
    // mediana() compartida, no una copia local: con una cantidad par de puntos el elemento
    // "del medio" devuelve el de arriba en vez del promedio de los dos centrales, y este ratio
    // decide si una meta queda respaldada por la potencia declarada (estimacionCreible).
    return { ratio: mediana(puntos.map(p => p.ratio)), n: puntos.length, unidad, puntos: puntos.sort((a, b) => a.potencia - b.potencia) };
}

/**
 * Investigación real de la meta de un equipo: no muestra lo que la app ya sabe, va a buscar el
 * dato a las fuentes que existen, en orden de autoridad, y dice de dónde salió cada candidato y
 * cuánto se le puede creer. Devuelve una lista de fuentes, no un número suelto: el usuario decide
 * viendo de dónde viene cada una.
 */
export function investigarMeta(fila, todas = [], estimadosCrudos = []) {
    const eq = fila.equipo;
    const m = fila.metrics;
    const fuentes = [];
    const claveEq = (x) => normalizeEquipoKey(x || '');

    // 1. El estimado oficial del propio equipo (la fuente de mayor autoridad que existe).
    const propio = estimadosCrudos.find(e => claveEq(e.interno) === claveEq(eq.interno));
    if (propio && propio.consumo_estimado_valor > 0) {
        fuentes.push({
            orden: 1, fuente: 'Consumos Estimados (dato oficial del equipo)', confianza: 'alta',
            valor: propio.consumo_estimado_valor, unidad: propio.consumo_estimado_unidad || m.tipo_calculo,
            detalle: `Figura en la planilla "Consumos Estimados" como ${propio.consumo_estimado || propio.consumo_estimado_valor}.`
        });
    }

    // 2. Un equipo idéntico (misma marca y modelo) con estimado oficial: para gemelos, es el
    //    mismo número por definición.
    if (eq.marca && eq.modelo) {
        const gemelo = todas.find(f => f.equipo.interno !== eq.interno &&
            f.equipo.marca === eq.marca && f.equipo.modelo === eq.modelo &&
            f.confirmed && f.confirmed.valor > 0 && f.confirmed.source !== 'Maestro');
        if (gemelo) {
            fuentes.push({
                orden: 2, fuente: `Equipo idéntico: ${gemelo.equipo.interno}`, confianza: 'alta',
                valor: gemelo.confirmed.valor, unidad: gemelo.metrics.tipo_calculo,
                detalle: `${gemelo.equipo.interno} es un ${eq.marca} ${eq.modelo}, el mismo modelo que este, y tiene esa meta cargada.`
            });
        }
    }

    // 3. Lo que el propio equipo viene consumiendo, si hay con qué medirlo.
    if (m.consumo_real > 0) {
        const c = confiabilidad(fila);
        fuentes.push({
            orden: 3, fuente: 'Consumo real medido de este equipo', confianza: c.confiable ? 'alta' : 'baja',
            valor: Math.round(m.consumo_real * 100) / 100, unidad: m.tipo_calculo,
            detalle: `Medido sobre ${m.cantidad_cargas} carga${m.cantidad_cargas === 1 ? '' : 's'} y ${fmt(m.total_horas || m.total_km, 1)} ${m.tipo_calculo === 'L/Hora' ? 'horas' : 'km'} del período` +
                (c.confiable ? '.' : ` — poco confiable: ${c.avisos.join(', ')}.`)
        });
    }

    // 4. Proporcional a su potencia, según lo que la propia flota tiene cargado. Esto es lo que
    //    distingue "consume mucho" de "es un equipo grande".
    const pot = potenciaEquipo(eq);
    if (pot) {
        const r = ratioPotenciaFlota(todas, pot.unidad);
        if (r) {
            const valor = Math.round(r.ratio * pot.valor * 100) / 100;
            fuentes.push({
                orden: 4, fuente: `Proporcional a su potencia (${pot.valor} ${pot.unidad})`, confianza: 'media',
                valor, unidad: 'L/Hora',
                detalle: `La flota promedia ${fmt(r.ratio, 3)} L/hora por ${pot.unidad} sobre ${r.n} equipos con potencia declarada ` +
                    `(${r.puntos.slice(0, 4).map(p => `${p.interno} ${p.potencia}${p.unidad || pot.unidad}→${fmt(p.meta, 0)}`).join(', ')}). ` +
                    `Para ${pot.valor} ${pot.unidad} da ${fmt(valor, 1)} L/hora.`
            });
        }
    }

    // 5. La mediana de pares medidos: último recurso, y con la advertencia de que ignora el tamaño.
    const sug = sugerirMeta(fila, todas);
    if (sug) {
        fuentes.push({
            orden: 5, fuente: 'Mediana de pares medidos', confianza: pot ? 'baja' : 'media',
            valor: sug.valor, unidad: sug.unidad,
            detalle: sug.base + (pot ? ` — ojo: compara contra equipos que pueden ser de otra potencia, así que para un ${pot.valor} ${pot.unidad} puede quedar muy corto.` : '')
        });
    }

    fuentes.sort((a, b) => a.orden - b.orden);
    const metaActual = fila.confirmed && fila.confirmed.valor > 0 ? fila.confirmed.valor : null;
    const recomendada = fuentes[0] || null;
    // ¿La meta que ya tiene coincide con alguna fuente confiable? Entonces está bien y no hay
    // que tocarla, aunque otras comparaciones digan lo contrario.
    const respaldo = metaActual
        ? fuentes.find(f => f.confianza !== 'baja' && Math.abs(f.valor - metaActual) / metaActual <= 0.25)
        : null;
    return { fuentes, metaActual, recomendada, respaldo, potencia: pot, faltanDatos: !fuentes.length };
}

// ============================================================ HALLAZGOS

export function generarDiagnostico(filas = [], totales = {}, rawRecords = [], ralentiEstados = [], noFlotaAceptados = [], equiposExcluidos = [], extra = {}) {
    const { prefijosOficiales = [], prefijosIgnorados = [] } = extra;
    const hallazgos = [];
    // Equipos apartados a mano (ej. pasaron a San Juan y dejaron de reportar acá): siguen en el
    // maestro y en las tablas, pero no generan hallazgos ni ensucian promedios ni medianas.
    const excluidosMap = new Map(equiposExcluidos.map(e => [e.interno, e]));
    filas = filas.filter(f => !excluidosMap.has(f.equipo.interno));

    // Equipos dados de alta como NO FLOTA (préstamo/alquiler tipo "DEMO SCANIA", o herramienta
    // y servicio de planta: limpieza, caldera, caloventor, motocompresor). Están en el maestro
    // a propósito — es lo que hace que dejen de contar como "código sin padrón" y que su gasto
    // se impute al centro de costo — pero no son flota: no tienen meta de L/100km ni de L/hora,
    // no reportan GPS, y no tiene sentido medirles consumo ni compararlos contra pares. Salen de
    // todos los hallazgos de consumo por acá, y su gasto se reporta aparte (hallazgo no_flota_alta).
    const noFlotaAlta = filas.filter(f => f.equipo.no_flota);
    filas = filas.filter(f => !f.equipo.no_flota);

    // Estado que el usuario le asignó al ralentí de un equipo puntual (aceptable/seguimiento):
    // "aceptable" saca al equipo de los hallazgos de ralentí de ahora en más (sin borrar el
    // dato, solo cómo se interpreta); "seguimiento" lo deja visible pero marcado.
    const ralentiEstadoMap = new Map(ralentiEstados.map(r => [r.interno, r]));
    const esRalentiAceptable = (interno) => ralentiEstadoMap.get(interno)?.estado === 'aceptable';
    const subSeguimiento = (interno) => ralentiEstadoMap.get(interno)?.estado === 'seguimiento' ? ' · en seguimiento' : '';

    // Un equipo sin cargas en el período no operó: no es un hallazgo. La empresa trabaja en
    // dos provincias y no todo el parque se usa en todos lados ni en todos los meses.
    const activos = filas.filter(f => f.metrics.cantidad_cargas > 0);
    const periodo = { desde: totales.periodo_desde, hasta: totales.periodo_hasta };
    const conExceso = activos.map(f => ({ fila: f, exceso: calcularExceso(f), conf: confiabilidad(f, periodo) })).filter(x => x.exceso);

    // ---------- 0. Correcciones que se aplicaron solas ----------
    // No es un problema a resolver — ya está resuelto. Es el aviso de qué se decidió sin
    // preguntar, para que quede a la vista y se pueda deshacer si hace falta (ver
    // autocorreccion.js). Deshacer cada tipo usa el modal que ya existe para eso: un interno
    // dado de alta se edita/borra desde Base de Datos; un código aceptado se destilda desde
    // "Códigos válidos así"; una meta alineada se pisa desde "Ajustar metas" o reimportando
    // Consumos Estimados con el valor real de fábrica.
    const accionesRecientes = (extra.accionesRecientes || []).filter(a => !a.revisado);
    if (accionesRecientes.length) {
        const porTipo = { alta_interno: [], aceptado_no_flota: [], meta_alineada: [] };
        accionesRecientes.forEach(a => { (porTipo[a.tipo] || (porTipo[a.tipo] = [])).push(a); });
        const partes = [];
        if (porTipo.alta_interno.length) partes.push(`${porTipo.alta_interno.length} equipo${porTipo.alta_interno.length === 1 ? '' : 's'} nuevo${porTipo.alta_interno.length === 1 ? '' : 's'} dado${porTipo.alta_interno.length === 1 ? '' : 's'} de alta`);
        if (porTipo.aceptado_no_flota.length) partes.push(`${porTipo.aceptado_no_flota.length} código${porTipo.aceptado_no_flota.length === 1 ? '' : 's'} sin identificar aceptado${porTipo.aceptado_no_flota.length === 1 ? '' : 's'} como "así está bien"`);
        if (porTipo.meta_alineada.length) partes.push(`${porTipo.meta_alineada.length} meta${porTipo.meta_alineada.length === 1 ? '' : 's'} alineada${porTipo.meta_alineada.length === 1 ? '' : 's'} al consumo real`);
        hallazgos.push({
            id: 'acciones_automaticas', severidad: 'baja', icono: 'fa-robot', no_comparar: true,
            titulo: accionesRecientes.length === 1
                ? `1 corrección se aplicó sola: ${partes.join(', ')}`
                : `${accionesRecientes.length} correcciones se aplicaron solas: ${partes.join(', ')}`,
            detalle: `El diagnóstico automático resuelve solo lo que no tiene ambigüedad — nunca adivina, solo actúa donde el siguiente paso es el único posible. <strong>Equipo nuevo dado de alta:</strong> el código tenía forma de interno válida y la app sabe calcularle algo, y no existía en el maestro. <strong>Aceptado "así está bien":</strong> el código no tiene forma de interno ni de patente, no hay más dato para resolverlo. <strong>Meta alineada:</strong> el equipo no tenía meta cargada, se usó su propio consumo real medido — se pisa sola en cuanto llegue el valor de fábrica real. <strong>Deshacer</strong> revierte exactamente esa acción (borra el alta, destilda el código, o vacía la meta) y no vuelve a aplicarse sola en la próxima sesión.`,
            equipos: accionesRecientes.slice(0, 15).map(a => ({
                interno: a.codigo, denominacion: '',
                texto: a.tipo === 'alta_interno' ? 'equipo nuevo' : a.tipo === 'meta_alineada' ? 'meta alineada' : 'aceptado',
                sub: `${a.motivo} ${a.detalle ? '· ' + a.detalle : ''} · ${new Date(a.fecha).toLocaleDateString('es-AR')}`,
                accion_id: a.id, accion_tipo: a.tipo
            }))
        });
    }

    // ---------- 1. Sobreconsumo valorizado ----------
    const excedidos = conExceso
        .filter(x => x.fila.metrics.desvio_pct > TOLERANCIA * 100 && x.exceso.exceso_litros > 0)
        .filter(x => x.fila.metrics.consumo_real / x.fila.confirmed.valor < META_ALTA)
        .sort((a, b) => b.exceso.exceso_costo - a.exceso.exceso_costo);

    if (excedidos.length) {
        const litros = excedidos.reduce((s, x) => s + x.exceso.exceso_litros, 0);
        const costo = excedidos.reduce((s, x) => s + x.exceso.exceso_costo, 0);
        const dudosos = excedidos.filter(x => !x.conf.confiable).length;
        const ajustados = excedidos.filter(x => x.fila.confirmed.source === 'Maestro').length;
        // Combustible que quedó FUERA de la comparación por no tener GPS del mismo mes: no es
        // un error, pero es gasto real que este número no está midiendo y conviene decirlo.
        const litrosFuera = excedidos.reduce((s, x) => s + (x.exceso.litros_fuera_de_base || 0), 0);
        hallazgos.push({
            id: 'sobreconsumo', severidad: 'alta', icono: 'fa-fire',
            titulo: `${excedidos.length} equipos consumieron ${fmt(litros)} L por encima de su meta`,
            detalle: `Equivale a <strong>$${fmt(costo)}</strong> en el período. Se comparan los litros realmente cargados contra los que corresponderían a la meta según la actividad (km u horas) del GPS, <strong>sobre los meses que tienen las dos fuentes</strong> — la misma base con la que se calcula el consumo.` +
                (litrosFuera > 1 ? ` Quedan <strong>${fmt(litrosFuera)} L</strong> fuera de esta comparación (meses con cargas pero sin GPS): son gasto real, pero no hay actividad medida contra la cual compararlos.` : '') +
                (ajustados ? ` <em>${ajustados} de ellos usan una meta ajustada manualmente; si aún exceden, puede ser un desvío puntual de ese período.</em>` : '') +
                (dudosos ? ` <em>${dudosos} de estos casos se apoyan en pocos datos: conviene confirmarlos antes de accionar.</em>` : ''),
            impacto_costo: costo,
            equipos: excedidos.slice(0, 12).map(x => {
                const fuenteMeta = x.fila.confirmed.source === 'Maestro' ? 'ajustada' : 'estimada';
                return {
                    interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                    texto: `+${fmt(x.exceso.exceso_litros)} L · $${fmt(x.exceso.exceso_costo)}`,
                    sub: `real ${fmt(x.fila.metrics.consumo_real, 2)} vs meta ${fmt(x.fila.confirmed.valor, 2)} ${x.fila.metrics.tipo_calculo} (${fuenteMeta}, +${fmt(x.fila.metrics.desvio_pct)}%)` +
                         (x.conf.confiable ? ` · ${x.fila.metrics.cantidad_cargas} cargas` : ` · ⚠ ${x.conf.avisos.join(', ')}`)
                };
            })
        });
    }

    // ---------- 2. Ahorro ----------
    const eficientes = conExceso
        .filter(x => x.fila.metrics.desvio_pct < -TOLERANCIA * 100 && x.exceso.exceso_litros < 0)
        .filter(x => x.fila.metrics.consumo_real / x.fila.confirmed.valor > META_BAJA)
        .sort((a, b) => a.exceso.exceso_costo - b.exceso.exceso_costo);

    if (eficientes.length) {
        const ahorro = -eficientes.reduce((s, x) => s + x.exceso.exceso_costo, 0);
        // Un consumo por debajo de la meta puede ser eficiencia real o un equipo que casi no
        // trabajó. Se avisa acá mismo cuántos de estos están además por debajo de su jornada
        // esperada, para no leer como logro lo que en realidad es inactividad.
        const paradosEntreEficientes = eficientes.filter(x => {
            const u = utilizacion(x.fila, periodo);
            return u && (u.estado === 'baja' || u.estado === 'muy_baja');
        }).length;
        hallazgos.push({
            id: 'ahorro', severidad: 'ok', icono: 'fa-leaf',
            titulo: `${eficientes.length} equipos consumieron menos que su meta`,
            detalle: `Un ahorro equivalente a <strong>$${fmt(ahorro)}</strong>. Si el desvío es grande, revisá que la meta no esté sobredimensionada o que no falten cargas por registrar.` +
                (paradosEntreEficientes
                    ? ` <strong>Ojo: ${paradosEntreEficientes} de estos equipos trabajaron por debajo de su jornada esperada</strong>, así que en esos casos el consumo bajo no es rendimiento sino menos actividad — ver el hallazgo de jornada más abajo antes de tomarlo como ahorro.`
                    : ''),
            impacto_costo: -ahorro,
            equipos: eficientes.slice(0, 8).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.exceso.exceso_litros)} L · $${fmt(x.exceso.exceso_costo)}`,
                sub: `real ${fmt(x.fila.metrics.consumo_real, 2)} vs meta ${fmt(x.fila.confirmed.valor, 2)} ${x.fila.metrics.tipo_calculo}`
            }))
        });
    }

    // ---------- 2 bis. Equipos que trabajaron por debajo de su jornada de referencia ----------
    // Va pegado al hallazgo de ahorro a propósito: es la explicación alternativa del mismo
    // número. Un equipo puede consumir menos que su meta porque rindió mejor, o porque
    // simplemente no trabajó — y son dos conclusiones opuestas sobre el mismo dato. Sin esto,
    // un sector entero parado (áridos durante la obra de la ripiera) figura como un logro de
    // eficiencia y encima arrastra las metas hacia abajo si se las normaliza contra ese real.
    const subutilizados = activos
        .map(f => ({ fila: f, u: utilizacion(f, periodo) }))
        .filter(x => x.u && (x.u.estado === 'baja' || x.u.estado === 'muy_baja'))
        .sort((a, b) => a.u.pct - b.u.pct);

    if (subutilizados.length) {
        const muyBajos = subutilizados.filter(x => x.u.estado === 'muy_baja').length;
        const conAhorroAparente = subutilizados.filter(x => x.fila.metrics.desvio_pct !== null && x.fila.metrics.desvio_pct < -TOLERANCIA * 100).length;
        const ref = subutilizados[0].u;
        hallazgos.push({
            id: 'subutilizacion', severidad: muyBajos ? 'media' : 'baja', icono: 'fa-gauge-simple-low',
            no_comparar: true,
            titulo: `${subutilizados.length} equipos trabajaron por debajo de la jornada esperada`,
            detalle: `La referencia operativa es de <strong>${ref.esperadoMin}-${ref.esperadoMax} horas por día hábil</strong> ` +
                `(áridos y mixers). Estos equipos quedaron por debajo${muyBajos ? `, y ${muyBajos} de ellos por menos de la mitad` : ''}. ` +
                `Esto <strong>no es un problema de consumo</strong>: es contexto para leerlo. ` +
                (conAhorroAparente
                    ? `<strong>${conAhorroAparente} de ellos figuran hoy consumiendo menos que su meta</strong> — con esta jornada, ese "ahorro" no es eficiencia: es un equipo que estuvo parado. `
                    : '') +
                `Cuidado al normalizar metas contra un período así: la meta quedaría fijada con el consumo de meses de baja actividad. ` +
                `Si hay una causa conocida (una obra, una parada de planta, baja de producción), conviene anotarla en el equipo desde "Marcar para seguimiento" para no volver a investigarlo el mes que viene.`,
            equipos: subutilizados.slice(0, 12).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.u.hsPorDia, 1)} hs/día hábil`,
                sub: `esperado ${x.u.esperadoMin}-${x.u.esperadoMax} (${x.u.base}) · ${fmt(x.u.horas, 0)} hs en ${x.u.diasHabiles} días hábiles` +
                     (x.fila.metrics.desvio_pct !== null && x.fila.metrics.desvio_pct < 0 ? ` · figura ${fmt(Math.abs(x.fila.metrics.desvio_pct))}% bajo su meta` : '')
            }))
        });
    }

    // ---------- 3. Metas mal cargadas ----------
    // "La meta está mal" es solo UNA de las explicaciones posibles: también puede ser un mes
    // fuera de servicio que diluye el promedio, una unidad distinta, o que apenas haya datos.
    // Cada caso se etiqueta con su causa probable y su siguiente paso, porque tratar a todos
    // como "meta mal cargada" es cómo se termina pisando una meta que estaba bien.
    const metasRaras = activos
        .filter(f => f.confirmed && f.confirmed.valor > 0 && f.metrics.consumo_real > 0)
        .map(f => ({
            fila: f, ratio: f.metrics.consumo_real / f.confirmed.valor, sug: metaDesdeConsumoReal(f),
            comp: completitudDatos(f)
        }))
        .filter(x => x.ratio >= META_ALTA || x.ratio <= META_BAJA)
        .map(x => ({ ...x, causa: causaMetaRara(x.fila, activos) }))
        // Primero los que tienen datos completos (se pueden corregir con confianza hoy) y al
        // final los que apenas registran una carga.
        .sort((a, b) => (b.comp.score - a.comp.score) || (Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio))));

    if (metasRaras.length) {
        const porCausa = new Map();
        metasRaras.forEach(x => { const c = x.causa?.causa || 'meta'; porCausa.set(c, (porCausa.get(c) || 0) + 1); });
        const fueraServicio = porCausa.get('fuera_de_servicio') || 0;
        hallazgos.push({
            id: 'metas', severidad: 'media', icono: 'fa-bullseye',
            titulo: `${metasRaras.length} metas parecen mal cargadas`,
            detalle: `El consumo real difiere tanto de la meta que lo más probable es que el valor de "Consumos Estimados" esté equivocado o en otra unidad, no que el equipo funcione mal. Podés reemplazarlas por el consumo real medido desde <strong>Ajustar metas</strong>.` +
                (fueraServicio ? ` <em>Ojo: ${fueraServicio} de est${fueraServicio === 1 ? 'os casos parece' : 'os casos parecen'} tener meses con actividad y sin cargas — ahí la meta puede estar bien y lo que falta es el dato. Usá <strong>Chequear período fuera de servicio</strong> antes de pisarla.</em>` : ''),
            accion: { texto: 'Ajustar estas metas', filtro: 'metas_raras' },
            equipos: metasRaras.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `real ${fmt(x.fila.metrics.consumo_real, 2)} vs meta ${fmt(x.fila.confirmed.valor, 2)}`,
                sub: `${x.causa ? x.causa.etiqueta + ' · ' : ''}${x.ratio >= META_ALTA ? `consume ${fmt(x.ratio, 1)}× la meta` : `consume el ${fmt(x.ratio * 100)}% de la meta`} · sugerido: ${fmt(x.sug ? x.sug.valor : 0, 2)} · ${x.comp.etiqueta}`,
                causa: x.causa ? x.causa.causa : null,
                completitud: x.comp.nivel
            }))
        });
    }

    // ---------- 4. Sin meta, con sugerencia ----------
    const sinMeta = activos
        .filter(f => !f.confirmed || !f.confirmed.valor)
        .filter(f => ['L/Hora', 'L/100Km'].includes(f.metrics.tipo_calculo))
        .map(f => ({ fila: f, sug: sugerirMeta(f, activos) || metaDesdeConsumoReal(f) }))
        .filter(x => x.sug)
        .sort((a, b) => b.fila.metrics.total_litros - a.fila.metrics.total_litros);

    if (sinMeta.length) {
        hallazgos.push({
            id: 'sin_meta', severidad: 'media', icono: 'fa-bullseye-pointer',
            titulo: `${sinMeta.length} equipos no tienen meta cargada`,
            detalle: `Sin meta no hay contra qué comparar. Mientras no exista el dato oficial, la app propone la <strong>mediana de sus pares medidos</strong>, o el <strong>consumo real del propio equipo</strong> si no hay pares suficientes. Se aplican de a uno o en bloque desde <strong>Ajustar metas</strong>.`,
            accion: { texto: 'Ajustar metas faltantes', filtro: 'sin_meta' },
            equipos: sinMeta.slice(0, 12).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `sugerido: ${fmt(x.sug.valor, 2)} ${x.sug.unidad}`,
                sub: x.sug.base + (x.sug.pares ? ` · rango ${fmt(x.sug.minimo, 1)}–${fmt(x.sug.maximo, 1)}` : '')
            }))
        });
    }

    // ---------- 5. Comparación contra pares (marca, modelo y potencia; fallback a denominación) ----------
    // Agrupar por la clave más específica posible: marca+modelo > marca > denominación.
    // Así un GE01 de 250 kVA no se compara contra un GE03 de 500 kVA.
    function claveParGrupo(eq) {
        const deno = eq.denominacion || '';
        const marca = eq.marca || '';
        const modelo = eq.modelo || '';
        // Si tiene marca y modelo, agrupar por deno+marca+modelo: el modelo ya implica la
        // potencia, así que agregarla no cambiaría el grupo.
        if (marca && modelo) return `${deno}|${marca}|${modelo}`;
        // Sin modelo, la potencia SÍ hace falta en la clave. El comentario de arriba decía
        // desde siempre que un GE de 250 kVA no se compara contra uno de 500, pero la
        // potencia se leía en una variable que después no se usaba: un grupo "deno|marca" (o
        // peor, solo "deno") mezclaba máquinas de tamaños distintos y el que era grande
        // aparecía consumiendo "más que sus pares" por serlo, no por estar fallando.
        const p = potenciaEquipo(eq);
        const pot = p ? `${p.valor} ${p.unidad}` : '';
        if (marca) return `${deno}|${marca}|${pot}`;
        return `${deno}||${pot}`;
    }
    function etiquetaGrupo(key) {
        const [deno, marca, resto] = key.split('|');
        // Con marca y modelo, `resto` es el modelo; sin modelo, es la potencia (o vacío).
        if (marca && resto) return `${deno} ${marca} ${resto}`;
        if (marca) return `${deno} ${marca}`;
        if (resto) return `${deno} de ${resto}`;
        return deno;
    }

    const porGrupo = new Map();
    activos.filter(f => f.metrics.consumo_real > 0 && confiabilidad(f, periodo).confiable).forEach(f => {
        const k = claveParGrupo(f.equipo);
        if (!porGrupo.has(k)) porGrupo.set(k, []);
        porGrupo.get(k).push(f);
    });

    const peores = [];
    porGrupo.forEach((grupo, key) => {
        // Necesitamos al menos 2 pares (3 en el grupo) para comparar
        if (grupo.length < 2) return;
        const deno = etiquetaGrupo(key);
        const orden = grupo.slice().sort((a, b) => a.metrics.consumo_real - b.metrics.consumo_real);
        const med = mediana(orden.map(f => f.metrics.consumo_real));
        if (med <= 0) return;
        grupo.forEach(f => {
            const ratio = f.metrics.consumo_real / med;
            // Con grupos chicos (2-3), solo alertar con desvíos más claros (>35%)
            const umbral = grupo.length < 4 ? 1.35 : 1.25;
            if (ratio > umbral) {
                const specs = [f.equipo.potencia, f.equipo.capacidad].filter(Boolean).join(' · ');
                peores.push({
                    fila: f, deno, mediana: med, ratio, specs,
                    pares: orden.map(p => ({
                        interno: p.equipo.interno, valor: p.metrics.consumo_real,
                        esEste: p.equipo.interno === f.equipo.interno,
                        specs: [p.equipo.potencia, p.equipo.capacidad].filter(Boolean).join(' · ')
                    }))
                });
            }
        });
    });
    peores.sort((a, b) => b.ratio - a.ratio);

    if (peores.length) {
        hallazgos.push({
            id: 'pares', severidad: 'media', icono: 'fa-code-compare',
            titulo: `${peores.length} equipos consumen más que sus pares comparables`,
            detalle: `Comparación contra la mediana de equipos similares (misma marca y modelo cuando hay dato, o misma denominación si no). No se comparan equipos de distinta potencia o modelo entre sí. Cuando una máquina consume bastante más que otras iguales, suele apuntar a un problema mecánico, operación o cargas mal imputadas.`,
            comparaciones: peores.slice(0, 8).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.deno,
                valor: x.fila.metrics.consumo_real, mediana: x.mediana, unidad: x.fila.metrics.tipo_calculo,
                exceso_pct: (x.ratio - 1) * 100, pares: x.pares, specs: x.specs
            })),
            equipos: peores.slice(0, 8).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.deno,
                texto: `${fmt(x.fila.metrics.consumo_real, 2)} vs ${fmt(x.mediana, 2)} del grupo`,
                sub: `${fmt((x.ratio - 1) * 100)}% sobre la mediana de ${x.pares.length} ${x.deno.toLowerCase()}${x.specs ? ' · ' + x.specs : ''}`
            }))
        });
    }

    // ---------- 6. Ralentí, separando lo que es desperdicio de lo que es el trabajo ----------
    const conRalenti = activos.filter(f => f.metrics.total_horas > 0 && f.metrics.horas_ralenti > 0)
        .map(f => ({ fila: f, pct: f.metrics.horas_ralenti / f.metrics.total_horas * 100, cat: categoriaRalenti(f.equipo.interno) }));

    // Los equipos marcados "aceptable" salen de la lista de desperdicio (ya se revisaron y
    // se decidió que ese ralentí es normal para ese equipo, ej. traslado de personal), pero
    // no se pierden: siguen contando en `aceptados` para que el hallazgo avise cuántos quedaron
    // afuera por esa razón, en vez de desaparecer en silencio.
    // Dentro de "desperdicio" las camionetas (CM) se separan del resto (tractores, cargadoras,
    // volcadores...): tienen excusas operativas que esas otras máquinas no tienen (esperar
    // cuadrilla, portería, apoyo de seguridad), así que mezclarlas en la misma lista hacía que
    // se revisaran/aceptaran/reclamaran una por una sin distinción de criterio.
    const desperdicioTodosCrudo = conRalenti.filter(x => x.cat === 'desperdicio').sort((a, b) => b.fila.metrics.horas_ralenti - a.fila.metrics.horas_ralenti);
    const desperdicioTodos = desperdicioTodosCrudo.filter(x => !esCamioneta(x.fila.equipo.interno));
    const camionetasTodos = desperdicioTodosCrudo.filter(x => esCamioneta(x.fila.equipo.interno));
    const desperdicio = desperdicioTodos.filter(x => !esRalentiAceptable(x.fila.equipo.interno));
    const aceptadosRalenti = desperdicioTodos.filter(x => esRalentiAceptable(x.fila.equipo.interno));
    const camionetas = camionetasTodos.filter(x => !esRalentiAceptable(x.fila.equipo.interno));
    const aceptadasCamionetas = camionetasTodos.filter(x => esRalentiAceptable(x.fila.equipo.interno));
    const espera = conRalenti.filter(x => x.cat === 'espera').sort((a, b) => b.pct - a.pct);
    const estacionarios = conRalenti.filter(x => x.cat === 'estacionario');

    const hsDesperdicio = desperdicio.reduce((s, x) => s + x.fila.metrics.horas_ralenti, 0);
    const hsCamionetas = camionetas.reduce((s, x) => s + x.fila.metrics.horas_ralenti, 0);
    const hsEstacionario = estacionarios.reduce((s, x) => s + x.fila.metrics.horas_ralenti, 0);
    // Promedio de horas de ralentí del grupo, usado por la acción "Promediar y marcar como
    // aceptable" del panel: marca en bloque a los equipos que están en la media para abajo,
    // dejando visibles (para revisión uno por uno) solo a los que se salen por arriba.
    const promedioRalenti = desperdicio.length ? hsDesperdicio / desperdicio.length : 0;
    const promedioCamionetas = camionetas.length ? hsCamionetas / camionetas.length : 0;

    if (desperdicio.length) {
        hallazgos.push({
            id: 'ralenti', severidad: hsDesperdicio > 2000 ? 'alta' : 'media', icono: 'fa-hourglass-half',
            internos_todos: desperdicio.map(x => x.fila.equipo.interno),
            titulo: `${fmt(hsDesperdicio)} horas de ralentí evitable en equipos de desplazamiento`,
            detalle: `Solo se cuentan aquí los equipos cuyo trabajo es moverse (tractores, cargadoras, volcadores...): en ellos el motor encendido sin desplazarse sí es combustible sin producción. Las camionetas se listan aparte porque suelen tener una razón operativa (esperar cuadrilla, portería) que el resto no tiene. ` +
                (hsEstacionario > 0 ? `Quedan excluidas <strong>${fmt(hsEstacionario)} hs</strong> de grupos electrógenos y equipos estacionarios, donde trabajar quieto es justamente su función. ` : '') +
                (aceptadosRalenti.length ? `<strong>${aceptadosRalenti.length}</strong> equipo${aceptadosRalenti.length === 1 ? '' : 's'} más quedaron afuera porque se marcaron como "ralentí aceptable". ` : '') +
                (espera.length ? `Los mixers y bombas se listan aparte porque parte de su espera es operativa (aguardar descarga en obra).` : ''),
            promedio_ralenti: promedioRalenti,
            // Set completo (no solo los primeros 10 que se listan) para que "Promediar y marcar
            // como aceptable" pueda marcar a TODOS los que están en la media para abajo, no
            // solo a los que se llegan a ver en pantalla.
            internos_bajo_promedio: desperdicio.filter(x => x.fila.metrics.horas_ralenti <= promedioRalenti).map(x => x.fila.equipo.interno),
            // Detalle completo (interno + denominación + horas) de esos mismos equipos, para
            // poder listarlos con checkbox en el panel aunque no estén entre los primeros 10
            // que se muestran arriba (que son justamente los peores, casi nunca los que están
            // en la media para abajo).
            bajo_promedio_detalle: desperdicio.filter(x => x.fila.metrics.horas_ralenti <= promedioRalenti).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion, horas: x.fila.metrics.horas_ralenti
            })),
            equipos: desperdicio.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.fila.metrics.horas_ralenti)} hs en ralentí`,
                sub: `${fmt(x.pct)}% de sus ${fmt(x.fila.metrics.total_horas)} hs · trabajo de desplazamiento${subSeguimiento(x.fila.equipo.interno)}`,
                valor_ralenti: x.fila.metrics.horas_ralenti
            }))
        });
    }

    if (camionetas.length) {
        hallazgos.push({
            id: 'ralenti_camionetas', severidad: hsCamionetas > 800 ? 'alta' : 'media', icono: 'fa-truck-pickup',
            internos_todos: camionetas.map(x => x.fila.equipo.interno),
            titulo: `${fmt(hsCamionetas)} horas de ralentí en camionetas`,
            detalle: `Separadas del resto de "equipos de desplazamiento" porque suelen tener una razón operativa que un tractor o una cargadora no tienen: esperar a una cuadrilla, portería/acceso, apoyo de seguridad. Eso no las exime de revisión — si el ralentí es alto y sostenido igual conviene confirmarlo — pero el criterio para aceptar en bloque o pedir revisión de GPS debería ser distinto al del resto.` +
                (aceptadasCamionetas.length ? ` <strong>${aceptadasCamionetas.length}</strong> camioneta${aceptadasCamionetas.length === 1 ? '' : 's'} más quedaron afuera porque se marcaron como "ralentí aceptable".` : ''),
            promedio_ralenti: promedioCamionetas,
            internos_bajo_promedio: camionetas.filter(x => x.fila.metrics.horas_ralenti <= promedioCamionetas).map(x => x.fila.equipo.interno),
            bajo_promedio_detalle: camionetas.filter(x => x.fila.metrics.horas_ralenti <= promedioCamionetas).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion, horas: x.fila.metrics.horas_ralenti
            })),
            equipos: camionetas.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.fila.metrics.horas_ralenti)} hs en ralentí`,
                sub: `${fmt(x.pct)}% de sus ${fmt(x.fila.metrics.total_horas)} hs · camioneta${subSeguimiento(x.fila.equipo.interno)}`,
                valor_ralenti: x.fila.metrics.horas_ralenti
            }))
        });
    }

    if (espera.length) {
        hallazgos.push({
            id: 'ralenti_espera', severidad: 'baja', icono: 'fa-truck-ramp-box',
            internos_todos: espera.map(x => x.fila.equipo.interno),
            titulo: `${espera.length} mixers y bombas con alta proporción de espera`,
            detalle: `En estos equipos parte del ralentí es operativo: esperar turno de descarga o bombeo en obra. No es desperdicio automático, pero un porcentaje muy alto y sostenido en el tiempo sí señala demoras en obra que cuestan combustible. Conviene mirar si se repite mes a mes o fue puntual de un período.`,
            equipos: espera.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.pct)}% en espera`,
                sub: `${fmt(x.fila.metrics.horas_ralenti)} de ${fmt(x.fila.metrics.total_horas)} hs · revisar contra otros meses`
            }))
        });
    }

    // ---------- 7. Sin GPS: cálculo inverso ----------
    const sinMedicion = activos.filter(f =>
        f.metrics.total_litros > 0 && f.metrics.consumo_real === 0 && f.metrics.tipo_calculo !== 'No Aplica'
    ).map(f => ({ fila: f, implicita: actividadImplicita(f) }))
     .sort((a, b) => b.fila.metrics.total_litros - a.fila.metrics.total_litros);

    // Separados en dos: los que YA tienen una estimación por cálculo inverso no son un problema
    // sin resolver (ya se muestra "≈ X hs/km" en su tarjeta) — no tiene sentido repetirles la
    // misma advertencia acá. Solo son un problema real los que ni siquiera tienen meta para estimar.
    const sinMedicionSinMeta = sinMedicion.filter(x => !x.implicita);
    const sinMedicionEstimada = sinMedicion.filter(x => x.implicita);

    if (sinMedicionSinMeta.length) {
        const litros = sinMedicionSinMeta.reduce((s, x) => s + x.fila.metrics.total_litros, 0);
        hallazgos.push({
            id: 'sin_medicion', severidad: 'media', icono: 'fa-eye-slash',
            internos_todos: sinMedicionSinMeta.map(x => x.fila.equipo.interno),
            titulo: `${sinMedicionSinMeta.length} equipos cargan combustible sin dato de actividad`,
            detalle: `Suman <strong>${fmt(litros)} L</strong>. Falta el km u hora del Resumen de Flota (normalmente porque el equipo no tiene GPS) y tampoco tienen una meta cargada para poder estimar por cálculo inverso. Cargarles una meta en "Consumos Estimados" es el primer paso para poder controlarlos.`,
            equipos: sinMedicionSinMeta.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.fila.metrics.total_litros)} L`,
                sub: (x.fila.metrics.motivo_sin_calculo || 'sin datos de actividad') + ' · sin meta para estimar'
            }))
        });
    }

    // La estimación por cálculo inverso sale de dividir litros ÷ meta. Si la meta no es creíble,
    // el resultado tampoco lo es — y se mostraba igual, con cara de dato medido. Se separan los
    // dos casos: los que sirven como control de razonabilidad, y los que directamente hay que
    // corregir antes de usarlos para nada.
    const estimadas = sinMedicionEstimada
        .map(x => ({ ...x, chequeo: estimacionCreible(x.fila, activos), comp: completitudDatos(x.fila) }))
        .sort((a, b) => b.comp.score - a.comp.score);
    const estimadasDudosas = estimadas.filter(x => x.chequeo && !x.chequeo.creible);
    const estimadasOk = estimadas.filter(x => !x.chequeo || x.chequeo.creible);

    if (estimadasDudosas.length) {
        const litros = estimadasDudosas.reduce((s, x) => s + x.fila.metrics.total_litros, 0);
        hallazgos.push({
            id: 'estimacion_inverosimil', severidad: 'media', icono: 'fa-circle-question',
            titulo: estimadasDudosas.length === 1
                ? `1 estimación por cálculo inverso no es creíble`
                : `${estimadasDudosas.length} estimaciones por cálculo inverso no son creíbles`,
            detalle: `Suman <strong>${fmt(litros)} L</strong>. Estos equipos no tienen GPS, así que su actividad se estima dividiendo los litros cargados por la meta — pero <strong>la meta que se usa no resiste el control</strong>: está muy lejos de lo que miden sus pares, o el resultado que da es imposible para la cantidad de cargas. Mientras no se corrija, el "≈ X hs" de la tarjeta es un número inventado con apariencia de dato. Están ordenados de más a menos datos: los primeros se pueden corregir hoy con confianza.`,
            equipos: estimadasDudosas.slice(0, 12).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.fila.metrics.total_litros)} L → ≈ ${fmt(x.chequeo.implicita.valor, 1)} ${x.chequeo.implicita.unidad}`,
                sub: `${x.chequeo.motivos.join(' · ')} · ${x.comp.etiqueta}`,
                completitud: x.comp.nivel,
                meta_actual: x.chequeo.meta,
                meta_sugerida: x.chequeo.sugerida ? x.chequeo.sugerida.valor : null
            }))
        });
    }

    if (estimadasOk.length) {
        const litros = estimadasOk.reduce((s, x) => s + x.fila.metrics.total_litros, 0);
        hallazgos.push({
            id: 'sin_gps_estimado', severidad: 'baja', icono: 'fa-calculator',
            titulo: `${estimadasOk.length} equipos sin GPS, con actividad estimada por cálculo inverso`,
            detalle: `Suman <strong>${fmt(litros)} L</strong>. No tienen km u hora del Resumen de Flota, pero con su meta y los litros cargados se pudo estimar cuánta actividad deberían haber tenido, y esa estimación <strong>pasa el control de razonabilidad</strong> (la meta es coherente con la de sus pares y el resultado es compatible con la cantidad de cargas). No es una falla: es lo mejor que se puede medir hasta que tengan GPS.`,
            equipos: estimadasOk.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.fila.metrics.total_litros)} L`,
                sub: `≈ ${fmt(x.implicita.valor)} ${x.implicita.unidad} implícitas  (${x.implicita.formula})`
                    + (x.implicita.referencia ? ` · ${x.implicita.referencia.respalda ? 'confirmado' : 'sin confirmar'} por jornada de referencia (${x.implicita.referencia.formula})` : '')
                    + ` · ${x.comp.etiqueta}`,
                completitud: x.comp.nivel
            }))
        });
    }

    // ---------- 7 bis. Códigos huérfanos que parecen error de tipeo ----------
    // Caso real que lo motivó: un chofer que esa semana cargó GE01, GE02 y GE03 (grupos
    // electrógenos reales de Áridos) una sola vez escribió "GR01" — un prefijo que no existe en
    // ningún lado de la flota. No es un equipo nuevo ni gasto ajeno: es una carga real, de un
    // equipo real, con el código mal tipeado. Se señala aparte (nunca se corrige solo — ver
    // sugerirPosibleTypo en normalizer.js) para que no termine ni dado de alta como equipo
    // fantasma ni aceptado como "así está bien", perdiendo de vista que esos litros son de un
    // equipo que sí existe.
    const internosDelMaestro = filas.map(f => f.equipo.interno).filter(Boolean);
    const codigosYaAceptados = new Set(noFlotaAceptados.map(a => a.codigo));
    const posiblesTypos = (totales.huerfanos || [])
        .filter(h => !codigosYaAceptados.has(h.interno))
        .map(h => ({ huerfano: h, sugerido: sugerirPosibleTypo(h.interno, internosDelMaestro) }))
        .filter(x => x.sugerido);

    if (posiblesTypos.length) {
        const litros = posiblesTypos.reduce((s, x) => s + x.huerfano.litros, 0);
        hallazgos.push({
            id: 'huerfanos_typo', severidad: 'media', icono: 'fa-spell-check',
            titulo: `${posiblesTypos.length} código${posiblesTypos.length === 1 ? '' : 's'} huérfano${posiblesTypos.length === 1 ? '' : 's'} parece${posiblesTypos.length === 1 ? '' : 'n'} error de tipeo de un equipo real`,
            detalle: `Suman <strong>${fmt(litros)} L</strong>. Cada código está a un solo carácter de un interno que sí existe en el maestro — más probable que sea la misma carga mal escrita que un equipo nuevo. No se corrige solo (adivinar cuál es el correcto no es aceptable): confirmá contra el comprobante y reasigná desde "Corregir" en Base de Datos.`,
            equipos: posiblesTypos.slice(0, 12).map(x => ({
                interno: x.huerfano.interno, denominacion: '',
                texto: `¿${x.sugerido}?`,
                sub: `${x.huerfano.cargas} carga${x.huerfano.cargas === 1 ? '' : 's'} · ${fmt(x.huerfano.litros, 1)} L${x.huerfano.dominio ? ` · dominio ${x.huerfano.dominio}` : ''}`
            }))
        });
    }

    // ---------- 8. Consumo fuera de la flota ----------
    const codigosNoFlotaAceptados = new Set(noFlotaAceptados.map(a => a.codigo));
    const grupos = clasificarNoFlota(
        (totales.huerfanos || []).filter(h => !posiblesTypos.some(x => x.huerfano === h)),
        rawRecords, codigosNoFlotaAceptados
    );
    grupos.forEach(g => {
        const notaExcluidos = g.excluidos
            ? ` <strong>${g.excluidos}</strong> código${g.excluidos === 1 ? '' : 's'} más (${fmt(g.excluidosLitros)} L) ${g.excluidos === 1 ? 'quedó afuera porque se marcó' : 'quedaron afuera porque se marcaron'} como "así está bien".`
            : '';
        hallazgos.push({
            id: 'nofl_' + g.id, severidad: 'baja',
            icono: g.id === 'vehiculo_sin_interno' ? 'fa-car-side' : (g.id === 'planta' ? 'fa-industry' : 'fa-link-slash'),
            titulo: `${g.etiqueta}: ${fmt(g.litros)} L${g.costo ? ` · $${fmt(g.costo)}` : ''}`,
            detalle: g.detalle + notaExcluidos,
            impacto_costo: g.costo,
            // La lista COMPLETA (no la recortada a 10 de `equipos`) para que "Dar de alta como
            // fuera de flota" pueda ofrecer todos los códigos del grupo, no solo los visibles.
            nofl_grupo: g.id,
            nofl_items: g.items,
            equipos: g.items.slice(0, 10).map(i => ({
                interno: i.codigo, denominacion: i.centro_costo !== '—' ? `centro de costo ${i.centro_costo}` : 'sin centro de costo',
                texto: `${fmt(i.litros)} L${i.costo ? ` · $${fmt(i.costo)}` : ''}`,
                sub: `${i.cargas} cargas${i.sector ? ` · sector ${i.sector}` : ''}`
            }))
        });
    });

    // ---------- 8a. Unidades de GPS que no cruzan con ningún equipo ----------
    // Los huérfanos se venían mirando SOLO por sus litros, y un código que aporta 0 L pero
    // miles de km y de horas quedaba invisible: no aparecía en "Consumo fuera de la flota"
    // (que agrupa por cargas) ni en ningún otro lado, mientras sus km y horas SÍ sumaban a los
    // KPI de la flota. Verificado contra los archivos reales de 2026: la unidad "PORTATIL"
    // metía 6.903 km y 3.180 hs en el total sin pertenecer a ningún equipo, y la suma de las
    // tarjetas no cerraba contra el KPI sin que nada lo dijera.
    // `panel.js` ya tenía las acciones de este hallazgo registradas (ACCIONES_PROPUESTAS
    // .huerfanos_gps) desde antes — lo que faltaba era emitirlo.
    const gpsHuerfanos = (totales.huerfanos || [])
        .filter(h => (h.gps || 0) > 0 && ((h.km || 0) > 0 || (h.horas || 0) > 0))
        .sort((a, b) => (b.km || 0) - (a.km || 0));
    if (gpsHuerfanos.length) {
        const km = gpsHuerfanos.reduce((s, h) => s + (h.km || 0), 0);
        const hs = gpsHuerfanos.reduce((s, h) => s + (h.horas || 0), 0);
        const sinCargas = gpsHuerfanos.filter(h => !(h.cargas > 0)).length;
        hallazgos.push({
            id: 'huerfanos_gps', severidad: 'media', icono: 'fa-satellite-dish',
            titulo: `${gpsHuerfanos.length} unidad${gpsHuerfanos.length === 1 ? '' : 'es'} del GPS sin equipo en el maestro (${fmt(km)} km · ${fmt(hs, 1)} hs)`,
            detalle: `Esa actividad <strong>sí suma</strong> a los km y horas totales de la flota, pero no pertenece a ninguna tarjeta: por eso el KPI de la flota da más que la suma de los equipos. ` +
                (sinCargas
                    ? (gpsHuerfanos.length === 1
                        ? `No tiene ninguna carga asociada, así que tampoco aparece en "Consumo fuera de la flota" (ese hallazgo agrupa por litros). `
                        : `${sinCargas} de ellas no tienen ninguna carga asociada, así que no aparecen en "Consumo fuera de la flota" (ese hallazgo agrupa por litros). `)
                    : '') +
                `Si es un equipo real, darlo de alta en el maestro con su interno hace que su actividad se impute donde corresponde; si es un rastreador portátil o un equipo de otra empresa, conviene sacarlo del reporte de GPS en origen.`,
            equipos: gpsHuerfanos.slice(0, 12).map(h => ({
                interno: h.interno, denominacion: h.dominio ? `dominio ${h.dominio}` : 'sin dominio',
                texto: `${fmt(h.km)} km · ${fmt(h.horas, 1)} hs`,
                sub: `${h.gps} registro${h.gps === 1 ? '' : 's'} de Resumen de Flota · ${h.cargas ? `${h.cargas} carga${h.cargas === 1 ? '' : 's'} (${fmt(h.litros, 1)} L)` : 'sin cargas registradas'}`
            }))
        });
    }

    // ---------- 8b. Prefijos nuevos de Mendoza, para dar de alta en la base oficial ----------
    // Distinto del hallazgo anterior: ese agrupa TODO lo huérfano (incluidos vehículos con
    // patente y prefijos ya conocidos como CL o MT que solo faltan en el padrón); este filtra
    // los prefijos que la app todavía no sabe nombrar en absoluto, y ofrece resolverlo una vez
    // por prefijo (no equipo por equipo) — restringido a Mendoza a propósito, ver el comentario
    // de detectarPrefijosNuevos().
    const prefijosIgnoradosSet = new Set(prefijosIgnorados);
    const prefijosNuevos = detectarPrefijosNuevos(totales.huerfanos || [], rawRecords, prefijosOficiales)
        .filter(g => g.esMendoza && !prefijosIgnoradosSet.has(g.prefijo));

    if (prefijosNuevos.length) {
        const litros = prefijosNuevos.reduce((s, g) => s + g.litros, 0);
        hallazgos.push({
            id: 'prefijos_nuevos', severidad: 'baja', icono: 'fa-shield-halved',
            titulo: `${prefijosNuevos.length} prefijo${prefijosNuevos.length === 1 ? '' : 's'} nuevo${prefijosNuevos.length === 1 ? '' : 's'} de Mendoza sin dar de alta (${fmt(litros)} L)`,
            detalle: `Aparecen en las cargas con un código que no sigue ningún prefijo conocido (ni de la flota, ni ya dado de alta antes), y sus cargas se imputan a centros de costo de Mendoza. No van a tener km ni horas — no son flota rodante — pero sí son gasto real y conviene nombrarlos en vez de dejarlos como "sin identificar". Restringido a Mendoza a propósito: un prefijo nuevo de San Juan sigue viéndose en "Consumo fuera de la flota" hasta confirmarlo con más certeza.`,
            impacto_costo: prefijosNuevos.reduce((s, g) => s + g.costo, 0),
            equipos: prefijosNuevos.slice(0, 12).map(g => ({
                interno: g.prefijo, denominacion: 'sin nombre todavía',
                texto: `${g.codigos.length} código${g.codigos.length === 1 ? '' : 's'}: ${g.codigos.slice(0, 4).join(', ')}${g.codigos.length > 4 ? '…' : ''}`,
                sub: `${fmt(g.litros)} L · $${fmt(g.costo)} · ${g.cargas} carga${g.cargas === 1 ? '' : 's'} · centro de costo ${g.centro_costo || '—'}`
            }))
        });
    }

    // ---------- 9. Cargas anómalas ----------
    const anomalas = [];
    activos.forEach(f => {
        if (f.cargas.length < 5) return;
        const litros = f.cargas.map(c => parseFloat(c.litros) || 0).filter(l => l > 0).sort((a, b) => a - b);
        if (litros.length < 5) return;
        const med = mediana(litros);
        if (med <= 0) return;
        f.cargas.forEach(c => {
            const l = parseFloat(c.litros) || 0;
            if (l > med * 3) anomalas.push({ equipo: f.equipo, carga: c, mediana: med, veces: l / med });
        });
    });
    anomalas.sort((a, b) => b.veces - a.veces);

    if (anomalas.length) {
        hallazgos.push({
            id: 'anomalas', severidad: 'baja', icono: 'fa-magnifying-glass-chart',
            titulo: `${anomalas.length} cargas individuales muy por encima de lo habitual`,
            detalle: `Superan el triple de lo que ese mismo equipo carga normalmente. Puede ser legítimo (tanque vacío, viaje largo) o un error de tipeo o de imputación.`,
            equipos: anomalas.slice(0, 10).map(a => ({
                interno: a.equipo.interno, denominacion: a.equipo.denominacion,
                texto: `${fmt(a.carga.litros, 1)} L el ${a.carga.fecha}`,
                sub: `${fmt(a.veces, 1)}× su carga habitual de ${fmt(a.mediana, 1)} L · ${a.carga.lugar_carga || 'sin lugar'}`
            }))
        });
    }

    // ---------- 10. Bajo uso: equipos con pocas cargas y sin GPS ----------
    const bajoUso = activos.filter(f =>
        f.metrics.cantidad_cargas > 0 && f.metrics.cantidad_cargas <= 3 &&
        f.metrics.cantidad_gps === 0 && f.metrics.tipo_calculo !== 'No Aplica'
    ).sort((a, b) => a.metrics.cantidad_cargas - b.metrics.cantidad_cargas);

    if (bajoUso.length) {
        hallazgos.push({
            id: 'bajo_uso', severidad: 'baja', icono: 'fa-battery-quarter',
            titulo: `${bajoUso.length} equipos con muy pocas cargas y sin dato de GPS`,
            detalle: `Tienen entre 1 y 3 cargas en el período y ningún registro de Resumen de Flota. Con tan pocos datos el consumo calculado no es representativo. Conviene verificar si el equipo estuvo efectivamente en uso o si las cargas podrían estar mal imputadas.`,
            equipos: bajoUso.slice(0, 10).map(x => ({
                interno: x.equipo.interno, denominacion: x.equipo.denominacion,
                texto: `${x.metrics.cantidad_cargas} carga${x.metrics.cantidad_cargas === 1 ? '' : 's'} · ${fmt(x.metrics.total_litros)} L`,
                sub: 'sin GPS · consumo no representativo'
            }))
        });
    }

    // ---------- 11. Ralentí inverosímil: más de 20 hs diarias promedio de ralentí ----------
    if (totales.periodo_desde && totales.periodo_hasta) {
        const ralentiExtremoTodos = activos.filter(f => {
            if (f.metrics.horas_ralenti <= 0) return false;
            const cat = categoriaRalenti(f.equipo.interno);
            // Solo alertar en equipos donde el ralentí NO es su trabajo
            if (cat === 'estacionario') return false;
            // Calcular horas de ralentí por día
            const fechasG = f.gps.map(g => g.fecha).filter(Boolean).sort();
            if (fechasG.length < 2) return false;
            const d1 = new Date(fechasG[0]), d2 = new Date(fechasG[fechasG.length - 1]);
            const dias = Math.max(1, (d2 - d1) / 86400000);
            const pctRalenti = f.metrics.horas_ralenti / f.metrics.total_horas * 100;
            return (f.metrics.horas_ralenti / dias > 18 || pctRalenti > 90);
        }).sort((a, b) => b.metrics.horas_ralenti - a.metrics.horas_ralenti);

        const ralentiExtremo = ralentiExtremoTodos.filter(f => !esRalentiAceptable(f.equipo.interno));
        const aceptadosExtremo = ralentiExtremoTodos.filter(f => esRalentiAceptable(f.equipo.interno));

        if (ralentiExtremo.length) {
            hallazgos.push({
                id: 'ralenti_inverosimil', severidad: 'media', icono: 'fa-circle-exclamation',
                internos_todos: ralentiExtremo.map(x => x.equipo.interno),
                titulo: `${ralentiExtremo.length} equipos con ralentí inverosímil`,
                detalle: `Promedian más de 18 hs diarias de ralentí o >90% del total de horas. Esto suele indicar un error en los datos del GPS, un equipo que quedó encendido por accidente, o un problema con el sensor — por eso la acción sugerida es pedir revisión del equipo GPS, no directamente cuestionar al chofer.` +
                    (aceptadosExtremo.length ? ` <strong>${aceptadosExtremo.length}</strong> más quedaron afuera porque se marcaron como "ralentí aceptable".` : ''),
                promedio_ralenti: ralentiExtremo.length ? ralentiExtremo.reduce((s, x) => s + x.metrics.horas_ralenti, 0) / ralentiExtremo.length : 0,
                internos_bajo_promedio: (() => {
                    const prom = ralentiExtremo.length ? ralentiExtremo.reduce((s, x) => s + x.metrics.horas_ralenti, 0) / ralentiExtremo.length : 0;
                    return ralentiExtremo.filter(x => x.metrics.horas_ralenti <= prom).map(x => x.equipo.interno);
                })(),
                bajo_promedio_detalle: (() => {
                    const prom = ralentiExtremo.length ? ralentiExtremo.reduce((s, x) => s + x.metrics.horas_ralenti, 0) / ralentiExtremo.length : 0;
                    return ralentiExtremo.filter(x => x.metrics.horas_ralenti <= prom).map(x => ({
                        interno: x.equipo.interno, denominacion: x.equipo.denominacion, horas: x.metrics.horas_ralenti
                    }));
                })(),
                equipos: ralentiExtremo.slice(0, 10).map(x => {
                    const pct = x.metrics.total_horas > 0 ? (x.metrics.horas_ralenti / x.metrics.total_horas * 100) : 0;
                    return {
                        interno: x.equipo.interno, denominacion: x.equipo.denominacion,
                        texto: `${fmt(x.metrics.horas_ralenti)} hs ralentí (${fmt(pct)}%)`,
                        sub: `de ${fmt(x.metrics.total_horas)} hs totales · verificar GPS${subSeguimiento(x.equipo.interno)}`,
                        valor_ralenti: x.metrics.horas_ralenti
                    };
                })
            });
        }
    }

    // ---------- 12. Cargas que superan los días hábiles disponibles ----------
    // Nadie puede cargar combustible más veces que días hábiles hubo en el mes: si pasa, no es
    // que el equipo cargue "mucho", es que algo en los datos está mal (cargas duplicadas al
    // importar, un interno reciclado entre dos unidades, un período mal recortado). Por eso se
    // marca automáticamente acá en vez de esperar a que alguien lo note tarjeta por tarjeta —
    // antes esto solo se detectaba al revés (cobertura BAJA, ver confiabilidad() más arriba);
    // la cobertura por encima del 100% quedaba invisible porque el % se recortaba a 100 en la
    // tarjeta, mostrando "cobertura ok" en vez de la alerta que en realidad es.
    // OJO con la cuenta: un equipo puede cargar dos veces en el MISMO día (doble turno, se quedó
    // sin combustible a media jornada, cargó parcial en el surtidor y completó en la estación).
    // Comparar "cantidad de cargas" contra "días hábiles" marcaba como imposible algo que pasa
    // todos los meses. Lo que de verdad no puede pasar es cargar en más DÍAS DISTINTOS que días
    // hábiles hubo — y aun así hay que descontar las cargas de sábado, domingo y feriado, que son
    // legítimas (guardias, obra con plazo). Recién lo que queda después de eso es un problema.
    const excesoCargas = [];
    activos.forEach(f => {
        const porMes = new Map();
        f.cargas.forEach(c => {
            const p = c.periodo || (c.fecha ? c.fecha.slice(0, 7) : null);
            if (!p || !c.fecha) return;
            if (!porMes.has(p)) porMes.set(p, { cargas: 0, dias: new Set(), diasNoHabiles: new Set(), cargasNoHabiles: 0, diasConVarias: new Map() });
            const m = porMes.get(p);
            m.cargas++;
            m.dias.add(c.fecha);
            m.diasConVarias.set(c.fecha, (m.diasConVarias.get(c.fecha) || 0) + 1);
            if (!esDiaHabil(c.fecha)) { m.diasNoHabiles.add(c.fecha); m.cargasNoHabiles++; }
        });
        let peor = null;
        porMes.forEach((m, periodo) => {
            const [anio, mes] = periodo.split('-').map(Number);
            if (!anio || !mes) return;
            const ultimoDia = new Date(anio, mes, 0).getDate();
            const dh = diasHabiles(`${periodo}-01`, `${periodo}-${String(ultimoDia).padStart(2, '0')}`);
            if (dh.dias <= 0) return;
            // Días hábiles en los que cargó = días distintos con carga, menos los que cayeron en
            // sábado, domingo o feriado (esos no consumen "cupo" de días hábiles).
            const diasHabilesConCarga = m.dias.size - m.diasNoHabiles.size;
            const exceso = diasHabilesConCarga - dh.dias;
            if (exceso > 0) {
                const repetidos = [...m.diasConVarias.values()].filter(n => n > 1).length;
                const cand = {
                    periodo, anio, mes, cantidad: m.cargas, dias: m.dias.size,
                    diasHabilesConCarga, diasNoHabiles: m.diasNoHabiles.size,
                    cargasNoHabiles: m.cargasNoHabiles, diasRepetidos: repetidos,
                    diasHabiles: dh.dias, exceso
                };
                if (!peor || exceso > peor.exceso) peor = cand;
            }
        });
        if (peor) excesoCargas.push({ fila: f, ...peor });
    });
    excesoCargas.sort((a, b) => b.exceso - a.exceso);

    if (excesoCargas.length) {
        hallazgos.push({
            id: 'cargas_exceden_dias_habiles', severidad: 'alta', icono: 'fa-triangle-exclamation',
            titulo: `${excesoCargas.length} equipo${excesoCargas.length === 1 ? '' : 's'} cargó combustible en más días hábiles de los que tuvo el mes`,
            detalle: `Se cuentan <strong>días distintos con carga</strong>, no cantidad de cargas: cargar dos veces el mismo día es normal (doble turno, carga parcial y después completa) y antes se marcaba como error. También se descuentan las cargas de sábado, domingo y feriado, que son legítimas. Lo que queda es lo que no puede pasar: el equipo figura cargando en más días hábiles de los que el mes tuvo. Ahí sí hay algo mal en el dato — el mismo interno usado por dos unidades, cargas de otro equipo imputadas acá, o un archivo del mes subido dos veces.`,
            equipos: excesoCargas.slice(0, 12).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${x.diasHabilesConCarga} días hábiles con carga en ${MESES[x.mes - 1]} ${x.anio}`,
                sub: `el mes tuvo ${x.diasHabiles} días hábiles · ${x.exceso} día${x.exceso === 1 ? '' : 's'} de más · ${x.cantidad} cargas en total${x.diasRepetidos ? `, ${x.diasRepetidos} día${x.diasRepetidos === 1 ? '' : 's'} con más de una` : ''}${x.diasNoHabiles ? ` · ${x.cargasNoHabiles} en fin de semana o feriado (no cuentan)` : ''}`,
                anio: x.anio, mes: x.mes
            }))
        });
    }

    // ---------- 13. Sede inconsistente: lugar de carga ≠ provincia del padrón ----------
    const sedeInconsistente = activos.filter(f => {
        const prov = f.ubicacion?.provincia;
        if (!prov || prov === 'SIN DATO') return false;
        const lc = f.ubicacion?.lugarCargaBreakdown || [];
        if (!lc.length) return false;
        // Si la provincia del padrón es Mendoza pero hay cargas en lugares que suenan a otra provincia
        // Para ahora, detectar si el centro de costo principal no coincide con otros equipos del mismo centro
        // Simplificación: si el equipo tiene cargas en un lugar que no contiene la provincia
        return false; // placeholder: la lógica real requiere un mapa de lugares → provincias
    });

    // ---------- 14. Datos parciales: pocos meses reales dentro del período ----------
    // Un equipo que aparece en todas las planillas pero solo tiene actividad en uno o dos meses
    // no está "trabajando poco": lo más probable es que haya dejado de reportar acá (pasó a la
    // otra provincia, salió de servicio, le sacaron el GPS). Tratarlo como si trabajara cero el
    // resto del período le baja el consumo real, le rompe la cobertura y lo mete todos los meses
    // en hallazgos que no le corresponden. Hay que decidirlo una vez, no discutirlo cada mes.
    // Base más amplia que `activos`: acá también importa el equipo que reporta GPS pero nunca
    // carga combustible (o al revés). Justamente ese desbalance es parte del síntoma.
    const conAlgunDato = filas.filter(f => f.metrics.cantidad_cargas > 0 || f.metrics.cantidad_gps > 0);
    const desc = totales.registros_descartados;
    const parciales = conAlgunDato
        .map(f => ({ fila: f, cob: coberturaMensual(f, periodo), comp: completitudDatos(f) }))
        .filter(x => x.cob.parcial)
        .sort((a, b) => a.cob.conDatos - b.cob.conDatos || b.fila.metrics.total_litros - a.fila.metrics.total_litros);

    if (parciales.length) {
        hallazgos.push({
            id: 'datos_parciales', severidad: 'media', icono: 'fa-calendar-day',
            titulo: `${parciales.length} equipo${parciales.length === 1 ? '' : 's'} con datos de solo una parte del período`,
            detalle: `Aparecen en las planillas de todos los meses, pero solo tienen actividad real en uno o dos. ${desc && desc.total ? `Se descartaron <strong>${fmt(desc.total)} registros en cero</strong> (${fmt(desc.gps)} del GPS y ${fmt(desc.cargas)} de cargas) repartidos en ${fmt(desc.internos.length)} equipos` : 'Las filas en cero'} — <strong>no se cuentan como "trabajó cero"</strong> sino como "ese mes no hay dato", así que no estiran el período ni bajan los promedios. Lo que queda por decidir es si el equipo dejó de reportar acá (pasó a San Juan, salió de servicio, le sacaron el GPS) o si realmente trabajó solo esos meses. Mientras no se decida, van a seguir apareciendo en hallazgos que no les corresponden.`,
            equipos: parciales.slice(0, 15).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${x.cob.conDatos} de ${x.cob.mesesPeriodo} meses con datos`,
                sub: `con actividad en ${x.cob.listaMeses.join(', ')} · ${x.comp.etiqueta}${x.fila.equipo.provincia ? ` · padrón: ${x.fila.equipo.provincia}` : ''}`,
                completitud: x.comp.nivel,
                meses_con_datos: x.cob.conDatos,
                meses_periodo: x.cob.mesesPeriodo
            }))
        });
    }


    // ---------- 15. Calidad del dato de las cargas ----------
    // Esto no mira equipos: mira la planilla. Son los errores que dejan a todo el resto del
    // análisis apoyado en datos incompletos, y que no se ven revisando tarjeta por tarjeta.
    const cal = auditarCalidadCargas(rawRecords);

    if (cal.mesesSinGps.length) {
        const litros = cal.mesesSinGps.reduce((s, m) => s + m.litros, 0);
        const costo = cal.mesesSinGps.reduce((s, m) => s + m.costo, 0);
        const nCargas = cal.mesesSinGps.reduce((s, m) => s + m.cargas, 0);
        const pct = cal.totalCargas ? Math.round((nCargas / cal.totalCargas) * 100) : 0;
        hallazgos.push({
            id: 'meses_sin_gps', severidad: 'baja', icono: 'fa-calendar-days',
            no_comparar: true,
            titulo: `Período analizado: ${cal.mesesGps.length} mes${cal.mesesGps.length === 1 ? '' : 'es'} en común entre Cargas y GPS`,
            detalle: `El análisis de consumo se hace sobre los meses que tienen datos en <strong>ambas fuentes</strong> (Cargas y Resumen de Flota). Es así por diseño: dividir litros de un período por actividad de otro daría un número sin sentido. Los ${cal.mesesSinGps.length} mes${cal.mesesSinGps.length === 1 ? '' : 'es'} sin Resumen de Flota tienen <strong>${fmt(nCargas)} cargas (${fmt(litros)} L, $${fmt(costo)})</strong> que se muestran en la tabla de cargas pero quedan fuera del período analizado — el desglose del KPI de litros lo detalla. Meses con GPS: ${cal.mesesGps.join(', ') || '—'}.`,
            impacto_costo: 0,
            equipos: cal.mesesSinGps.map(m => ({
                interno: m.periodo, denominacion: `${m.equipos} equipos con cargas`,
                texto: `${fmt(m.cargas)} cargas · ${fmt(m.litros)} L`,
                sub: `$${fmt(m.costo)} · sin Resumen de Flota → fuera del período analizado`
            }))
        });
    }

    if (cal.sinValor.length) {
        const litros = cal.sinValor.reduce((s, c) => s + (parseFloat(c.litros) || 0), 0);
        const meses = [...new Set(cal.sinValor.map(c => c.periodo || String(c.fecha || '').slice(0, 7)).filter(Boolean))].sort();
        // ¿Todas las cargas sin precio comparten la misma forma de escribir el combustible, y
        // esa forma es la minoritaria? Entonces la causa no es "se olvidaron el precio": es que
        // el nombre no matchea contra la tabla de precios del sistema de origen y devuelve cero.
        const formasSinValor = [...new Set(cal.sinValor.map(c => c.combustible).filter(Boolean))];
        let causaRaiz = null;
        if (formasSinValor.length === 1) {
            const forma = formasSinValor[0];
            const v = cal.variantes.find(x => x.formas.some(([f]) => f === forma));
            if (v) {
                const mayoritaria = v.formas[0][0];
                if (mayoritaria !== forma) causaRaiz = { forma, mayoritaria };
            }
        }
        hallazgos.push({
            id: 'cargas_sin_valorizar', severidad: 'alta', icono: 'fa-dollar-sign',
            no_comparar: true,
            titulo: `${cal.sinValor.length} cargas sin valorizar: ${fmt(litros)} L cargados con precio o costo en cero`,
            detalle: `El combustible salió del surtidor pero la planilla lo registra con <strong>precio unitario o costo total en cero</strong>. No es que hayan sido gratis: falta el dato. Todo lo que la app muestra en pesos — el gasto del período, el costo del sobreconsumo, el ahorro — está subestimado en esa cantidad hasta que se completen. ${meses.length ? `Se concentran en ${meses.join(', ')}.` : ''}` +
                (causaRaiz
                    ? ` <strong>Y ya sabemos por qué:</strong> las ${cal.sinValor.length} están escritas <strong>"${esc(causaRaiz.forma)}"</strong> mientras que el resto de la flota usa <strong>"${esc(causaRaiz.mayoritaria)}"</strong>. El nombre no coincide con la tabla de precios del sistema que emite la planilla, así que el precio vuelve en cero. No es un olvido: es una diferencia de escritura. Corregir el nombre en el origen completa los precios solo.`
                    : '') +
                (() => {
                    const fl = cal.sinValor.map(c => c.fila_excel).filter(Boolean);
                    if (!fl.length) return '';
                    const muestra = fl.slice(0, 15).join(', ');
                    return ` <strong>En tu planilla están en las filas ${muestra}${fl.length > 15 ? ` y ${fl.length - 15} más` : ''}.</strong> No son contiguas: para encontrarlas en Excel conviene filtrar la columna de precio por 0, o la del combustible por esa escritura.`;
                })(),
            causa_raiz: causaRaiz,
            filas_excel: cal.sinValor.map(c => c.fila_excel).filter(Boolean),
            equipos: cal.sinValor.slice(0, 12).map(c => ({
                interno: c.interno || c.dominio || '—', denominacion: c.combustible || '',
                texto: `${fmt(parseFloat(c.litros) || 0, 1)} L sin valorizar`,
                sub: `${c.fila_excel ? `fila ${c.fila_excel} de la planilla · ` : ''}${c.fecha || 'sin fecha'}${c.lugar_carga ? ` · ${c.lugar_carga}` : ''}${c.chofer ? ` · ${c.chofer}` : ''}`
            }))
        });
    }

    if (cal.variantes.length || cal.variantesCampos.length || cal.duplicados.length) {
        const partes = [];
        if (cal.variantes.length) partes.push(`${cal.variantes.length} combustible${cal.variantes.length === 1 ? '' : 's'} escrito${cal.variantes.length === 1 ? '' : 's'} de más de una forma`);
        if (cal.variantesCampos.length) partes.push(`${cal.variantesCampos.length} valor${cal.variantesCampos.length === 1 ? '' : 'es'} de texto con variantes (${[...new Set(cal.variantesCampos.map(v => v.etiqueta))].join(', ')})`);
        if (cal.duplicadosExactos.length) partes.push(`${cal.duplicadosExactos.length} carga${cal.duplicadosExactos.length === 1 ? '' : 's'} duplicada${cal.duplicadosExactos.length === 1 ? '' : 's'} exacta${cal.duplicadosExactos.length === 1 ? '' : 's'}`);
        if (cal.duplicadosPosibles.length) partes.push(`${cal.duplicadosPosibles.length} posible${cal.duplicadosPosibles.length === 1 ? '' : 's'} repetida${cal.duplicadosPosibles.length === 1 ? '' : 's'} a revisar`);
        const ejemplos = cal.variantes.map(v =>
            `<strong>${v.formas.map(([f, n]) => `"${esc(f)}" (${n})`).join(' y ')}</strong>`).join('; ');
        hallazgos.push({
            id: 'calidad_planilla', severidad: 'media', icono: 'fa-spell-check',
            no_comparar: true,
            titulo: `Inconsistencias en la planilla de cargas: ${partes.join(' y ')}`,
            detalle: (cal.variantes.length
                ? `El mismo producto escrito de dos maneras se cuenta como dos productos distintos y rompe cualquier total por tipo de combustible: ${ejemplos}. `
                : '') +
                (cal.variantesCampos.length
                    ? `El mismo valor de ${[...new Set(cal.variantesCampos.map(v => v.etiqueta))].join(', ')} aparece escrito de más de una forma (espacio, guion, mayúscula de más). No se unifica solo — es una decisión, no una corrección automática — pero desde <strong>"Unificar variantes"</strong> se revisa cada grupo y se elige a mano bajo qué forma quedan todas las cargas. `
                    : '') +
                (cal.duplicadosExactos.length
                    ? `Hay ${cal.duplicadosExactos.length} fila${cal.duplicadosExactos.length === 1 ? '' : 's'} <strong>idéntica${cal.duplicadosExactos.length === 1 ? '' : 's'} a otra en todo</strong>: mismo equipo, fecha, litros, importe, precio, combustible, lugar, centro de costo y chofer. Dos cargas reales del mismo equipo el mismo día no coinciden hasta el centavo — es la misma fila entrada dos veces, y se puede corregir sola con <strong>"Corregir duplicados exactos"</strong>: queda una y se descarta la copia (reversible, y se re-aplica sola si reimportás el archivo). Son ${fmt(cal.duplicadosExactos.reduce((s, d) => s + (parseFloat(d.repetida.litros) || 0), 0), 1)} L y $${fmt(cal.duplicadosExactos.reduce((s, d) => s + (parseFloat(d.repetida.importe) || 0), 0))} contados de más. `
                    : '') +
                (cal.duplicadosPosibles.length
                    ? `Otras ${cal.duplicadosPosibles.length} coinciden en equipo, fecha y litros pero difieren en algún otro campo (${[...new Set(cal.duplicadosPosibles.flatMap(d => d.difieren))].join(', ')}). <strong>Esas no se tocan solas</strong>: pueden ser dos cargas legítimas del mismo día en surtidores distintos. Se listan abajo con el campo que difiere, para decidir contra el comprobante.`
                    : ''),
            equipos: [
                ...cal.variantes.map(v => ({
                    interno: v.formas[0][0], denominacion: 'tipo de combustible',
                    texto: `${v.formas.length} formas de escribirlo`,
                    sub: v.formas.map(([f, n]) => `"${f}": ${n} cargas`).join(' · ')
                })),
                ...cal.variantesCampos.slice(0, 10).map(v => ({
                    interno: v.formas[0][0], denominacion: v.etiqueta,
                    texto: `${v.formas.length} formas de escribirlo`,
                    sub: v.formas.map(([f, n]) => `"${f}": ${n} cargas`).join(' · ')
                })),
                ...cal.duplicadosExactos.slice(0, 6).map(d => ({
                    interno: d.repetida.interno || d.repetida.dominio || '—', denominacion: 'duplicado EXACTO',
                    texto: `${fmt(parseFloat(d.repetida.litros) || 0, 1)} L el ${d.repetida.fecha || '—'}`,
                    sub: `idéntica en todos los campos${d.repetida.importe ? ` · $${fmt(parseFloat(d.repetida.importe) || 0)} cada una` : ''} — se corrige sola`
                })),
                ...cal.duplicadosPosibles.slice(0, 6).map(d => ({
                    interno: d.repetida.interno || d.repetida.dominio || '—', denominacion: 'posible repetida',
                    texto: `${fmt(parseFloat(d.repetida.litros) || 0, 1)} L el ${d.repetida.fecha || '—'}`,
                    sub: `difiere en ${d.difieren.join(', ')} — hay que decidir a mano`
                }))
            ]
        });
    }


    if (cal.preciosInconsistentes.length) {
        const totalCargasAfectadas = cal.preciosInconsistentes.reduce((s, p) => s + p.cargas.length, 0);
        const impacto = cal.preciosInconsistentes.reduce((s, p) => {
            const litros = p.cargas.reduce((s2, c) => s2 + (parseFloat(c.litros) || 0), 0);
            return s + litros * Math.abs(p.precio_real - p.precio_esperado);
        }, 0);
        hallazgos.push({
            id: 'precios_inconsistentes', severidad: 'alta', icono: 'fa-tag',
            no_comparar: true, impacto_costo: impacto,
            titulo: `${totalCargasAfectadas} carga${totalCargasAfectadas === 1 ? '' : 's'} con un precio distinto al resto del mismo combustible`,
            detalle: `Cada combustible tiene un único precio por litro en el resto de la planilla — no cambia por lugar de carga ni por mes. Estas cargas rompen esa regla: mismo combustible, precio distinto. Puede ser una fila mal tipeada, o el arranque real de un aumento de precio — hay que confirmarlo contra el comprobante antes de tocar nada, así que <strong>no se corrige solo</strong>. Impacto si el precio esperado fuera el correcto: $${fmt(impacto)}.`,
            equipos: cal.preciosInconsistentes.slice(0, 10).flatMap(p =>
                p.cargas.slice(0, 3).map(c => ({
                    interno: c.interno || c.dominio || '—', denominacion: p.combustible,
                    texto: `$${fmt(p.precio_real, 2)}/L vs. $${fmt(p.precio_esperado, 2)}/L en las otras ${p.referencia_n}`,
                    sub: `${c.fecha || 'sin fecha'}${c.lugar_carga ? ` · ${c.lugar_carga}` : ''}${c.fila_excel ? ` · fila ${c.fila_excel}` : ''} · ${fmt(parseFloat(c.litros) || 0, 1)} L`
                }))
            )
        });
    }


    // ---------- 15 bis. Entregas de Loop con remito en conflicto ----------
    // No es un problema de la flota, es de la planilla: el mismo N° de remito aparece más de una
    // vez con datos que NO coinciden (otro equipo, otro volumen, otra fecha) entre "Informe
    // Entregas" y "Exportado informe de Viajes" — o entre las propias hojas de Informe Entregas.
    // Se guardaron las dos filas (ver insertEntregasLoop() en database.js) en vez de quedarse
    // con una a ciegas: acá se juntan para poder decidir a mano contra el comprobante.
    const remitosConflicto = new Map();
    rawRecords.forEach(r => {
        if (r.type === 'entrega' && r._conflicto_remito) {
            if (!remitosConflicto.has(r.remito)) remitosConflicto.set(r.remito, []);
            remitosConflicto.get(r.remito).push(r);
        }
    });
    if (remitosConflicto.size) {
        const grupos = [...remitosConflicto.values()];
        hallazgos.push({
            id: 'entregas_conflicto_remito', severidad: 'media', icono: 'fa-triangle-exclamation',
            no_comparar: true,
            titulo: `${grupos.length} remito${grupos.length === 1 ? '' : 's'} de Loop con datos que no coinciden entre sí`,
            detalle: `El mismo N° de remito aparece más de una vez entre "Informe Entregas" y "Exportado informe de Viajes" (o entre las hojas de Informe Entregas) con <strong>datos distintos</strong>: otro equipo, otro volumen o otra fecha. No se descartó ninguna fila — las dos quedaron guardadas en "Entregas (Loop)", marcadas en rojo, para decidir a mano contra el comprobante.`,
            equipos: grupos.slice(0, 12).map(g => ({
                interno: g[0].interno || g[0].dominio || '—', denominacion: `remito ${g[0].remito}`,
                texto: `${g.length} versiones`,
                sub: g.map(r => `${r.formato === 'detalle' ? (r.hoja || 'Entregas') : 'Viajes'}: ${r.volumen > 0 ? fmt(r.volumen, 1) + ' m³' : 'sin volumen'}${r.fecha ? ' · ' + r.fecha : ''}${r.interno && r.interno !== g[0].interno ? ' · equipo ' + r.interno : ''}`).join(' vs. ')
            }))
        });
    }

    // ---------- 16. Gasto de los equipos dados de alta como NO FLOTA ----------
    // No es un problema: es la contracara de haberlos normalizado. Antes estos litros vivían en
    // "códigos sin padrón" (un hallazgo de severidad media que nunca se cerraba); una vez dados
    // de alta salen de ahí, y este bloque confirma que el gasto no se perdió — dice cuánto es y
    // a qué centro de costo se imputa, que es exactamente para lo que se los da de alta.
    const noFlotaConCargas = noFlotaAlta.filter(f => f.metrics.cantidad_cargas > 0);
    if (noFlotaConCargas.length) {
        const litros = noFlotaConCargas.reduce((s, f) => s + f.metrics.total_litros, 0);
        const costo = noFlotaConCargas.reduce((s, f) => s + f.metrics.total_costo, 0);
        const porCC = {};
        noFlotaConCargas.forEach(f => {
            const cc = f.equipo.centro_costo || '(sin centro de costo)';
            porCC[cc] = (porCC[cc] || 0) + f.metrics.total_costo;
        });
        const sinCC = noFlotaConCargas.filter(f => !f.equipo.centro_costo).length;
        const resumenCC = Object.entries(porCC).sort((a, b) => b[1] - a[1])
            .map(([cc, v]) => `${esc(cc)}: $${fmt(v)}`).join(' · ');
        hallazgos.push({
            id: 'no_flota_alta', severidad: sinCC ? 'baja' : 'ok', icono: 'fa-boxes-stacked',
            no_comparar: true,
            titulo: `${noFlotaConCargas.length} equipo${noFlotaConCargas.length === 1 ? '' : 's'} fuera de flota dado${noFlotaConCargas.length === 1 ? '' : 's'} de alta: ${fmt(litros)} L · $${fmt(costo)} imputados`,
            detalle: `Préstamos, alquileres, herramientas y servicios de planta que se dieron de alta en el maestro para que su gasto quede imputado. <strong>No son flota</strong>: no se les calcula consumo ni se los compara contra pares — a propósito. Reparto por centro de costo: ${resumenCC}.` +
                (sinCC ? ` <strong>${sinCC} de ellos todavía no tienen centro de costo</strong>: ese gasto no se le imputa a nadie. Completalo desde el maestro.` : ''),
            impacto_costo: costo,
            equipos: noFlotaConCargas.sort((a, b) => b.metrics.total_costo - a.metrics.total_costo).slice(0, 12).map(f => ({
                interno: f.equipo.interno,
                denominacion: f.equipo.denominacion || CLASES_NO_FLOTA[f.equipo.clase_no_flota] || 'fuera de flota',
                texto: `${fmt(f.metrics.total_litros)} L · $${fmt(f.metrics.total_costo)}`,
                sub: `${f.equipo.centro_costo ? `centro de costo ${f.equipo.centro_costo}` : '⚠ sin centro de costo'} · ${f.metrics.cantidad_cargas} carga${f.metrics.cantidad_cargas === 1 ? '' : 's'}` +
                    (f.equipo.vigencia_desde || f.equipo.vigencia_hasta ? ` · vigencia ${f.equipo.vigencia_desde || '—'} a ${f.equipo.vigencia_hasta || '—'}` : '')
            }))
        });
    }

    // ---------- 18. Lo que YA se normalizó solo ----------
    // El diagnóstico es una lista de problemas, y eso da una impresión sesgada: parece que los
    // datos están peor de lo que están, porque todo lo que la app arregla sola es invisible.
    // Este bloque lo hace visible, con el conteo real sobre estos archivos y diciendo de dónde
    // sale cada dato. Solo se listan normalizaciones que efectivamente se APLICAN (no las que
    // apenas se detectan): esas siguen apareciendo como hallazgo pendiente, que es lo correcto.
    const normalizaciones = [];
    const cargasN = rawRecords.filter(r => r.type === 'carga');
    const gpsN = rawRecords.filter(r => r.type === 'gps');

    const conAmbos = rawRecords.filter(r => r.interno && r.dominio).length;
    if (conAmbos) normalizaciones.push({
        titulo: 'Interno y dominio separados de una sola celda',
        detalle: `${fmt(conAmbos)} registros venían con el interno y la patente juntos en la columna "INTERNO-DOMINIO". Se parten y se guardan por separado, clasificando cada parte por su forma (patente vieja tipo JNU923, Mercosur tipo AF809IC, o interno tipo TR20).`,
        fuente: 'extraerIdentidad() · normalizer.js'
    });

    // Un registro cuenta como "normalizado para el cruce" cuando lo que se muestra difiere de la
    // clave con la que efectivamente se cruza: espacio, guion o cero a la izquierda de por medio.
    const conCeroIzq = rawRecords.filter(r => r.interno && r.interno_key && String(r.interno).toUpperCase() !== r.interno_key).length;
    if (conCeroIzq) normalizaciones.push({
        titulo: 'Espacios, guiones y ceros a la izquierda unificados para el cruce',
        detalle: `${fmt(conCeroIzq)} registros cruzan igual aunque estén escritos distinto: "CL03", "CL 03", "CL-3" y "CL3" son el mismo equipo. La clave de cruce se genera sin espacios, sin guiones, sin guiones bajos y sin ceros a la izquierda — el código original se sigue mostrando tal como vino.`,
        fuente: 'normalizeEquipoKey() · normalizer.js'
    });

    normalizaciones.push({
        titulo: 'Todo el texto a mayúsculas y sin acentos',
        detalle: 'Combustible, chofer, sector, centro de costo, lugar de carga, marca y modelo se guardan normalizados, así "Godoy Cruz" y "GODOY CRUZ" no cuentan como dos lugares distintos. Ojo: esto NO unifica formas realmente distintas como "YPF 500" y "YPF500" — esas se detectan y se ofrecen en "Unificar variantes", porque juntarlas es una decisión, no una corrección automática.',
        fuente: 'normalizeString() · normalizer.js'
    });

    if (gpsN.length) normalizaciones.push({
        titulo: 'Horas de GPS convertidas a decimal para poder calcular',
        detalle: `Excel guarda las horas como fracción de día (0,5 = 12 horas). Los ${fmt(gpsN.length)} registros de GPS se convierten a horas decimales y se suman ralentí + movimiento + parado, redondeando a 2 decimales. Los formatos de texto "HH:MM:SS" y "HH:MM" también se soportan.`,
        fuente: 'parseExcelHours() / parseDuration() · normalizer.js'
    });

    const conFecha = rawRecords.filter(r => r.fecha).length;
    if (conFecha) normalizaciones.push({
        titulo: 'Fechas unificadas a un solo formato',
        detalle: `${fmt(conFecha)} registros con fecha: se acepta el número serial de Excel, "DD/MM/AAAA", el año de dos dígitos ("05/03/26") y el encabezado del GPS con coma ("1/1/2026, 0:00"). Todo se guarda en un formato único para poder ordenar y comparar, y se muestra siempre como DD/MM/AAAA.`,
        fuente: 'parseDate() · normalizer.js'
    });

    normalizaciones.push({
        titulo: 'Números con separador de miles y coma decimal',
        detalle: 'Litros, importes y precios se leen bien vengan como "1.234,56", "$ 1.500" o "9.5". El punto se interpreta según la forma del número: separador de miles cuando corresponde, decimal cuando no.',
        fuente: 'parseNumber() · normalizer.js'
    });

    const descNorm = totales.registros_descartados || {};
    if (descNorm.duplicados) normalizaciones.push({
        titulo: `${fmt(descNorm.duplicados)} registro${descNorm.duplicados === 1 ? '' : 's'} duplicado${descNorm.duplicados === 1 ? '' : 's'} exacto${descNorm.duplicados === 1 ? '' : 's'} descartado${descNorm.duplicados === 1 ? '' : 's'} al importar`,
        detalle: `${descNorm.duplicados_cargas ? `<strong>${fmt(descNorm.duplicados_cargas)} carga${descNorm.duplicados_cargas === 1 ? '' : 's'}</strong> idéntica${descNorm.duplicados_cargas === 1 ? '' : 's'} a otra en todo (equipo, fecha, litros, importe, precio, combustible, lugar, centro de costo y chofer)` : ''}${descNorm.duplicados_cargas && descNorm.duplicados_gps ? ' y ' : ''}${descNorm.duplicados_gps ? `<strong>${fmt(descNorm.duplicados_gps)} registro${descNorm.duplicados_gps === 1 ? '' : 's'} de GPS</strong> con el mismo equipo, el mismo período y exactamente los mismos km y horas` : ''}: es el mismo dato entrado dos veces, o el mismo archivo subido de nuevo. Se apartan solos al importar — antes de que lleguen a los totales${descNorm.duplicados_litros > 0 ? `, así que no inflan litros ni costo (${fmt(descNorm.duplicados_litros, 1)} L y $${fmt(descNorm.duplicados_costo)} que se habrían contado de más)` : ''}. Siguen visibles en Base de Datos. Esto es lo que permite volver a subir un archivo, o ir sumando los meses nuevos sin limpiar, sin duplicar nada.`,
        fuente: 'claveCargaExacta() / claveGpsExacta() · normalizer.js + insertRawRecords() · database.js'
    });

    const totalDesc = (descNorm.cargas || 0) + (descNorm.gps || 0);
    if (totalDesc) normalizaciones.push({
        titulo: `${fmt(totalDesc)} registros en cero apartados del cálculo`,
        detalle: `Filas de GPS con 0 km y 0 horas, o cargas con 0 litros y 0 importe. No significan "consumió cero": significan que ese mes no hay dato. Contarlos estiraría el período hacia meses vacíos y diluiría todos los promedios. Se apartan del análisis pero se siguen viendo en Base de Datos, porque ahí lo que importa es el registro tal como llegó.`,
        fuente: 'registroVacio() · analyzer.js'
    });

    normalizaciones.push({
        titulo: 'Denominación corregida desde el prefijo del interno',
        detalle: 'La columna TIPO de la planilla de equipos no es confiable (los tractores figuran como "CAMION"). La denominación se deduce del prefijo del interno: TR = tractor, CM = camioneta, MX = mixer, y así. Es lo que permite comparar equipos contra sus verdaderos pares.',
        fuente: 'getDenominacion() · normalizer.js'
    });

    normalizaciones.push({
        titulo: 'Correcciones a mano que sobreviven a la reimportación',
        detalle: 'Cada corrección se guarda con una huella estable de la carga (fecha + litros + importe + interno original). Si volvés a subir el mismo archivo, la corrección se re-aplica sola. Lo mismo con los campos del maestro editados a mano: una reimportación no los pisa.',
        fuente: 'huellaCarga() + upsertEquipos() · database.js'
    });

    if (normalizaciones.length) {
        hallazgos.push({
            id: 'normalizaciones', severidad: 'ok', icono: 'fa-wand-magic-sparkles',
            no_comparar: true,
            titulo: `${normalizaciones.length} normalizaciones aplicadas automáticamente al importar`,
            detalle: 'Esto <strong>ya está resuelto</strong>: son las correcciones que la app hace sola cada vez que procesa las planillas, con el conteo real sobre estos archivos y la función que lo hace. Se listan acá porque el resto del diagnóstico solo muestra problemas, y eso hace parecer que los datos están peor de lo que están. ' +
                'Los <strong>duplicados exactos</strong> (idénticos en todos los campos) se corrigen con un botón desde el hallazgo de calidad de planilla, y esa corrección se re-aplica sola al reimportar. ' +
                'Lo que se <strong>detecta pero no se corrige solo</strong> — posibles repetidas que difieren en algún campo, variantes de escritura, cargas sin valorizar — sigue apareciendo como hallazgo pendiente más arriba: ahí sí hay una decisión que tomar contra el comprobante, y no es algo que la app deba resolver por su cuenta.',
            equipos: normalizaciones.map(n => ({
                interno: '✓', denominacion: n.fuente,
                texto: n.titulo, sub: n.detalle
            }))
        });
    }

    const orden = { alta: 0, media: 1, baja: 2, ok: 3 };
    hallazgos.sort((a, b) => (orden[a.severidad] - orden[b.severidad]) || (Math.abs(b.impacto_costo || 0) - Math.abs(a.impacto_costo || 0)));

    return hallazgos;
}
