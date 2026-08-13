/**
 * Lógica de Negocio y Análisis
 * Implementa las reglas específicas para L/100Km vs L/Hora
 */

import { normalizeEquipoKey } from './normalizer.js';

export const RULE_L_100KM = ['TR', 'CM', 'VL11', 'CH28']; // TR, CM, VL11 (OJV377), CH28 (AB300PW)
export const RULE_L_HORA = ['MX', 'CF', 'EX', 'TP', 'GE', 'BM']; 
export const RULE_NO_TANK = ['BA', 'CR', 'SR', 'TO']; // BA, BM SIN DOMINIO, TO, CR, SR

export function getConfirmedConsumption(interno, estimadosData = []) {
    if (!interno) return null;
    const key = interno.toUpperCase();

    // Buscar en la BD de estimados
    const estimado = estimadosData.find(e => e.interno === key);
    if (estimado) {
        return {
            value: estimado.consumo_estimado, // texto tal cual viene del Excel, ej "3 L/hora"
            valor: estimado.consumo_estimado_valor || 0, // número puro, para comparar/calcular
            source: 'Base de Datos (Consumos Estimados)'
        };
    }
    return null;
}

/**
 * Calcula el periodo de tiempo superpuesto (intersección) entre las cargas y los registros de GPS.
 * Esto garantiza que el cálculo de consumos se haga solo sobre el lapso temporal donde existen ambos datos.
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

    let start = null;
    let end = null;

    if (minC && minG) {
        start = minC > minG ? minC : minG; // max of mins
    } else {
        start = minC || minG;
    }

    if (maxC && maxG) {
        end = maxC < maxG ? maxC : maxG; // min of maxes
    } else {
        end = maxC || maxG;
    }
    
    // If start > end, there is no mathematical overlap. Fallback to full range.
    if (start && end && start > end) {
        start = minC && minG ? (minC < minG ? minC : minG) : (minC || minG);
        end = maxC && maxG ? (maxC > maxG ? maxC : maxG) : (maxC || maxG);
    }

    return { start, end };
}

/**
 * Extrae el prefijo alfabético del interno de un equipo (ej: "TR20" -> "TR", "BM-09" -> "BM").
 * Los arrays RULE_L_100KM / RULE_L_HORA / RULE_NO_TANK están definidos en términos de
 * este prefijo de 2 letras (así lo usa `cards.js` para excluir equipos sin tanque).
 */
function equipoPrefix(interno) {
    const m = (interno || '').toUpperCase().match(/^[A-Z]+/);
    return m ? m[0] : '';
}

/**
 * Determina el tipo de cálculo de consumo que aplica a un equipo
 * basado en las reglas de negocio.
 *
 * Fix: la versión anterior comparaba RULE_L_100KM / RULE_L_HORA / RULE_NO_TANK (arrays de
 * prefijos de 2 letras como "TR", "CM", "BM") contra `equipo.tipo`, que en los Excel reales
 * contiene texto descriptivo ("AUTOELEVADOR", "BATEA", etc.) o incluso una clasificación por
 * peso ("VARIOS"/"LIVIANO"/"PESADO") — nunca iba a matchear, y determineConsumptionType()
 * devolvía 'Desconocido' para casi toda la flota, dejando consumo_real en 0. Ahora se compara
 * contra el prefijo del `interno` (mismo criterio que ya usaba `cards.js` para excluir equipos
 * sin tanque vía `.startsWith()`), que es donde realmente viven esos códigos ("TR20", "CM43",
 * "BM09", "CF25", "MX96", etc. en Cargas_Combustible/Resumen de Flota).
 *
 * @param {Object} equipo - Objeto del equipo desde la base de datos
 * @param {Array} cargas - Historial de cargas de combustible (opcional, para revisar LUGAR/CENTRO DE COSTO)
 * @returns {String} 'L/100Km', 'L/Hora', 'No Aplica' o 'Desconocido'
 */
