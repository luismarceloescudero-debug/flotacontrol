/**
 * Lógica de Negocio y Análisis
 *
 * Regla central: el TIPO DE CÁLCULO (L/Hora vs L/100Km) se determina por la UNIDAD de la
 * meta declarada en "Consumos Estimados", no por listas de prefijos hardcodeadas.
 * Esa planilla ya declara explícitamente, equipo por equipo, si se mide por hora o por
 * distancia (91 equipos en L/hora, 43 en L/100km), y es la fuente de verdad del área.
 * Las listas de prefijos quedan solo como fallback para equipos sin meta cargada.
 */

import { normalizeEquipoKey, getPrefijo, getDenominacion } from './normalizer.js';

// Fallbacks para equipos SIN meta declarada en Consumos Estimados.
// Derivados de la unidad que el propio Excel de metas usa para cada familia.
export const RULE_L_100KM = ['TR', 'CM', 'CH', 'FG', 'AU'];
export const RULE_L_HORA = ['MX', 'CF', 'EX', 'TP', 'GE', 'BM', 'VL', 'AE', 'RE', 'MC', 'MT', 'MH', 'CL', 'MS'];
// Equipos remolcados, sin motor propio -> no consumen combustible.
export const RULE_NO_TANK = ['BA', 'CR', 'SR', 'TO'];

/**
 * Busca la meta de consumo de un equipo. Devuelve también la unidad parseada, que es lo
 * que define el tipo de cálculo.
 */
export function getConfirmedConsumption(interno, estimadosData = []) {
    if (!interno) return null;
    const key = normalizeEquipoKey(interno);

    const estimado = estimadosData.find(e => normalizeEquipoKey(e.interno) === key);
    if (!estimado) return null;

    return {
        value: estimado.consumo_estimado,                 // texto original, ej "3 L/hora"
        valor: estimado.consumo_estimado_valor || 0,      // número puro, ej 3
        unidad: estimado.consumo_estimado_unidad || null, // 'L/Hora' | 'L/100Km' | null
        source: 'Consumos Estimados'
    };
}

/**
 * Calcula el periodo de tiempo superpuesto (intersección) entre las cargas y los registros
 * de GPS, para que el cruce se haga sobre el lapso donde existen ambos datos.
 */
export function calculateAlignedPeriod(cargas = [], gps = []) {
    let minC = null, maxC = null, minG = null, maxG = null;

    cargas.forEach(c => {
        if (!c.fecha) return;
        if (!minC || c.fecha < minC) minC = c.fecha;
        if (!maxC || c.fecha > maxC) maxC = c.fecha;
    });

    gps.forEach(g => {
        if (!g.fecha) return;
        const dHasta = g.fecha_hasta || g.fecha;
        if (!minG || g.fecha < minG) minG = g.fecha;
        if (!maxG || dHasta > maxG) maxG = dHasta;
    });

    let start = minC && minG ? (minC > minG ? minC : minG) : (minC || minG);
    let end = maxC && maxG ? (maxC < maxG ? maxC : maxG) : (maxC || maxG);

    // Sin superposición matemática -> usar el rango completo como fallback.
    if (start && end && start > end) {
        start = minC && minG ? (minC < minG ? minC : minG) : (minC || minG);
        end = maxC && maxG ? (maxC > maxG ? maxC : maxG) : (maxC || maxG);
    }

    return { start, end };
}

/**
 * Determina el tipo de cálculo de consumo de un equipo.
 *
 * Prioridad:
 *   1. Override manual guardado por el usuario en la tarjeta (equipo.tipo_calculo_manual).
 *   2. Unidad de la meta en Consumos Estimados  <- fuente de verdad del área.
 *   3. Listas de prefijos (fallback para equipos sin meta).
 *
 * @returns {'L/100Km'|'L/Hora'|'No Aplica'|'Sin clasificar'}
 */
export function determineConsumptionType(equipo, cargas = [], confirmed = null) {
    if (!equipo) return 'Sin clasificar';

    // 1. Override manual
    if (equipo.tipo_calculo_manual) return equipo.tipo_calculo_manual;

    // 2. Unidad declarada en la meta
    if (confirmed && confirmed.unidad) return confirmed.unidad;

    // 3. Fallback por prefijo
    const prefix = getPrefijo(equipo.interno);
    if (RULE_NO_TANK.includes(prefix)) return 'No Aplica';
    if (RULE_L_100KM.includes(prefix)) return 'L/100Km';
    if (RULE_L_HORA.includes(prefix)) return 'L/Hora';

    return 'Sin clasificar';
}

