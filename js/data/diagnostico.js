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

import { getPrefijo, clasificarIdentificador, MESES } from './normalizer.js';
import { diasHabiles, esDiaHabil } from './feriados.js';

const TOLERANCIA = 0.15;
const META_ALTA = 2.5;
const META_BAJA = 0.4;
const MIN_CARGAS_CONFIABLE = 3;
const COBERTURA_MINIMA_PCT = 40; // % de días hábiles del período con al menos una carga

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

const mediana = (arr) => {
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
export function confiabilidad(fila, periodo = null) {
    const m = fila.metrics;
    const avisos = [];
    if (m.cantidad_cargas > 0 && m.cantidad_cargas < MIN_CARGAS_CONFIABLE) avisos.push(`solo ${m.cantidad_cargas} carga${m.cantidad_cargas === 1 ? '' : 's'}`);
    if (m.cantidad_gps === 1) avisos.push('un solo período de GPS');
    if (m.total_horas > 0 && m.total_horas < 20) avisos.push(`solo ${fmt(m.total_horas, 1)} hs registradas`);
    if (m.total_km > 0 && m.total_km < 200 && m.tipo_calculo === 'L/100Km') avisos.push(`solo ${fmt(m.total_km)} km`);

    let cobertura = null;
    if (periodo && periodo.desde && periodo.hasta && Array.isArray(fila.cargas) && fila.cargas.length) {
        const diasConCarga = new Set(fila.cargas.map(c => c.fecha).filter(Boolean)).size;
        const dh = diasHabiles(periodo.desde, periodo.hasta);
        if (dh.dias > 0) {
            const pct = Math.round((diasConCarga / dh.dias) * 100);
            cobertura = { diasConCarga, diasHabiles: dh.dias, pct };
            if (pct < COBERTURA_MINIMA_PCT) avisos.push(`cargó ${diasConCarga} de ${dh.dias} días hábiles del período (${pct}%)`);
        }
    }

    return { confiable: avisos.length === 0, avisos, cobertura };
}

/**
 * Cobertura de cargas de un equipo contra los días hábiles de su propio período activo (unión
 * de fechas de cargas + GPS). La usan tanto la franja "cobertura" de la tarjeta del panel como
 * la vista de Seguimiento, para que las dos lean siempre el mismo número — antes cada una lo
 * calculaba por su cuenta y corrían el riesgo de desalinearse. A propósito NO se recorta a 100:
 * pasarse de 100% (más cargas que días hábiles) es justamente el caso que hay que poder detectar.
 */
export function coberturaEquipo(fila) {
    const fechasC = (fila.cargas || []).map(c => c.fecha).filter(Boolean);
    const fechasG = (fila.gps || []).map(g => g.fecha).filter(Boolean);
    const todas = [...fechasC, ...fechasG].sort();
    if (todas.length < 2) return null;
    const dh = diasHabiles(todas[0], todas[todas.length - 1]);
    if (!dh || dh.totalCorridos <= 0 || dh.dias <= 0) return null;
    const cantidad = fila.metrics.cantidad_cargas;
    const pct = Math.round((cantidad / dh.dias) * 100);
    return { cargas: cantidad, diasHabiles: dh.dias, totalCorridos: dh.totalCorridos, completo: dh.completo, pct, exceso: pct > 100 };
}

export function calcularExceso(fila) {
    const { metrics: m, confirmed } = fila;
    if (!confirmed || !confirmed.valor || confirmed.valor <= 0) return null;
    if (!m.consumo_real || m.consumo_real <= 0) return null;

    let litrosEsperados;
    if (m.tipo_calculo === 'L/100Km') {
        if (m.total_km <= 0) return null;
        litrosEsperados = (confirmed.valor * m.total_km) / 100;
    } else if (m.tipo_calculo === 'L/Hora') {
        if (m.total_horas <= 0) return null;
        litrosEsperados = confirmed.valor * m.total_horas;
    } else return null;

    const excesoLitros = m.total_litros - litrosEsperados;
    const precioLitro = m.total_litros > 0 ? m.total_costo / m.total_litros : 0;
    return { litros_esperados: litrosEsperados, exceso_litros: excesoLitros, exceso_costo: excesoLitros * precioLitro, precio_litro: precioLitro };
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
 * Cálculo inverso: para equipos que cargan combustible pero no tienen GPS, la meta permite
 * estimar cuánta actividad DEBERÍAN haber tenido. No reemplaza al GPS, pero convierte un
 * "no se puede calcular" en un número con el que sí se puede trabajar.
 */
export function actividadImplicita(fila) {
    const m = fila.metrics;
    const c = fila.confirmed;
    if (!c || !c.valor || c.valor <= 0 || m.total_litros <= 0) return null;
    if (m.tipo_calculo === 'L/Hora') {
        return { valor: m.total_litros / c.valor, unidad: 'horas', formula: `${fmt(m.total_litros, 1)} L ÷ ${fmt(c.valor, 2)} L/hora` };
    }
    if (m.tipo_calculo === 'L/100Km') {
        return { valor: (m.total_litros / c.valor) * 100, unidad: 'km', formula: `${fmt(m.total_litros, 1)} L ÷ ${fmt(c.valor, 2)} L/100km × 100` };
    }
    return null;
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
        vehiculo_sin_interno: { id: 'vehiculo_sin_interno', etiqueta: 'Vehículos con patente pero sin interno en el padrón', detalle: 'Tienen dominio válido: son unidades reales que faltan dar de alta en el maestro.', items: [], litros: 0, costo: 0 },
        planta: { id: 'planta', etiqueta: 'Servicios y mantenimiento de planta', detalle: 'Calderas, caloventores, limpieza y consumos fijos de planta. No son flota rodante: no se les puede calcular L/100km ni L/hora, pero son gasto y conviene seguirlos por centro de costo.', items: [], litros: 0, costo: 0 },
        otros: { id: 'otros', etiqueta: 'Otros consumos sin identificar', detalle: 'Códigos que no siguen la nomenclatura ni son patentes. Conviene normalizarlos en la planilla de cargas.', items: [], litros: 0, costo: 0 }
    };

    const PALABRAS_PLANTA = /CALDERA|CALOVENTOR|LIMPIEZA|JARDIN|PLANTA|TALLER|SURTIDOR|CANALETA|BOMBEO|HERRAMIENT/;

    huerfanos.forEach(h => {
        const cargas = cargasPorClave.get(h.interno_key || h.interno) || cargasPorClave.get(h.interno) || [];
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

        g.items.push({ codigo: h.interno, litros: h.litros, costo, cargas: h.cargas, centro_costo: topCentro, sector: topSector });
        g.litros += h.litros;
        g.costo += costo;
    });

    Object.values(grupos).forEach(g => g.items.sort((a, b) => b.litros - a.litros));
    return Object.values(grupos).filter(g => g.items.length);
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

    if (sug && sug.valor > 0) {
        factorPares = meta / sug.valor;
        if (factorPares >= 3) motivos.push(`la meta cargada (${fmt(meta, 2)}) es ${fmt(factorPares, 1)}× la mediana de sus pares medidos (${fmt(sug.valor, 2)})`);
        else if (factorPares <= 1 / 3) motivos.push(`la meta cargada (${fmt(meta, 2)}) es la ${fmt(1 / factorPares, 1)}ª parte de la mediana de sus pares medidos (${fmt(sug.valor, 2)})`);
    }
    // Actividad implícita absurda para la cantidad de cargas: si hubiera trabajado tan poco,
    // no habría hecho falta ir al surtidor tantas veces.
    const cargas = fila.metrics.cantidad_cargas || 0;
    if (cargas > 0) {
        if (imp.unidad === 'horas' && imp.valor < cargas * 2) motivos.push(`daría ${fmt(imp.valor, 1)} horas para ${cargas} carga${cargas === 1 ? '' : 's'}: menos de 2 horas de trabajo por carga`);
        if (imp.unidad === 'km' && imp.valor < cargas * 20) motivos.push(`daría ${fmt(imp.valor)} km para ${cargas} carga${cargas === 1 ? '' : 's'}: menos de 20 km por carga`);
    }

    return { implicita: imp, meta, creible: motivos.length === 0, motivos, sugerida: sug, factorPares, completitud: comp };
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

    // 4. Filas repetidas: mismo equipo, misma fecha y los mismos litros.
    const vistos = new Map();
    const duplicados = [];
    cargas.forEach(c => {
        const k = `${c.interno_key || c.interno}|${c.fecha}|${Math.round((parseFloat(c.litros) || 0) * 10)}`;
        if (vistos.has(k)) duplicados.push({ original: vistos.get(k), repetida: c });
        else vistos.set(k, c);
    });

    return { mesesSinGps, sinValor, variantes, duplicados, totalCargas: cargas.length, mesesGps: [...mesesGps].sort() };
}

// ============================================================ HALLAZGOS

export function generarDiagnostico(filas = [], totales = {}, rawRecords = [], ralentiEstados = [], noFlotaAceptados = [], equiposExcluidos = []) {
    const hallazgos = [];
    // Equipos apartados a mano (ej. pasaron a San Juan y dejaron de reportar acá): siguen en el
    // maestro y en las tablas, pero no generan hallazgos ni ensucian promedios ni medianas.
    const excluidosMap = new Map(equiposExcluidos.map(e => [e.interno, e]));
    filas = filas.filter(f => !excluidosMap.has(f.equipo.interno));

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
        hallazgos.push({
            id: 'sobreconsumo', severidad: 'alta', icono: 'fa-fire',
            titulo: `${excedidos.length} equipos consumieron ${fmt(litros)} L por encima de su meta`,
            detalle: `Equivale a <strong>$${fmt(costo)}</strong> en el período. Se comparan los litros realmente cargados contra los que corresponderían a la meta según la actividad (km u horas) del GPS.` +
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
        hallazgos.push({
            id: 'ahorro', severidad: 'ok', icono: 'fa-leaf',
            titulo: `${eficientes.length} equipos consumieron menos que su meta`,
            detalle: `Un ahorro equivalente a <strong>$${fmt(ahorro)}</strong>. Si el desvío es grande, revisá que la meta no esté sobredimensionada o que no falten cargas por registrar.`,
            impacto_costo: -ahorro,
            equipos: eficientes.slice(0, 8).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.exceso.exceso_litros)} L · $${fmt(x.exceso.exceso_costo)}`,
                sub: `real ${fmt(x.fila.metrics.consumo_real, 2)} vs meta ${fmt(x.fila.confirmed.valor, 2)} ${x.fila.metrics.tipo_calculo}`
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
        const potencia = eq.potencia || '';
        // Si tiene marca y modelo, agrupar por deno+marca+modelo (más justo)
        if (marca && modelo) return `${deno}|${marca}|${modelo}`;
        if (marca) return `${deno}|${marca}`;
        return deno;
    }
    function etiquetaGrupo(key) {
        const [deno, marca, modelo] = key.split('|');
        if (modelo) return `${deno} ${marca} ${modelo}`;
        if (marca) return `${deno} ${marca}`;
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
                sub: `≈ ${fmt(x.implicita.valor)} ${x.implicita.unidad} implícitas  (${x.implicita.formula}) · ${x.comp.etiqueta}`,
                completitud: x.comp.nivel
            }))
        });
    }

    // ---------- 8. Consumo fuera de la flota ----------
    const codigosNoFlotaAceptados = new Set(noFlotaAceptados.map(a => a.codigo));
    const grupos = clasificarNoFlota(totales.huerfanos || [], rawRecords, codigosNoFlotaAceptados);
    grupos.forEach(g => {
        const notaExcluidos = g.excluidos
            ? ` <strong>${g.excluidos}</strong> código${g.excluidos === 1 ? '' : 's'} más (${fmt(g.excluidosLitros)} L) ${g.excluidos === 1 ? 'quedó afuera porque se marcó' : 'quedaron afuera porque se marcaron'} como "así está bien".`
            : '';
        hallazgos.push({
            id: 'nofl_' + g.id, severidad: g.id === 'vehiculo_sin_interno' ? 'media' : 'baja',
            icono: g.id === 'vehiculo_sin_interno' ? 'fa-car-side' : (g.id === 'planta' ? 'fa-industry' : 'fa-link-slash'),
            titulo: `${g.etiqueta}: ${fmt(g.litros)} L${g.costo ? ` · $${fmt(g.costo)}` : ''}`,
            detalle: g.detalle + notaExcluidos,
            impacto_costo: g.costo,
            equipos: g.items.slice(0, 10).map(i => ({
                interno: i.codigo, denominacion: i.centro_costo !== '—' ? `centro de costo ${i.centro_costo}` : 'sin centro de costo',
                texto: `${fmt(i.litros)} L${i.costo ? ` · $${fmt(i.costo)}` : ''}`,
                sub: `${i.cargas} cargas${i.sector ? ` · sector ${i.sector}` : ''}`
            }))
        });
    });

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
            id: 'meses_sin_gps', severidad: 'alta', icono: 'fa-calendar-xmark',
            no_comparar: true,
            titulo: `Faltan los Resumen de Flota de ${cal.mesesSinGps.length} mes${cal.mesesSinGps.length === 1 ? '' : 'es'} que sí tienen cargas`,
            detalle: `Hay <strong>${fmt(nCargas)} cargas</strong> (${pct}% del total, ${fmt(litros)} L, $${fmt(costo)}) en meses de los que <strong>no se subió el archivo de GPS</strong>. Para esos meses no hay km ni horas, así que no se puede calcular consumo de nada: los equipos aparecen como "sin dato de actividad", con "períodos desalineados" y con la cobertura baja, sin que ninguno de ellos tenga un problema real. Subir esos Resumen de Flota es lo que más limpia el diagnóstico de una sola vez. Meses con GPS cargado: ${cal.mesesGps.join(', ') || '—'}.`,
            impacto_costo: costo,
            equipos: cal.mesesSinGps.map(m => ({
                interno: m.periodo, denominacion: `${m.equipos} equipos afectados`,
                texto: `${fmt(m.cargas)} cargas · ${fmt(m.litros)} L`,
                sub: `$${fmt(m.costo)} sin poder controlar · falta el Resumen de Flota de ese mes`
            }))
        });
    }

    if (cal.sinValor.length) {
        const litros = cal.sinValor.reduce((s, c) => s + (parseFloat(c.litros) || 0), 0);
        const meses = [...new Set(cal.sinValor.map(c => c.periodo || String(c.fecha || '').slice(0, 7)).filter(Boolean))].sort();
        hallazgos.push({
            id: 'cargas_sin_valorizar', severidad: 'alta', icono: 'fa-dollar-sign',
            no_comparar: true,
            titulo: `${cal.sinValor.length} cargas sin valorizar: ${fmt(litros)} L cargados con precio o costo en cero`,
            detalle: `El combustible salió del surtidor pero la planilla lo registra con <strong>precio unitario o costo total en cero</strong>. No es que hayan sido gratis: falta el dato. Todo lo que la app muestra en pesos — el gasto del período, el costo del sobreconsumo, el ahorro — está subestimado en esa cantidad hasta que se completen. ${meses.length ? `Se concentran en ${meses.join(', ')}.` : ''}`,
            equipos: cal.sinValor.slice(0, 12).map(c => ({
                interno: c.interno || c.dominio || '—', denominacion: c.combustible || '',
                texto: `${fmt(parseFloat(c.litros) || 0, 1)} L sin valorizar`,
                sub: `${c.fecha || 'sin fecha'}${c.lugar_carga ? ` · ${c.lugar_carga}` : ''}${c.chofer ? ` · ${c.chofer}` : ''}`
            }))
        });
    }

    if (cal.variantes.length || cal.duplicados.length) {
        const partes = [];
        if (cal.variantes.length) partes.push(`${cal.variantes.length} combustible${cal.variantes.length === 1 ? '' : 's'} escrito${cal.variantes.length === 1 ? '' : 's'} de más de una forma`);
        if (cal.duplicados.length) partes.push(`${cal.duplicados.length} carga${cal.duplicados.length === 1 ? '' : 's'} repetida${cal.duplicados.length === 1 ? '' : 's'}`);
        const ejemplos = cal.variantes.map(v =>
            `<strong>${v.formas.map(([f, n]) => `"${f}" (${n})`).join(' y ')}</strong>`).join('; ');
        hallazgos.push({
            id: 'calidad_planilla', severidad: 'media', icono: 'fa-spell-check',
            no_comparar: true,
            titulo: `Inconsistencias en la planilla de cargas: ${partes.join(' y ')}`,
            detalle: (cal.variantes.length
                ? `El mismo producto escrito de dos maneras se cuenta como dos productos distintos y rompe cualquier total por tipo de combustible: ${ejemplos}. Se arregla unificando la escritura en la planilla de origen. `
                : '') +
                (cal.duplicados.length
                    ? `Además hay ${cal.duplicados.length} fila${cal.duplicados.length === 1 ? '' : 's'} con el mismo equipo, la misma fecha y los mismos litros que otra: casi siempre es la misma carga cargada dos veces. Confirmá contra el comprobante antes de borrar.`
                    : ''),
            equipos: [
                ...cal.variantes.map(v => ({
                    interno: v.formas[0][0], denominacion: 'tipo de combustible',
                    texto: `${v.formas.length} formas de escribirlo`,
                    sub: v.formas.map(([f, n]) => `"${f}": ${n} cargas`).join(' · ')
                })),
                ...cal.duplicados.slice(0, 8).map(d => ({
                    interno: d.repetida.interno || d.repetida.dominio || '—', denominacion: 'carga repetida',
                    texto: `${fmt(parseFloat(d.repetida.litros) || 0, 1)} L el ${d.repetida.fecha || '—'}`,
                    sub: `aparece dos veces con los mismos litros${d.repetida.importe ? ` · $${fmt(parseFloat(d.repetida.importe) || 0)} cada una` : ''}`
                }))
            ]
        });
    }

    const orden = { alta: 0, media: 1, baja: 2, ok: 3 };
    hallazgos.sort((a, b) => (orden[a.severidad] - orden[b.severidad]) || (Math.abs(b.impacto_costo || 0) - Math.abs(a.impacto_costo || 0)));

    return hallazgos;
}