export function determineConsumptionType(equipo, cargas = []) {
    if (!equipo) return 'Desconocido';

    let interno = (equipo.interno || '').toUpperCase();
    let dominio = (equipo.dominio || '').toUpperCase();
    let prefix = equipoPrefix(interno);

    // 1. Equipos sin tanque
    if (RULE_NO_TANK.includes(prefix)) {
        return 'No Aplica';
    }
    if (prefix === 'BM' && (!dominio || dominio === 'SIN DOMINIO' || dominio === 'S/D')) {
        return 'No Aplica';
    }

    // 2. Equipos por Km (L/100Km)
    if (RULE_L_100KM.includes(prefix) ||
        interno === 'VL11' || dominio === 'OJV377' ||
        interno === 'CH28' || dominio === 'AB300PW') {
        return 'L/100Km';
    }

    // 3. Equipos por Hora (L/Hora) - Condición: Centro de Costo o Lugar de Carga == 'ARIDOS'
    let isAridos = false;
    if (cargas && cargas.length > 0) {
        // Chequeamos si alguna carga reciente dice ARIDOS
        isAridos = cargas.some(c => {
            let cc = (c.centro_costo || '').toUpperCase();
            let lugar = (c.lugar_carga || '').toUpperCase();
            return cc.includes('ARIDOS') || lugar.includes('ARIDOS');
        });
    }

    if (RULE_L_HORA.includes(prefix) || prefix === 'VL') {
        if (isAridos || cargas.length === 0) {
             // Si no pasamos cargas, asumimos que puede ser L/Hora según el tipo
             // Idealmente siempre evaluar con cargas.
            return 'L/Hora';
        }
    }

    return 'Desconocido';
}

/**
 * Suma las horas de una lista de registros GPS, soportando tanto el formato nuevo
 * (`horas` como objeto `{ralenti, movimiento, parado, total}`, generado por
 * `aggregateHours()` en el parser) como el formato viejo (`horas` como número plano),
 * por si quedan registros cargados con una versión anterior de la app en IndexedDB.
 *
 * Fix: esta lógica estaba duplicada entre `calculateMetrics()` (acá) y `renderDashboard()`
 * (dashboard.js), y las dos copias habían divergido: dashboard.js solo hacía
 * `parseFloat(g.horas)`, que da NaN cuando `horas` es un objeto, así que las métricas
 * globales del Dashboard no sumaban ralentí+movimiento aunque las tarjetas por equipo sí.
 * Centralizarla acá evita que se vuelvan a desincronizar.
 */
export function sumHoras(gpsList = []) {
    let total = 0;
    gpsList.forEach(g => {
        if (g.horas && typeof g.horas === 'object') {
            total += g.horas.total || 0;
        } else {
            total += parseFloat(g.horas) || 0;
        }
    });
    return total;
}

/**
 * Calcula las métricas de consumo de un equipo
 */
export function calculateMetrics(equipo, cargasList, gpsList) {
    const calcType = determineConsumptionType(equipo, cargasList);

    let totalLitros = 0;
    let totalCosto = 0;

    cargasList.forEach(c => {
        totalLitros += (parseFloat(c.litros) || 0);
        totalCosto += (parseFloat(c.importe) || 0);
    });

    let totalKm = 0;
    gpsList.forEach(g => {
        totalKm += (parseFloat(g.distancia) || 0);
    });
    const totalHoras = sumHoras(gpsList);

    let consumoReal = 0;
    
    if (calcType === 'L/100Km' && totalKm > 0) {
        consumoReal = (totalLitros / totalKm) * 100;
    } else if (calcType === 'L/Hora' && totalHoras > 0) {
        consumoReal = totalLitros / totalHoras;
    }

    return {
        tipo_calculo: calcType,
        total_litros: totalLitros,
        total_costo: totalCosto,
        total_km: totalKm,
        total_horas: totalHoras,
        consumo_real: consumoReal
    };
}

export function getCargasForEquipo(interno, rawRecords) {
    return rawRecords.filter(r => 
        r.type === 'carga' && 
        normalizeEquipoKey(r.interno) === normalizeEquipoKey(interno)
    );
}

export function getGPSForEquipo(interno, rawRecords) {
    return rawRecords.filter(r => 
        r.type === 'gps' && 
        normalizeEquipoKey(r.interno) === normalizeEquipoKey(interno)
    );
}
