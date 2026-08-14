/**
 * Normalización de datos extraídos de Excel/CSV
 */

/**
 * Denominación canónica de cada equipo según el prefijo de su interno.
 *
 * Por qué existe: la columna TIPO del Excel de Equipos trae denominaciones inconsistentes
 * o directamente erróneas (ej: los TR figuran como "CAMION" cuando son TRACTORES; los MX
 * mezclan "CAMION MIXER"/"CAMION VOLCADOR"/"CAMION REGADOR"). El prefijo del interno sí es
 * consistente en las 4 planillas, así que se usa como fuente de verdad para la denominación.
 * Verificado contra los 23 prefijos presentes en "Equipos HSV SJ-MZA 2026.xlsx".
 */
export const TIPO_POR_PREFIJO = {
    AE: 'AUTOELEVADOR',
    AU: 'AUTOMÓVIL',
    BA: 'BATEA',
    BM: 'BOMBA',
    CF: 'CARGADORA FRONTAL',
    CH: 'CAMIÓN HIDROGRÚA',
    CL: 'CALOVENTOR',
    CM: 'CAMIONETA',
    CR: 'CARRETÓN',
    EX: 'EXCAVADORA',
    FG: 'FURGÓN',
    GE: 'GRUPO ELECTRÓGENO',
    MC: 'MINICARGADORA',
    MH: 'PRODUCTORA DE HIELO',
    MS: 'SEMI MIXER',
    MT: 'MOTOCOMPRESOR',
    MX: 'MIXER',
    RE: 'RETROCARGADORA',
    SR: 'SEMIRREMOLQUE',
    TO: 'TOLVA',
    TP: 'TOPADOR',
    TR: 'TRACTOR',
    VL: 'VOLCADOR'
};

/**
 * Extrae el prefijo alfabético del interno ("TR-20" -> "TR", "CM43" -> "CM").
 * Es la clave con la que se agrupa la flota y se determina la denominación.
 */
export function getPrefijo(interno) {
    const m = String(interno || '').toUpperCase().match(/^[A-Z]+/);
    return m ? m[0] : '';
}

/**
 * Denominación canónica de un equipo. Si el prefijo no está mapeado, cae al TIPO original
 * del Excel (para no perder información de equipos nuevos o atípicos).
 */
export function getDenominacion(interno, tipoExcel = '') {
    const pref = getPrefijo(interno);
    return TIPO_POR_PREFIJO[pref] || normalizeString(tipoExcel) || 'SIN CLASIFICAR';
}

/**
 * Parsea el consumo estimado del Excel de metas, que viene como texto con la unidad
 * incluida: " 3 L/hora ", " 7 L/100km ", " 9.5 L/100km ".
 *
 * La UNIDAD es el dato más valioso de esa planilla: define si el equipo se mide por hora
 * o por distancia. Antes la app ignoraba la unidad y decidía el tipo de cálculo con listas
 * de prefijos hardcodeadas que no coincidían con la realidad (ej: los VL figuraban como
 * L/100Km cuando el área los mide en L/hora, y las BM sin dominio quedaban como "No Aplica"
 * pese a tener meta declarada).
 *
 * @param {any} raw
 * @returns {{valor: Number, unidad: String|null, texto: String}}
 *          unidad: 'L/Hora' | 'L/100Km' | null
 */
export function parseConsumoEstimado(raw) {
    const texto = String(raw == null ? '' : raw).trim();
    if (!texto) return { valor: 0, unidad: null, texto: '' };

    const up = normalizeString(texto);
    let unidad = null;
    if (/\/\s*H/.test(up)) unidad = 'L/Hora';           // "L/HORA", "L/H"
    else if (/K\s*M/.test(up)) unidad = 'L/100Km';      // "L/100KM", "L/KM"

    // Tomar el primer número del texto (soporta "9,5" y "9.5")
    const m = up.match(/(\d+(?:[.,]\d+)?)/);
    const valor = m ? parseFloat(m[1].replace(',', '.')) : 0;

    return { valor: isNaN(valor) ? 0 : valor, unidad, texto };
}

/**
 * Normaliza un string para poder cruzar datos de manera segura
 * @param {String} val 
 * @returns {String} String en mayúsculas, sin espacios extra y sin acentos
 */
export function normalizeString(val) {
    if (!val) return '';
    return String(val)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // quitar acentos
        .toUpperCase()
        .trim();
}

/**
 * Extrae el número de interno y dominio de un string "sucio"
 * Ej: "CM10 JZE578" -> { interno: "CM10", dominio: "JZE578" }
 * Ej: "10" -> { interno: "10", dominio: "" }
 * 
 * @param {String} val 
 * @returns {Object} { interno, dominio }
 */
export function normalizeEquipoKey(interno) {
    if (!interno) return '';
    return normalizeString(interno).replace(/[\s\-_]/g, '').trim();
}

export function extractDataFromString(val) {
    let raw = normalizeString(val);
    if (!raw) return { interno: null, dominio: null, interno_key: null };

    // Separar solo por espacios, NO por guiones
    let parts = raw.split(/\s+/);
    
    let interno, dominio;
    if (parts.length >= 2) {
        interno = parts[0].replace(/-/g, ''); // Quitar guiones del interno (TR-21 -> TR21)
        dominio = parts.slice(1).join('').replace(/-/g, ''); // Quitar guiones del dominio
    } else {
        interno = raw.replace(/-/g, '');
        dominio = null;
    }

    return { 
        interno, 
        dominio, 
        interno_key: normalizeEquipoKey(interno)
    };
}

