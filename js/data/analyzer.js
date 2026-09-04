/**
 * Lógica de Negocio, Análisis y TRAZABILIDAD DE CÁLCULOS.
 *
 * Dos principios:
 *
 * 1. INTERNO + DOMINIO como doble clave. Hay planillas que identifican al equipo solo por
 *    interno y otras solo por patente. El maestro se indexa por ambas, así un registro cruza
 *    con cualquiera de las dos y dejan de perderse consumos.
 *
 * 2. Todo número que la app muestra puede explicar de dónde salió. Cada métrica viaja junto
 *    con sus `pasos`: la secuencia de operaciones, con los valores intermedios y los archivos
 *    de origen. La UI los muestra al hacer click, así ningún total es una caja negra.
 */

import { normalizeEquipoKey, getPrefijo, getDenominacion, partesFecha, getProvincia, getNombreCentroCosto, tipoLugarCarga, getBandera } from './normalizer.js';

export const RULE_L_100KM = ['TR', 'CM', 'CH', 'FG', 'AU'];
// CA (CALDERA) y LM (LIMPIEZA) se suman acá a propósito: consumen por tiempo de uso, no por
// distancia, igual que GE (GRUPO ELECTRÓGENO) — que tampoco tiene GPS y ya funciona por cálculo
// inverso (litros ÷ meta). Antes quedaban sin ninguna regla de unidad, así que un código nuevo
// con ese prefijo no se podía dar de alta automáticamente (ver PREFIJOS_CALCULABLES en
// autocorreccion.js): no era que les faltara GPS, era que la app no sabía en qué unidad medirlos.
export const RULE_L_HORA = ['MX', 'CF', 'EX', 'TP', 'GE', 'BM', 'VL', 'AE', 'RE', 'MC', 'MT', 'MH', 'CL', 'MS', 'CA', 'LM'];
export const RULE_NO_TANK = ['BA', 'CR', 'SR', 'TO'];

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Construye un paso de cálculo trazable. */
const paso = (texto, calculo, resultado, nota) => ({ texto, calculo, resultado, nota });

// ============================================================ MAESTRO

/**
 * Indexa el maestro por interno Y por dominio. Devuelve un Map donde ambas claves apuntan
 * al mismo equipo, de modo que un registro que solo trae la patente igual encuentra su ficha.
 */
export function indexarMaestro(equipos = []) {
    const idx = new Map();
    equipos.forEach(eq => {
        const ik = eq.interno_key || normalizeEquipoKey(eq.interno);
        const dk = eq.dominio_key || normalizeEquipoKey(eq.dominio);
        if (ik) idx.set(ik, eq);
        if (dk && !idx.has(dk)) idx.set(dk, eq);
    });
    return idx;
}

/** Resuelve a qué equipo del maestro pertenece un registro, probando interno y luego dominio. */
export function resolverEquipo(registro, idx) {
    const ik = registro.interno_key || normalizeEquipoKey(registro.interno);
    const dk = registro.dominio_key || normalizeEquipoKey(registro.dominio);
    return (ik && idx.get(ik)) || (dk && idx.get(dk)) || null;
}

/** Meta de consumo del equipo (ya vive en el maestro, no en una tabla aparte). */
export function getConfirmedConsumption(equipoOInterno, estimadosData = []) {
    if (equipoOInterno && typeof equipoOInterno === 'object') {
        const eq = equipoOInterno;
        if (eq.meta_valor > 0) {
            return { value: eq.meta_texto || `${eq.meta_valor} ${eq.meta_unidad || ''}`.trim(), valor: eq.meta_valor, unidad: eq.meta_unidad || null, source: 'Maestro' };
        }
        return null;
    }
    // Compatibilidad con la firma vieja (interno + array de estimados)
    const key = normalizeEquipoKey(equipoOInterno);
    const e = estimadosData.find(x => normalizeEquipoKey(x.interno) === key);
    if (!e) return null;
    return { value: e.consumo_estimado, valor: e.consumo_estimado_valor || 0, unidad: e.consumo_estimado_unidad || null, source: 'Consumos Estimados' };
}

// ============================================================ PERÍODOS

/**
 * Un registro "en cero": el GPS reportó la fila del mes pero sin nada adentro (0 km, 0 hs de
 * ralentí, movimiento, parado y total), o una carga sin litros ni importe. No significa que el
 * equipo haya trabajado cero: significa que ese mes NO HAY DATO. Contarlos como si fueran datos
 * estira el período hacia meses vacíos, diluye los promedios y hace que un equipo con un solo
 * mes real parezca tener seis. Se descartan del análisis; en la tabla de Base de Datos siguen
 * estando, porque ahí lo que se muestra es el registro histórico tal cual llegó.
 */
export function registroVacio(r) {
    if (!r) return false;
    if (r.type === 'gps') {
        const km = parseFloat(r.distancia) || 0;
        const h = (r.horas && typeof r.horas === 'object')
            ? (r.horas.total || 0) + (r.horas.ralenti || 0) + (r.horas.movimiento || 0) + (r.horas.parado || 0)
            : (parseFloat(r.horas) || 0);
        return km === 0 && h === 0;
    }
    if (r.type === 'carga') {
        return (parseFloat(r.litros) || 0) === 0 && (parseFloat(r.importe) || 0) === 0;
    }
    return false;
}

/**
 * Registros que no entran al análisis: los vacíos (arriba) y las copias exactas de una carga
 * ya importada, que se marcan al insertarlas (ver insertRawRecords() en database.js). Contar
 * dos veces la misma carga infla litros, costo y consumo sin que se note en ningún lado.
 * Siguen guardadas y visibles en Base de Datos: se apartan del cálculo, no se borran.
 */