/**
 * Suma las horas de una lista de registros GPS, soportando el formato actual
 * (`horas` como objeto {ralenti, movimiento, parado, total}) y el viejo (número plano),
 * por si quedan registros de una versión anterior en IndexedDB.
 */
export function sumHoras(gpsList = []) {
    let total = 0;
    gpsList.forEach(g => {
        if (g.horas && typeof g.horas === 'object') total += g.horas.total || 0;
        else total += parseFloat(g.horas) || 0;
    });
    return total;
}

/** Desglose de horas por tipo (ralentí / movimiento), para mostrar en la tarjeta. */
export function desgloseHoras(gpsList = []) {
    const out = { ralenti: 0, movimiento: 0, parado: 0, total: 0 };
    gpsList.forEach(g => {
        if (g.horas && typeof g.horas === 'object') {
            out.ralenti += g.horas.ralenti || 0;
            out.movimiento += g.horas.movimiento || 0;
            out.parado += g.horas.parado || 0;
            out.total += g.horas.total || 0;
        } else {
            const n = parseFloat(g.horas) || 0;
            out.movimiento += n;
            out.total += n;
        }
    });
    return out;
}

/**
 * Calcula las métricas de consumo de un equipo, y explicita POR QUÉ un consumo no se pudo
 * calcular (antes todo caía en un genérico "sin datos suficientes" que no distinguía entre
 * "no cargó combustible", "no tiene GPS" o "es un acoplado sin motor").
 */
export function calculateMetrics(equipo, cargasList = [], gpsList = [], confirmed = null) {
    const calcType = determineConsumptionType(equipo, cargasList, confirmed);

    let totalLitros = 0;
    let totalCosto = 0;
    cargasList.forEach(c => {
        totalLitros += (parseFloat(c.litros) || 0);
        totalCosto += (parseFloat(c.importe) || 0);
    });

    let totalKm = 0;
    gpsList.forEach(g => { totalKm += (parseFloat(g.distancia) || 0); });

    const horas = desgloseHoras(gpsList);
    const totalHoras = horas.total;

    let consumoReal = 0;
    let motivoSinCalculo = null;

    if (calcType === 'No Aplica') {
        motivoSinCalculo = 'Equipo remolcado, sin motor propio';
    } else if (calcType === 'Sin clasificar') {
        motivoSinCalculo = 'Falta definir si se mide por hora o por km';
    } else if (totalLitros <= 0) {
        motivoSinCalculo = 'Sin cargas de combustible en el período';
    } else if (calcType === 'L/100Km') {
        if (totalKm > 0) consumoReal = (totalLitros / totalKm) * 100;
        else motivoSinCalculo = 'Sin kilómetros de GPS en el período';
    } else if (calcType === 'L/Hora') {
        if (totalHoras > 0) consumoReal = totalLitros / totalHoras;
        else motivoSinCalculo = 'Sin horas de GPS en el período';
    }

    // Desvío contra la meta (solo si ambos valores existen y la unidad coincide)
    let desvioPct = null;
    if (consumoReal > 0 && confirmed && confirmed.valor > 0) {
        desvioPct = ((consumoReal / confirmed.valor) - 1) * 100;
    }

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
        motivo_sin_calculo: motivoSinCalculo
    };
}

export function getCargasForEquipo(interno, rawRecords = []) {
    const key = normalizeEquipoKey(interno);
    return rawRecords.filter(r => r.type === 'carga' && (r.interno_key || normalizeEquipoKey(r.interno)) === key);
}

export function getGPSForEquipo(interno, rawRecords = []) {
    const key = normalizeEquipoKey(interno);
    return rawRecords.filter(r => r.type === 'gps' && (r.interno_key || normalizeEquipoKey(r.interno)) === key);
}

/**
 * Construye, en una sola pasada, el análisis completo de toda la flota: cruza las 4 fuentes
 * (Equipos + Cargas + GPS + Consumos Estimados) y devuelve tanto los totales globales del
 * dashboard como la fila de cada equipo para las tarjetas.
 *
 * Centralizar esto acá evita que el dashboard y las tarjetas calculen lo mismo por separado
 * (que fue exactamente el bug por el que mostraban números distintos) y hace una sola
 * lectura de IndexedDB por render.
 */