/**
 * Convierte un valor de Excel (fecha de serie o string) a un Date de Javascript
 * y lo formatea como YYYY-MM-DD
 * @param {any} val 
 * @returns {String} Fecha en formato ISO YYYY-MM-DD o string vacío si es inválida
 */
export function parseDate(val) {
    if (!val) return '';
    
    // Si es un número (número de serie de Excel)
    if (typeof val === 'number') {
        const date = new Date(Math.round((val - 25569) * 86400 * 1000));
        return date.toISOString().split('T')[0];
    }
    
    // Si es string, intentamos parsear "DD/MM/YYYY" o "YYYY-MM-DD"
    if (typeof val === 'string') {
        // Fix: las fechas "Desde:"/"Hasta:" del reporte GPS vienen como "1/1/2026, 0:00"
        // (coma pegada a la fecha, ANTES del espacio que separa la hora). El código
        // anterior solo cortaba por espacio (`.split(' ')[0]`), así que le quedaba la
        // coma pegada: "1/1/2026," -> año "2026," -> fecha final corrupta "2026,-01-01".
        // Esa fecha corrupta se guardaba en TODOS los registros GPS de ese archivo
        // (como `fecha`/`fecha_hasta`), rompiendo la comparación con las fechas de Cargas
        // (formato limpio "YYYY-MM-DD") en calculateAlignedPeriod() y en los filtros por
        // rango de fecha. Ahora se corta por espacio O coma.
        let clean = val.trim().split(/[\s,]+/)[0];

        if (clean.includes('/')) {
            let parts = clean.split('/');
            if (parts.length === 3) {
                // Asumimos DD/MM/YYYY
                let d = parts[0].padStart(2, '0');
                let m = parts[1].padStart(2, '0');
                let y = parts[2];
                // Si el año tiene 2 digitos
                if (y.length === 2) y = "20" + y;
                return `${y}-${m}-${d}`;
            }
        }
        
        // Fallback a Date.parse si es formato ISO o similar
        let d = new Date(clean);
        if (!isNaN(d)) return d.toISOString().split('T')[0];
    }
    
    return '';
}

/**
 * Parsea un número de forma segura (comas a puntos, quita símbolos)
 * @param {any} val 
 * @returns {Number} Número flotante o 0
 */
export function parseNumber(val) {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return val;
    
    let clean = String(val)
        .replace(/[$€]/g, '')
        .replace(/\./g, '') // miles (asumiendo formato hispano)
        .replace(/,/g, '.') // decimales
        .trim();
        
    let num = parseFloat(clean);
    return isNaN(num) ? 0 : num;
}

export function parseDuration(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    let str = String(val).trim();
    if (str.includes(':')) {
        let parts = str.split(':');
        if (parts.length === 3) {
            let h = parseNumber(parts[0]) || 0;
            let m = parseNumber(parts[1]) || 0;
            let s = parseNumber(parts[2]) || 0;
            return h + (m / 60) + (s / 3600);
        }
    }
    return parseNumber(str);
}

/**
 * Convierte un valor de tiempo proveniente del reporte GPS "Resumen de Flota" a horas.
 *
 * Verificado contra archivos reales (ARCHIVOS/Resumen de Flota*.xlsx): SheetJS entrega
 * las columnas "Tiempo en ralentí" / "Tiempo en movimiento" como NÚMERO (fracción de día,
 * el formato interno de horas de Excel), NO como texto "HH:MM:SS". Ej: 1.2330439814814815
 * en "Tiempo en movimiento" para un equipo que recorrió 766km en el mes corresponde a
 * 1.233 * 24 ≈ 29.6 horas (766km / 29.6h ≈ 26 km/h, coherente con un vehículo de trabajo).
 * Si algún export futuro trae el valor como texto "HH:MM:SS", se sigue soportando vía
 * parseDuration().
 *
 * @param {any} val
 * @returns {Number} Horas
 */
export function parseExcelHours(val) {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') {
        return isNaN(val) ? 0 : val * 24;
    }
    const str = String(val).trim();
    if (!str || /^(n\/a|---|na)$/i.test(str)) return 0;
    if (str.includes(':')) return parseDuration(str); // formato "HH:MM:SS"
    const num = parseNumber(str);
    return num ? num * 24 : 0; // string numérico -> también fracción de día
}

export function aggregateHours(horasDict) {
    if (!horasDict || typeof horasDict !== 'object') {
        return { ralenti: 0, movimiento: 0, parado: 0, total: 0 };
    }
    const hr = parseExcelHours(horasDict.ralenti || 0) || 0;
    const hm = parseExcelHours(horasDict.movimiento || 0) || 0;
    const hp = parseExcelHours(horasDict.parado || 0) || 0;
    const total = hr + hm + hp;
    return {
        ralenti: Math.round(hr * 100) / 100,
        movimiento: Math.round(hm * 100) / 100,
        parado: Math.round(hp * 100) / 100,
        total: Math.round(total * 100) / 100
    };
}