export function registroExcluido(r) {
    return registroVacio(r) || !!(r && r._dupe_exacta);
}

export function calculateAlignedPeriod(cargas = [], gps = []) {
    let minC = null, maxC = null, minG = null, maxG = null;
    cargas.forEach(c => {
        if (!c.fecha) return;
        if (!minC || c.fecha < minC) minC = c.fecha;
        if (!maxC || c.fecha > maxC) maxC = c.fecha;
    });
    gps.forEach(g => {
        if (!g.fecha) return;
        const h = g.fecha_hasta || g.fecha;
        if (!minG || g.fecha < minG) minG = g.fecha;
        if (!maxG || h > maxG) maxG = h;
    });
    let start = minC && minG ? (minC > minG ? minC : minG) : (minC || minG);
    let end = maxC && maxG ? (maxC < maxG ? maxC : maxG) : (maxC || maxG);
    if (start && end && start > end) {
        start = minC && minG ? (minC < minG ? minC : minG) : (minC || minG);
        end = maxC && maxG ? (maxC > maxG ? maxC : maxG) : (maxC || maxG);
    }
    return { start, end };
}

/**
 * Filtra registros por año / mes / rango explícito / lista de períodos YYYY-MM.
 * Un registro de GPS abarca un período (fecha..fecha_hasta), así que se considera incluido
 * si ese período se superpone con el filtro, no solo si empieza dentro.
 *
 * `filtro.periodos` (array de "YYYY-MM") tiene prioridad sobre anio/mes cuando está presente:
 * permite seleccionar meses específicos para cruzar cargas y GPS del mismo período.
 */
export function filtrarPorPeriodo(records = [], filtro = {}) {
    const { anio, mes, desde, hasta, periodos } = filtro;

    // Filtro por períodos YYYY-MM seleccionados (prioridad sobre anio/mes sueltos)
    if (periodos && periodos.length) {
        const set = new Set(periodos);
        return records.filter(r => {
            const meses = mesesDeRegistro(r);
            if (!meses.length) return false;
            // Un reporte que abarca VARIOS meses (ej. "Resumen de Flota Ene-Jul") entra solo
            // si están seleccionados TODOS sus meses. Antes entraba con que coincidiera uno
            // solo: al filtrar por enero se colaban los siete meses de horas y km del archivo
            // consolidado contra un mes de cargas, y el consumo salía por el piso sin que
            // nada lo avisara. No se puede repartir a prorrata — el reporte no dice cuánto
            // corresponde a cada mes — así que o entra entero o no entra.
            return meses.every(m => set.has(m));
        });
    }

    if (!anio && !mes && !desde && !hasta) return records;

    return records.filter(r => {
        if (anio && r.anio !== Number(anio)) return false;
        if (mes && r.mes !== Number(mes)) return false;
        if (desde || hasta) {
            const ini = r.fecha || '';
            const fin = r.fecha_hasta || r.fecha || '';
            if (!ini) return false;
            if (desde && fin < desde) return false;
            if (hasta && ini > hasta) return false;
        }
        return true;
    });
}

/** Años y meses presentes en los datos, para poblar los selectores de filtro. */
export function periodosDisponibles(records = []) {
    const anios = new Set();
    const meses = new Set();
    const yms = new Set();
    records.forEach(r => {
        if (r.anio) anios.add(r.anio);
        if (r.mes) meses.add(r.mes);
        // Todos los meses que CUBRE el registro, no solo el de su fecha de inicio: un
        // "Resumen de Flota Ene-Jul" aporta datos a los siete meses, y si el selector solo
        // ofreciera enero no habría forma de elegir el rango completo que ese archivo mide.
        mesesDeRegistro(r).forEach(m => yms.add(m));
        if (r.periodo) yms.add(r.periodo);
    });
    return {
        anios: [...anios].sort((a, b) => b - a),
        meses: [...meses].sort((a, b) => a - b),
        periodos: [...yms].sort()
    };
}

// ============================================================ MÉTRICAS

export function determineConsumptionType(equipo, cargas = [], confirmed = null) {
    if (!equipo) return 'Sin clasificar';
    if (equipo.tipo_calculo_manual) return equipo.tipo_calculo_manual;
    if (confirmed && confirmed.unidad) return confirmed.unidad;

    const prefix = getPrefijo(equipo.interno);
    if (RULE_NO_TANK.includes(prefix)) return 'No Aplica';
    if (RULE_L_100KM.includes(prefix)) return 'L/100Km';
    if (RULE_L_HORA.includes(prefix)) return 'L/Hora';
    return 'Sin clasificar';
}

export function sumHoras(gpsList = []) {
    let t = 0;
    gpsList.forEach(g => { t += (g.horas && typeof g.horas === 'object') ? (g.horas.total || 0) : (parseFloat(g.horas) || 0); });
    return t;
}

export function desgloseHoras(gpsList = []) {
    const o = { ralenti: 0, movimiento: 0, parado: 0, total: 0 };
    gpsList.forEach(g => {
        if (g.horas && typeof g.horas === 'object') {
            o.ralenti += g.horas.ralenti || 0;
            o.movimiento += g.horas.movimiento || 0;
            o.parado += g.horas.parado || 0;
            o.total += g.horas.total || 0;
        } else {
            const n = parseFloat(g.horas) || 0;
            o.movimiento += n; o.total += n;
        }
    });
    return o;
}

/** Mes (YYYY-MM) de un movimiento puntual (una carga). */
function mesDe(r) {
    const m = r.periodo || String(r.fecha || '').slice(0, 7);
    return /^\d{4}-\d{2}$/.test(m) ? m : null;
}