export function analizarFlota({ equipos = [], rawRecords = [], estimados = [], filtroDesde = null, filtroHasta = null } = {}) {
    const allCargas = rawRecords.filter(r => r.type === 'carga');
    const allGps = rawRecords.filter(r => r.type === 'gps');

    const auto = calculateAlignedPeriod(allCargas, allGps);
    const start = filtroDesde || auto.start;
    const end = filtroHasta || auto.end;

    const enRango = (r) => {
        if (!start || !end || !r.fecha) return true;
        const hasta = r.fecha_hasta || r.fecha;
        return hasta >= start && r.fecha <= end;
    };

    const cargas = allCargas.filter(enRango);
    const gps = allGps.filter(enRango);

    // Indexar por clave normalizada: O(n) en vez de O(n*m) al recorrer 193 equipos
    // contra ~3800 cargas (antes se filtraba el array completo una vez por equipo).
    const cargasPorKey = new Map();
    const gpsPorKey = new Map();
    cargas.forEach(c => {
        const k = c.interno_key || normalizeEquipoKey(c.interno);
        if (!cargasPorKey.has(k)) cargasPorKey.set(k, []);
        cargasPorKey.get(k).push(c);
    });
    gps.forEach(g => {
        const k = g.interno_key || normalizeEquipoKey(g.interno);
        if (!gpsPorKey.has(k)) gpsPorKey.set(k, []);
        gpsPorKey.get(k).push(g);
    });

    const filas = equipos.map(eq => {
        const key = normalizeEquipoKey(eq.interno);
        const eqCargas = cargasPorKey.get(key) || [];
        const eqGps = gpsPorKey.get(key) || [];
        const confirmed = getConfirmedConsumption(eq.interno, estimados);
        const metrics = calculateMetrics(eq, eqCargas, eqGps, confirmed);
        return {
            equipo: { ...eq, denominacion: eq.denominacion || getDenominacion(eq.interno, eq.tipo) },
            prefijo: getPrefijo(eq.interno),
            metrics,
            confirmed,
            cargas: eqCargas,
            gps: eqGps
        };
    });

    // Equipos que aparecen en Cargas/GPS pero NO están en la planilla de Equipos:
    // antes desaparecían en silencio; ahora se reportan para que se puedan dar de alta.
    const keysEquipos = new Set(equipos.map(e => normalizeEquipoKey(e.interno)));
    const huerfanos = [];
    const vistos = new Set();
    [...cargasPorKey.keys(), ...gpsPorKey.keys()].forEach(k => {
        if (!keysEquipos.has(k) && !vistos.has(k)) {
            vistos.add(k);
            const c = cargasPorKey.get(k) || [];
            const g = gpsPorKey.get(k) || [];
            huerfanos.push({
                interno: (c[0] && c[0].interno) || (g[0] && g[0].interno) || k,
                cargas: c.length,
                gps: g.length,
                litros: c.reduce((s, x) => s + (parseFloat(x.litros) || 0), 0)
            });
        }
    });
    huerfanos.sort((a, b) => b.litros - a.litros);

    // Totales globales
    const totales = {
        periodo_desde: start,
        periodo_hasta: end,
        equipos: equipos.length,
        equipos_con_datos: filas.filter(f => f.metrics.cantidad_cargas > 0 || f.metrics.cantidad_gps > 0).length,
        total_litros: cargas.reduce((s, c) => s + (parseFloat(c.litros) || 0), 0),
        total_costo: cargas.reduce((s, c) => s + (parseFloat(c.importe) || 0), 0),
        total_km: gps.reduce((s, g) => s + (parseFloat(g.distancia) || 0), 0),
        total_horas: sumHoras(gps),
        cantidad_cargas: cargas.length,
        cantidad_gps: gps.length,
        con_meta: filas.filter(f => f.confirmed).length,
        sobre_meta: filas.filter(f => f.metrics.desvio_pct !== null && f.metrics.desvio_pct > 15).length,
        sin_calculo: filas.filter(f => f.metrics.motivo_sin_calculo && f.metrics.tipo_calculo !== 'No Aplica').length,
        huerfanos
    };
    totales.horas_ralenti = filas.reduce((s, f) => s + f.metrics.horas_ralenti, 0);
    totales.horas_movimiento = filas.reduce((s, f) => s + f.metrics.horas_movimiento, 0);
    totales.costo_por_litro = totales.total_litros > 0 ? totales.total_costo / totales.total_litros : 0;

    return { filas, totales };
}
