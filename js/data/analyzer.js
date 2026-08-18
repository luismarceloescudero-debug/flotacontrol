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

import { normalizeEquipoKey, getPrefijo, getDenominacion, partesFecha, getProvincia, getSubSede } from './normalizer.js';

export const RULE_L_100KM = ['TR', 'CM', 'CH', 'FG', 'AU'];
export const RULE_L_HORA = ['MX', 'CF', 'EX', 'TP', 'GE', 'BM', 'VL', 'AE', 'RE', 'MC', 'MT', 'MH', 'CL', 'MS'];
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
 * Filtra registros por año / mes / rango explícito.
 * Un registro de GPS abarca un período (fecha..fecha_hasta), así que se considera incluido
 * si ese período se superpone con el filtro, no solo si empieza dentro.
 */
export function filtrarPorPeriodo(records = [], filtro = {}) {
    const { anio, mes, desde, hasta } = filtro;
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

    if (calcType === 'No Aplica') {
        motivoSinCalculo = 'Equipo remolcado, sin motor propio';
    } else if (calcType === 'Sin clasificar') {
        motivoSinCalculo = 'Falta definir si se mide por hora o por km';
    } else if (totalLitros <= 0) {
        motivoSinCalculo = 'Sin cargas de combustible en el período';
    } else if (calcType === 'L/100Km') {
        pasos.push(paso('Sumar los kilómetros del GPS', `${gpsList.length} ${gpsList.length === 1 ? 'registro' : 'registros'} de Resumen de Flota`, `${nf(totalKm)} km`));
        if (totalKm > 0) {
            consumoReal = (totalLitros / totalKm) * 100;
            pasos.push(paso('Dividir litros por km y llevarlo a 100 km', `${nf(totalLitros, 1)} ÷ ${nf(totalKm)} × 100`, `${nf(consumoReal, 2)} L/100Km`));
        } else motivoSinCalculo = 'Sin kilómetros de GPS en el período';
    } else if (calcType === 'L/Hora') {
        pasos.push(paso(
            'Sumar las horas del GPS',
            `${nf(horas.ralenti, 1)} hs ralentí + ${nf(horas.movimiento, 1)} hs movimiento`,
            `${nf(totalHoras, 1)} hs`,
            'Se suman ambos tipos de hora: el motor consume igual estando en ralentí.'
        ));
        if (totalHoras > 0) {
            consumoReal = totalLitros / totalHoras;
            pasos.push(paso('Dividir litros por horas', `${nf(totalLitros, 1)} ÷ ${nf(totalHoras, 1)}`, `${nf(consumoReal, 2)} L/Hora`));
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

    const fuentes = [...new Set([...cargasList, ...gpsList].map(r => r.source_file).filter(Boolean))];

    return {
        tipo_calculo: calcType,
        total_litros: totalLitros,
        total_costo: totalCosto,
        total_km: totalKm,
        total_horas: totalHoras,
        horas_ralenti: horas.ralenti,
        horas_movimiento: horas.movimiento,
        consumo_real: consumoReal,
        desvio_pct: desvioPct,
        cantidad_cargas: cargasList.length,
        cantidad_gps: gpsList.length,
        motivo_sin_calculo: motivoSinCalculo,
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

/**
 * Provincia, sub-sede y estación/lugar de carga de un equipo, en el período analizado.
 *
 * La provincia sale del padrón (Equipos.UBICACIÓN). La sub-sede y el lugar de carga NO son
 * un atributo fijo del equipo — dependen de dónde cargó combustible ese período — así que se
 * toma el más frecuente entre sus cargas, con el resto del detalle disponible por si hace
 * falta mostrarlo (un mixer puede cargar en dos sedes distintas en el mismo mes).
 */
function resumenUbicacion(equipo, cargasList) {
    const centros = contarFrecuencias(cargasList, 'centro_costo');
    const subSedes = centros.map(c => ({ valor: getSubSede(c.valor), n: c.n }));
    const lugares = contarFrecuencias(cargasList, 'lugar_carga');
    return {
        provincia: getProvincia(equipo.ubicacion),
        subSede: subSedes[0] ? subSedes[0].valor : '',
        subSedeBreakdown: subSedes,
        lugarCarga: lugares[0] ? lugares[0].valor : '',
        lugarCargaBreakdown: lugares
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

    const allCargas = rawRecords.filter(r => r.type === 'carga');
    const allGps = rawRecords.filter(r => r.type === 'gps');
    const allOtros = rawRecords.filter(r => r.type !== 'carga' && r.type !== 'gps');

    const auto = calculateAlignedPeriod(allCargas, allGps);
    const usaFiltroManual = !!(filtro.anio || filtro.mes || filtro.desde || filtro.hasta);

    let cargas, gps, otros, start, end, criterioPeriodo;
    if (usaFiltroManual) {
        cargas = filtrarPorPeriodo(allCargas, filtro);
        gps = filtrarPorPeriodo(allGps, filtro);
        otros = filtrarPorPeriodo(allOtros, filtro);
        start = filtro.desde || null;
        end = filtro.hasta || null;
        criterioPeriodo = 'filtro manual';
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

    const totales = {
        periodo_desde: start, periodo_hasta: end, criterio_periodo: criterioPeriodo,
        equipos: equipos.length,
        equipos_con_datos: filas.filter(f => f.metrics.cantidad_cargas > 0 || f.metrics.cantidad_gps > 0).length,
        total_litros: litrosTot, total_costo: costoTot, total_km: kmTot,
        total_horas: hs.total, horas_ralenti: hs.ralenti, horas_movimiento: hs.movimiento,
        cantidad_cargas: cargas.length, cantidad_gps: gps.length, cantidad_otros: otros.length,
        con_meta: filas.filter(f => f.confirmed).length,
        sobre_meta: filas.filter(f => f.metrics.desvio_pct !== null && f.metrics.desvio_pct > 15).length,
        sin_calculo: filas.filter(f => f.metrics.motivo_sin_calculo && f.metrics.tipo_calculo !== 'No Aplica').length,
        costo_por_litro: litrosTot > 0 ? costoTot / litrosTot : 0,
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