/**
 * Meses (YYYY-MM) que CUBRE un registro. Una carga cubre uno solo; un reporte de GPS cubre
 * todo su rango: los archivos mensuales cubren un mes, pero un "Resumen de Flota Ene-Jul"
 * cubre siete y no se puede tratar como si fuera de enero.
 */
export function mesesDeRegistro(r) {
    const ini = mesDe(r);
    if (!ini) return [];
    const finRaw = String(r.fecha_hasta || r.fecha || '').slice(0, 7);
    const fin = /^\d{4}-\d{2}$/.test(finRaw) && finRaw > ini ? finRaw : ini;
    const out = [];
    let [y, m] = ini.split('-').map(Number);
    for (let i = 0; i < 120; i++) {
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        out.push(ym);
        if (ym >= fin) break;
        m++; if (m > 12) { m = 1; y++; }
    }
    return out;
}

/**
 * Alinea las cargas y el GPS de UN equipo a los meses en que hay dato de LAS DOS fuentes.
 *
 * Sin esto, un equipo con cargas de enero a marzo pero GPS solo de febrero y marzo calcula
 * su consumo dividiendo los litros de tres meses por los km de dos: el número sale inflado
 * y no es comparable contra su meta ni contra otros equipos. La cuenta correcta usa el
 * mismo período de los dos lados — que es justo lo que el badge "períodos desalineados"
 * venía avisando sin que el cálculo lo tuviera en cuenta.
 *
 * Los litros y el costo TOTALES del período no se tocan (son gasto real y se siguen
 * mostrando completos): lo que se alinea es la base del RATIO litros/actividad.
 *
 * Un reporte de GPS que abarca meses sin cargas queda afuera en vez de repartirse a
 * prorrata: repartirlo sería inventar km que nadie midió.
 */
export function alinearCargasYGps(cargasList = [], gpsList = []) {
    const mesesCargas = new Set();
    cargasList.forEach(c => { const m = mesDe(c); if (m) mesesCargas.add(m); });

    const mesesGps = new Set();
    gpsList.forEach(g => mesesDeRegistro(g).forEach(m => mesesGps.add(m)));

    const comunes = new Set([...mesesCargas].filter(m => mesesGps.has(m)));

    const cargas = cargasList.filter(c => { const m = mesDe(c); return m && comunes.has(m); });
    // Solo el GPS que cae ENTERO dentro de los meses comunes: uno que además cubre meses sin
    // cargas traería km de un período que no se está midiendo.
    const gps = gpsList.filter(g => {
        const ms = mesesDeRegistro(g);
        return ms.length > 0 && ms.every(m => comunes.has(m));
    });

    const gpsParcial = gpsList.filter(g => {
        const ms = mesesDeRegistro(g);
        return ms.some(m => comunes.has(m)) && !ms.every(m => comunes.has(m));
    }).length;

    return {
        cargas, gps,
        meses: [...comunes].sort(),
        mesesCargas: [...mesesCargas].sort(),
        mesesGps: [...mesesGps].sort(),
        // Alineado = las dos fuentes cubren exactamente los mismos meses.
        alineado: comunes.size > 0 && comunes.size === mesesCargas.size && comunes.size === mesesGps.size,
        sinMesComun: comunes.size === 0 && mesesCargas.size > 0 && mesesGps.size > 0,
        cargasFuera: cargasList.length - cargas.length,
        gpsFuera: gpsList.length - gps.length,
        gpsParcial
    };
}

/**
 * Jornada operativa de referencia, en horas por día hábil, según lo que informa la operación
 * (no sale de los datos: es el dato de negocio contra el cual se contrasta lo que miden).
 *
 * Sirve para separar dos cosas que se confunden todo el tiempo cuando un equipo consume menos
 * de lo esperado: puede ser que esté rindiendo bien, o puede ser que casi no haya trabajado.
 * Un mixer que hace 3 hs por día hábil cuando debería hacer 10-12 no es eficiente, está
 * parado — y su consumo bajo no es un logro ni su meta es alcanzable.
 *
 * Se define por denominación y, cuando corresponde, por sector/centro de costo.
 */
export const JORNADA_REFERENCIA = {
    // Áridos: los equipos de la ripiera trabajan jornada completa cuando la planta produce.
    por_sector: {
        ARIDOS: { min: 10, max: 12, nota: 'jornada de planta de áridos' }
    },
    por_denominacion: {
        MIXER: { min: 10, max: 12, nota: 'promedio informado por operaciones' },
        'SEMI MIXER': { min: 10, max: 12, nota: 'promedio informado por operaciones' }
    }
};

/**
 * Jornada esperada para un equipo: primero por sector (el centro de costo manda, porque la
 * jornada la fija la operación del lugar), después por denominación.
 */
/**
 * Equipos que NO siguen una jornada laboral: un grupo electrógeno puede quedar encendido de
 * corrido (incluido fin de semana), un caloventor o una productora de hielo trabajan por
 * demanda. Medirlos en "horas por día hábil" da números imposibles (39 hs/día) porque el
 * numerador cuenta días corridos y el denominador solo los hábiles. Para estos equipos la
 * comparación contra una jornada de referencia no significa nada y no se hace.
 */
const SIN_JORNADA = ['GRUPO ELECTRÓGENO', 'GRUPO ELECTROGENO', 'CALOVENTOR', 'PRODUCTORA DE HIELO', 'MOTOCOMPRESOR', 'BOMBA'];

export function jornadaEsperada(equipo, ubicacion = null) {
    const denoRaw = String(equipo?.denominacion || '').toUpperCase();
    if (SIN_JORNADA.some(d => denoRaw.includes(d))) return null;
    const sector = String((ubicacion && (ubicacion.centroCosto || ubicacion.lugarCarga)) || equipo?.centro_costo || '')
        .toUpperCase().replace(/[ÁÀÄÂ]/g, 'A').replace(/[ÉÈËÊ]/g, 'E').replace(/[ÍÌÏÎ]/g, 'I').replace(/[ÓÒÖÔ]/g, 'O').replace(/[ÚÙÜÛ]/g, 'U');
    for (const [clave, ref] of Object.entries(JORNADA_REFERENCIA.por_sector)) {
        if (sector.includes(clave)) return { ...ref, base: `sector ${clave}` };
    }
    const deno = String(equipo?.denominacion || '').toUpperCase();
    const ref = JORNADA_REFERENCIA.por_denominacion[deno];
    if (ref) return { ...ref, base: deno.toLowerCase() };
    return null;
}

/**
 * Métricas de un equipo, con los pasos del cálculo incluidos.
 */
export function calculateMetrics(equipo, cargasList = [], gpsList = [], confirmed = null) {
    const calcType = determineConsumptionType(equipo, cargasList, confirmed);

    let totalLitros = 0, totalCosto = 0;
    cargasList.forEach(c => { totalLitros += parseFloat(c.litros) || 0; totalCosto += parseFloat(c.importe) || 0; });

    let totalKm = 0;
    gpsList.forEach(g => { totalKm += parseFloat(g.distancia) || 0; });

    const horas = desgloseHoras(gpsList);
    const totalHoras = horas.total;

    // Base ALINEADA del ratio: mismos meses de los dos lados (ver alinearCargasYGps).
    const alin = alinearCargasYGps(cargasList, gpsList);
    let litrosAlin = 0;
    alin.cargas.forEach(c => { litrosAlin += parseFloat(c.litros) || 0; });
    let kmAlin = 0;
    alin.gps.forEach(g => { kmAlin += parseFloat(g.distancia) || 0; });
    const horasAlinDesglose = desgloseHoras(alin.gps);
    const horasAlin = horasAlinDesglose.total;

    let consumoReal = 0;
    let motivoSinCalculo = null;
    const pasos = [];

    // --- Paso 1: origen del tipo de cálculo ---
    let fuenteTipo = 'regla por prefijo del interno';
    if (equipo && equipo.tipo_calculo_manual) fuenteTipo = 'definido a mano en la tarjeta';
    else if (confirmed && confirmed.unidad) fuenteTipo = `unidad de la meta ("${confirmed.value}")`;
    pasos.push(paso(
        'Determinar cómo se mide este equipo',
        fuenteTipo,
        calcType,
        'La unidad declarada en Consumos Estimados manda; si no hay meta, se usa el prefijo del interno.'
    ));

    // --- Paso 2: litros ---
    pasos.push(paso(
        'Sumar los litros cargados en el período',
        `${cargasList.length} ${cargasList.length === 1 ? 'carga' : 'cargas'} registradas`,
        `${nf(totalLitros, 1)} L`
    ));

    // --- Paso 2 bis: alinear los períodos antes de dividir ---
    // Solo aparece cuando hace falta: si las dos fuentes cubren los mismos meses, no hay nada
    // que explicar y el cálculo es el de siempre.
    const necesitaGps = calcType === 'L/100Km' || calcType === 'L/Hora';
    if (necesitaGps && !alin.alineado && alin.mesesCargas.length && alin.mesesGps.length) {
        pasos.push(paso(
            'Alinear los períodos de Cargas y GPS',
            `cargas: ${alin.mesesCargas.join(', ')} · GPS: ${alin.mesesGps.join(', ')}`,
            alin.meses.length ? `se usan ${alin.meses.join(', ')}` : 'no hay ningún mes en común',
            alin.meses.length
                ? `El consumo se calcula solo sobre los meses que tienen las dos fuentes: ${nf(litrosAlin, 1)} L de los ${nf(totalLitros, 1)} L del período. Dividir todos los litros por la actividad de menos meses daría un consumo inflado.`
                : 'Las cargas y el GPS no comparten ningún mes, así que no hay contra qué medir los litros.'
        ));
    }

    if (calcType === 'No Aplica') {
        motivoSinCalculo = 'Equipo remolcado, sin motor propio';
    } else if (calcType === 'Sin clasificar') {
        motivoSinCalculo = 'Falta definir si se mide por hora o por km';
    } else if (totalLitros <= 0) {
        motivoSinCalculo = 'Sin cargas de combustible en el período';
    } else if (alin.sinMesComun) {
        motivoSinCalculo = 'Las cargas y el GPS no comparten ningún mes: no se pueden comparar';
    } else if (calcType === 'L/100Km') {
        pasos.push(paso('Sumar los kilómetros del GPS', `${alin.gps.length} ${alin.gps.length === 1 ? 'registro' : 'registros'} de Resumen de Flota`, `${nf(kmAlin)} km`));
        if (kmAlin > 0 && litrosAlin > 0) {
            consumoReal = (litrosAlin / kmAlin) * 100;
            pasos.push(paso('Dividir litros por km y llevarlo a 100 km', `${nf(litrosAlin, 1)} ÷ ${nf(kmAlin)} × 100`, `${nf(consumoReal, 2)} L/100Km`));
        } else if (totalKm > 0 && kmAlin <= 0) {
            motivoSinCalculo = 'El GPS del período no coincide con los meses que tienen cargas';
        } else motivoSinCalculo = 'Sin kilómetros de GPS en el período';
    } else if (calcType === 'L/Hora') {
        pasos.push(paso(
            'Sumar las horas del GPS',
            `${nf(horasAlinDesglose.ralenti, 1)} hs ralentí + ${nf(horasAlinDesglose.movimiento, 1)} hs movimiento`,
            `${nf(horasAlin, 1)} hs`,
            'Se suman ambos tipos de hora: el motor consume igual estando en ralentí.'
        ));
        if (horasAlin > 0 && litrosAlin > 0) {
            consumoReal = litrosAlin / horasAlin;
            pasos.push(paso('Dividir litros por horas', `${nf(litrosAlin, 1)} ÷ ${nf(horasAlin, 1)}`, `${nf(consumoReal, 2)} L/Hora`));
        } else if (totalHoras > 0 && horasAlin <= 0) {
            motivoSinCalculo = 'El GPS del período no coincide con los meses que tienen cargas';
        } else motivoSinCalculo = 'Sin horas de GPS en el período';
    }

    // --- Paso final: comparación contra la meta ---
    let desvioPct = null;
    if (consumoReal > 0 && confirmed && confirmed.valor > 0) {
        desvioPct = ((consumoReal / confirmed.valor) - 1) * 100;
        pasos.push(paso(
            'Comparar contra la meta',
            `(${nf(consumoReal, 2)} ÷ ${nf(confirmed.valor, 2)} − 1) × 100`,
            `${desvioPct >= 0 ? '+' : ''}${nf(desvioPct, 1)}%`,
            desvioPct > 15 ? 'Más de 15% por encima se marca como desvío.' : null
        ));
    }
    if (motivoSinCalculo) {
        pasos.push(paso('No se puede completar el cálculo', motivoSinCalculo, '—'));
    }

    // --- Cross-check: si el GPS reporta tanto horas como km, validar el tipo de cálculo ---
    // El cross-check usa la MISMA base alineada que consumo_real: si usara los totales del
    // período completo, las dos unidades saldrían de datos distintos y no serían comparables
    // entre sí (que es justamente lo que este paso pretende dejar comparar).
    let crossCheck = null;
    if (horasAlin > 0 && kmAlin > 0 && litrosAlin > 0 && calcType !== 'No Aplica' && calcType !== 'Sin clasificar') {
        const consumoAlt = calcType === 'L/Hora'
            ? (litrosAlin / kmAlin) * 100
            : litrosAlin / horasAlin;
        const unidadAlt = calcType === 'L/Hora' ? 'L/100Km' : 'L/Hora';
        crossCheck = { tipo_alt: unidadAlt, consumo_alt: consumoAlt };
        pasos.push(paso(
            'Cross-check: el GPS reporta horas y km',
            `Consumo calculado con la otra unidad: ${nf(consumoAlt, 2)} ${unidadAlt}`,
            `Tipo asignado: ${calcType}`,
            `Este equipo tiene ${nf(horasAlin, 1)} hs y ${nf(kmAlin)} km en el GPS del período medido. Si el tipo de cálculo no es el correcto, se puede cambiar manualmente.`
        ));
    }

    const fuentes = [...new Set([...cargasList, ...gpsList].map(r => r.source_file).filter(Boolean))];

    return {
        tipo_calculo: calcType,
        // Totales del período: gasto y actividad REALES, tal como se registraron. No se
        // recortan por la alineación — el equipo cargó esos litros aunque falte el GPS de
        // algún mes, y ese gasto tiene que seguir contando en los totales de la flota.
        total_litros: totalLitros,
        total_costo: totalCosto,
        total_km: totalKm,
        total_horas: totalHoras,
        horas_ralenti: horas.ralenti,
        horas_movimiento: horas.movimiento,
        // Base efectivamente usada para el RATIO (meses con cargas Y GPS). Cuando los
        // períodos están alineados coincide con los totales de arriba.
        litros_alineados: litrosAlin,
        km_alineados: kmAlin,
        horas_alineadas: horasAlin,
        // Las DOS unidades, siempre que haya con qué calcularlas, sobre la misma base
        // alineada. No son alternativas excluyentes: en un mixer de Tunuyán las distancias
        // son largas (L/100km dice algo) y además hay ralentí en obra (L/hora dice otra
        // cosa), y mirar una sola esconde la mitad del comportamiento del equipo.
        consumo_l_hora: horasAlin > 0 && litrosAlin > 0 ? litrosAlin / horasAlin : 0,
        consumo_l_100km: kmAlin > 0 && litrosAlin > 0 ? (litrosAlin / kmAlin) * 100 : 0,
        alineacion: {
            meses: alin.meses,
            meses_cargas: alin.mesesCargas,
            meses_gps: alin.mesesGps,
            alineado: alin.alineado,
            sin_mes_comun: alin.sinMesComun,
            cargas_fuera: alin.cargasFuera,
            gps_fuera: alin.gpsFuera,
            gps_parcial: alin.gpsParcial
        },
        consumo_real: consumoReal,
        desvio_pct: desvioPct,
        cantidad_cargas: cargasList.length,
        cantidad_gps: gpsList.length,
        cantidad_cargas_alineadas: alin.cargas.length,
        cantidad_gps_alineados: alin.gps.length,
        motivo_sin_calculo: motivoSinCalculo,
        cross_check: crossCheck,
        pasos,
        fuentes
    };
}

/** Cuenta ocurrencias de un campo en una lista de registros, de más a menos frecuente. */
function contarFrecuencias(lista, campo) {
    const m = new Map();
    lista.forEach(r => {
        const v = r[campo];
        if (!v) return;
        m.set(v, (m.get(v) || 0) + 1);
    });
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([valor, n]) => ({ valor, n }));
}

/** Igual que contarFrecuencias(), pero contando un valor DERIVADO de cada registro (ej: la bandera a partir del combustible) en vez de un campo directo. */
function contarFrecuenciasDerivado(lista, fn) {
    const m = new Map();
    lista.forEach(r => {
        const v = fn(r);
        if (!v) return;
        m.set(v, (m.get(v) || 0) + 1);
    });
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([valor, n]) => ({ valor, n }));
}

/**
 * Provincia, centro de costo, lugar de carga, bandera y tipo de combustible de un equipo, en
 * el período analizado.
 *
 * La provincia sale del padrón (Equipos.UBICACIÓN). El resto NO es un atributo fijo del
 * equipo — depende de dónde y con qué cargó combustible ese período, así que se toma el más
 * frecuente entre sus cargas, con el resto del detalle disponible por si hace falta mostrarlo:
 * un mismo interno puede repartirse entre dos centros de costo en el mismo mes (ej: TR32 carga
 * tanto para CEMENTO como para ÁRIDOS, con su propio centro de costo cada vez).
 *
 * Centro de costo (columna "CENTRO DE COSTO") es la unidad administrativa que paga la carga
 * (PMZA, AMZA, PTY...); lugar de carga (columna "LUGAR DE CARGA") es el sitio físico donde se
 * cargó, y puede ser una sede propia con carga a granel bandera YPF (Godoy Cruz, Áridos,
 * Tunuyán, San Martín, Altamira, San Juan externo — sede principal al mismo nivel que Mendoza)
 * o una estación de servicio Axion de terceros (Gris, EE SS Coronel Díaz, GNC Godoy Cruz). Son
 * dos ejes distintos y no deben confundirse entre sí (ver tipoLugarCarga() en normalizer.js).
 */
function resumenUbicacion(equipo, cargasList) {
    const centros = contarFrecuencias(cargasList, 'centro_costo');
    const centroCostos = centros.map(c => ({ valor: getNombreCentroCosto(c.valor), codigo: c.valor, n: c.n }));
    const lugares = contarFrecuencias(cargasList, 'lugar_carga');
    const combustibles = contarFrecuencias(cargasList, 'combustible');
    const banderas = contarFrecuenciasDerivado(cargasList, r => getBandera(r.combustible));
    return {
        provincia: getProvincia(equipo.ubicacion),
        centroCosto: centroCostos[0] ? centroCostos[0].valor : '',
        centroCostoBreakdown: centroCostos,
        lugarCarga: lugares[0] ? lugares[0].valor : '',
        lugarCargaBreakdown: lugares,
        tipoLugarCarga: lugares[0] ? tipoLugarCarga(lugares[0].valor) : '',
        combustible: combustibles[0] ? combustibles[0].valor : '',
        combustibleBreakdown: combustibles,
        bandera: banderas[0] ? banderas[0].valor : '',
        banderaBreakdown: banderas
    };
}

export function getCargasForEquipo(interno, rawRecords = []) {
    const key = normalizeEquipoKey(interno);
    return rawRecords.filter(r => r.type === 'carga' && ((r.interno_key || normalizeEquipoKey(r.interno)) === key || (r.dominio_key || '') === key));
}

export function getGPSForEquipo(interno, rawRecords = []) {
    const key = normalizeEquipoKey(interno);
    return rawRecords.filter(r => r.type === 'gps' && ((r.interno_key || normalizeEquipoKey(r.interno)) === key || (r.dominio_key || '') === key));
}

// ============================================================ FLOTA

/**
 * Análisis completo de la flota en una sola pasada, con trazabilidad.
 * @param {Object} opts.filtro  { anio, mes, desde, hasta } — filtros de período
 */
export function analizarFlota({ equipos = [], rawRecords = [], estimados = [], filtro = {} } = {}) {
    const idx = indexarMaestro(equipos);

    // Los registros en cero se sacan ANTES de calcular el período: si no, un equipo con una
    // sola fila real de enero y cinco filas vacías hasta junio arrastra el período de toda la
    // flota y aparece como si tuviera seis meses de datos.
    const vacios = rawRecords.filter(registroVacio);
    const duplicadosExactos = rawRecords.filter(r => r && r._dupe_exacta && !registroVacio(r));
    const utiles = rawRecords.filter(r => !registroExcluido(r));
    const allCargas = utiles.filter(r => r.type === 'carga');
    const allGps = utiles.filter(r => r.type === 'gps');
    const allOtros = utiles.filter(r => r.type !== 'carga' && r.type !== 'gps');
    const descartados = {
        total: vacios.length,
        gps: vacios.filter(r => r.type === 'gps').length,
        cargas: vacios.filter(r => r.type === 'carga').length,
        internos: [...new Set(vacios.map(r => r.interno).filter(Boolean))],
        // Copias exactas apartadas automáticamente al importar (no se cuentan dos veces).
        duplicados: duplicadosExactos.length,
        duplicados_cargas: duplicadosExactos.filter(r => r.type === 'carga').length,
        duplicados_gps: duplicadosExactos.filter(r => r.type === 'gps').length,
        duplicados_litros: duplicadosExactos.reduce((s, r) => s + (parseFloat(r.litros) || 0), 0),
        duplicados_costo: duplicadosExactos.reduce((s, r) => s + (parseFloat(r.importe) || 0), 0)
    };

    const auto = calculateAlignedPeriod(allCargas, allGps);
    const usaFiltroManual = !!(filtro.anio || filtro.mes || filtro.desde || filtro.hasta || (filtro.periodos && filtro.periodos.length));

    let cargas, gps, otros, start, end, criterioPeriodo;
    if (usaFiltroManual) {
        cargas = filtrarPorPeriodo(allCargas, filtro);
        gps = filtrarPorPeriodo(allGps, filtro);
        otros = filtrarPorPeriodo(allOtros, filtro);
        if (filtro.periodos && filtro.periodos.length) {
            const sorted = [...filtro.periodos].sort();
            start = sorted[0] + '-01';
            const last = sorted[sorted.length - 1];
            const [ly, lm] = last.split('-').map(Number);
            const lastDay = new Date(ly, lm, 0).getDate();
            end = `${last}-${String(lastDay).padStart(2, '0')}`;
            criterioPeriodo = `${sorted.length} mes${sorted.length > 1 ? 'es' : ''} seleccionado${sorted.length > 1 ? 's' : ''}`;
        } else {
            start = filtro.desde || null;
            end = filtro.hasta || null;
            criterioPeriodo = 'filtro manual';
        }
    } else {
        start = auto.start; end = auto.end;
        const dentro = r => {
            if (!start || !end || !r.fecha) return true;
            return (r.fecha_hasta || r.fecha) >= start && r.fecha <= end;
        };
        cargas = allCargas.filter(dentro);
        gps = allGps.filter(dentro);
        otros = allOtros.filter(dentro);
        criterioPeriodo = 'superposición automática entre Cargas y GPS';
    }

    // Agrupar movimientos por equipo del maestro, resolviendo por interno O por dominio.
    const porEquipo = new Map();      // clave del maestro -> {cargas, gps, otros}
    const huerfanosMap = new Map();   // registros que no matchean ningún equipo

    const asignar = (registro, campo) => {
        const eq = resolverEquipo(registro, idx);
        if (eq) {
            const k = eq.interno;
            if (!porEquipo.has(k)) porEquipo.set(k, { cargas: [], gps: [], otros: [] });
            porEquipo.get(k)[campo].push(registro);
        } else {
            const k = registro.interno_key || registro.dominio_key || '?';
            if (!huerfanosMap.has(k)) {
                huerfanosMap.set(k, { interno: registro.interno || registro.dominio || k, dominio: registro.dominio || '', cargas: 0, gps: 0, otros: 0, litros: 0 });
            }
            const h = huerfanosMap.get(k);
            h[campo]++;
            if (campo === 'cargas') h.litros += parseFloat(registro.litros) || 0;
        }
    };
    cargas.forEach(r => asignar(r, 'cargas'));
    gps.forEach(r => asignar(r, 'gps'));
    otros.forEach(r => asignar(r, 'otros'));

    const filas = equipos.map(eq => {
        const g = porEquipo.get(eq.interno) || { cargas: [], gps: [], otros: [] };
        const confirmed = getConfirmedConsumption(eq, estimados);
        const metrics = calculateMetrics(eq, g.cargas, g.gps, confirmed);
        return {
            equipo: { ...eq, denominacion: eq.denominacion || getDenominacion(eq.interno, eq.tipo) },
            prefijo: getPrefijo(eq.interno),
            metrics, confirmed,
            ubicacion: resumenUbicacion(eq, g.cargas),
            cargas: g.cargas, gps: g.gps, otros: g.otros
        };
    });

    const huerfanos = [...huerfanosMap.values()].sort((a, b) => b.litros - a.litros);

    const litrosTot = cargas.reduce((s, c) => s + (parseFloat(c.litros) || 0), 0);
    const costoTot = cargas.reduce((s, c) => s + (parseFloat(c.importe) || 0), 0);
    const kmTot = gps.reduce((s, g) => s + (parseFloat(g.distancia) || 0), 0);
    const hs = desgloseHoras(gps);

    // Desglose de litros y costo por tipo de combustible (bandera + combustible)
    const porCombustible = new Map();
    cargas.forEach(c => {
        const bandera = getBandera(c.combustible) || 'Otro';
        const tipo = c.combustible || 'Sin dato';
        const key = `${bandera}|${tipo}`;
        if (!porCombustible.has(key)) porCombustible.set(key, { bandera, tipo, litros: 0, costo: 0, cargas: 0 });
        const b = porCombustible.get(key);
        b.litros += parseFloat(c.litros) || 0;
        b.costo += parseFloat(c.importe) || 0;
        b.cargas++;
    });
    const combustibleDesglose = [...porCombustible.values()]
        .map(b => ({ ...b, precio_litro: b.litros > 0 ? b.costo / b.litros : 0 }))
        .sort((a, b) => b.litros - a.litros);

    // Desglose de litros y costo por LUGAR de carga: mismo criterio que combustibleDesglose,
    // pero agrupando por el sitio físico en vez del producto. Sirve para ver cuánto se gastó en
    // cada sede/estación y con qué combustible(s), no solo el mix global de la flota.
    const porLugar = new Map();
    cargas.forEach(c => {
        const lugar = c.lugar_carga || 'Sin dato';
        if (!porLugar.has(lugar)) {
            porLugar.set(lugar, { lugar, tipo: tipoLugarCarga(lugar), litros: 0, costo: 0, cargas: 0, combustibles: new Map() });
        }
        const l = porLugar.get(lugar);
        l.litros += parseFloat(c.litros) || 0;
        l.costo += parseFloat(c.importe) || 0;
        l.cargas++;
        const comb = c.combustible || 'Sin dato';
        if (!l.combustibles.has(comb)) l.combustibles.set(comb, { tipo: comb, litros: 0, cargas: 0 });
        const cb = l.combustibles.get(comb);
        cb.litros += parseFloat(c.litros) || 0;
        cb.cargas++;
    });
    const lugarDesglose = [...porLugar.values()]
        .map(l => ({ ...l, precio_litro: l.litros > 0 ? l.costo / l.litros : 0, combustibles: [...l.combustibles.values()].sort((a, b) => b.litros - a.litros) }))
        .sort((a, b) => b.litros - a.litros);

    const totales = {
        periodo_desde: start, periodo_hasta: end, criterio_periodo: criterioPeriodo,
        equipos: equipos.length,
        equipos_con_datos: filas.filter(f => f.metrics.cantidad_cargas > 0 || f.metrics.cantidad_gps > 0).length,
        registros_descartados: descartados,
        total_litros: litrosTot, total_costo: costoTot, total_km: kmTot,
        total_horas: hs.total, horas_ralenti: hs.ralenti, horas_movimiento: hs.movimiento,
        cantidad_cargas: cargas.length, cantidad_gps: gps.length, cantidad_otros: otros.length,
        con_meta: filas.filter(f => f.confirmed).length,
        sobre_meta: filas.filter(f => f.metrics.desvio_pct !== null && f.metrics.desvio_pct > 15).length,
        sin_calculo: filas.filter(f => f.metrics.motivo_sin_calculo && f.metrics.tipo_calculo !== 'No Aplica').length,
        costo_por_litro: litrosTot > 0 ? costoTot / litrosTot : 0,
        combustible_desglose: combustibleDesglose,
        lugar_desglose: lugarDesglose,
        huerfanos
    };

    // ---- Trazabilidad de los totales del panel ----
    totales.pasos = {
        periodo: [
            paso('Tomar el rango de fechas de las Cargas', `${allCargas.length} registros`, rangoTxt(allCargas)),
            paso('Tomar el rango del Resumen de Flota', `${allGps.length} registros`, rangoTxt(allGps)),
            paso(usaFiltroManual ? 'Aplicar el filtro elegido' : 'Quedarse con la superposición de ambos', criterioPeriodo, start && end ? `${start} → ${end}` : 'todo el histórico',
                usaFiltroManual ? null : 'Comparar litros de un período contra km/horas de otro daría un consumo incorrecto.')
        ],
        litros: [
            paso('Filtrar las cargas al período', `${allCargas.length} → ${cargas.length} registros`, `${cargas.length} cargas`),
            paso('Sumar la columna LITROS', `${cargas.length} valores`, `${nf(litrosTot, 1)} L`)
        ],
        costo: [
            paso('Sumar la columna COSTO TOTAL de las cargas', `${cargas.length} valores`, `$${nf(costoTot)}`),
            paso('Dividir el costo por los litros', `${nf(costoTot)} ÷ ${nf(litrosTot, 1)}`, `$${nf(costoTot / (litrosTot || 1))} por litro`)
        ],
        km: [
            paso('Filtrar el GPS al período', `${allGps.length} → ${gps.length} registros`, `${gps.length} registros`),
            paso('Sumar KILÓMETROS RECORRIDOS', `${gps.length} valores`, `${nf(kmTot)} km`)
        ],
        horas: [
            paso('Convertir cada tiempo de Excel a horas', 'valor × 24 (Excel guarda las horas como fracción de día)', 'horas reales'),
            paso('Sumar tiempo en ralentí', `${gps.length} registros`, `${nf(hs.ralenti, 1)} hs`),
            paso('Sumar tiempo en movimiento', `${gps.length} registros`, `${nf(hs.movimiento, 1)} hs`),
            paso('Sumar ambos', `${nf(hs.ralenti, 1)} + ${nf(hs.movimiento, 1)}`, `${nf(hs.total, 1)} hs`)
        ],
        sobre_meta: [
            paso('Calcular el consumo real de cada equipo', `${filas.length} equipos`, `${filas.filter(f => f.metrics.consumo_real > 0).length} con consumo calculable`),
            paso('Comparar contra su meta', `${totales.con_meta} equipos con meta cargada`, `${totales.sobre_meta} superan la meta en más de 15%`)
        ],
        equipos: [
            paso('Contar las filas del maestro', 'planilla de Equipos + Consumos Estimados', `${equipos.length} equipos`),
            paso('Cruzar movimientos por interno o dominio', `${cargas.length + gps.length + otros.length} registros`, `${totales.equipos_con_datos} equipos con actividad`),
            paso('Registros que no cruzaron con ningún equipo', `${huerfanos.length} códigos`, `${nf(huerfanos.reduce((s, h) => s + h.litros, 0))} L sin asignar`)
        ]
    };

    return { filas, totales, movimientosOtros: otros };
}

function rangoTxt(recs) {
    const f = recs.map(r => r.fecha).filter(Boolean).sort();
    return f.length ? `${f[0]} → ${f[f.length - 1]}` : 'sin fechas';
}

/**
 * Agrupa movimientos genéricos (cubiertas, insumos, filtros…) por tipo y por equipo,
 * sumando automáticamente sus columnas numéricas.
 */
export function resumirMovimientosGenericos(otros = []) {
    const porTipo = new Map();
    otros.forEach(r => {
        if (!porTipo.has(r.type)) porTipo.set(r.type, { tipo: r.type, etiqueta: r.type_label || r.type, registros: 0, equipos: new Set(), metricas: {} });
        const t = porTipo.get(r.type);
        t.registros++;
        t.equipos.add(r.interno_key || r.dominio_key);
        Object.entries(r.numericos || {}).forEach(([k, v]) => { t.metricas[k] = (t.metricas[k] || 0) + v; });
    });
    return [...porTipo.values()].map(t => ({ ...t, equipos: t.equipos.size }));
}
