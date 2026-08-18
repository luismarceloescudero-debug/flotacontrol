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
 * Provincia, centro de costo y lugar de carga.
 *
 * La columna UBICACIÓN del Excel de Equipos ya viene como "MENDOZA" / "SAN JUAN", así que
 * getProvincia() solo agrupa las variantes raras (VENDIDO, FUERA DE SERVICIO, MALARGÜE...)
 * bajo "OTRA/BAJA" para no ensuciar el filtro principal.
 *
 * Ni el CENTRO DE COSTO ni el LUGAR DE CARGA son un atributo fijo del equipo: van de las
 * cargas de combustible (Cargas_Combustible*.xlsx), no del padrón de Equipos. Un mismo interno
 * puede repartirse entre varios (ej: TR32 carga tanto para CEMENTO como para ÁRIDOS, con
 * distinto centro de costo cada vez), así que se usa el que más se repite entre SUS cargas del
 * período y se guarda el desglose completo para poder mostrarlo. Mapeo verificado contra
 * "Cargas_Combustible_HSV_2026.xlsx" (3.996 filas, 11 códigos de centro de costo y 9 lugares
 * de carga reales).
 */
export const PROVINCIAS = ['MENDOZA', 'SAN JUAN'];

export function getProvincia(ubicacion) {
    const u = normalizeString(ubicacion);
    if (u.includes('MENDOZA')) return 'MENDOZA';
    if (u.includes('SAN JUAN')) return 'SAN JUAN';
    if (!u) return 'SIN DATO';
    return 'OTRA'; // MALARGÜE, VENDIDO, FUERA DE SERVICIO, etc.
}

export const NOMBRE_POR_CENTRO_COSTO = {
    PMZA: 'Godoy Cruz (planta)',
    AMZA: 'Áridos',
    PTY: 'Tunuyán',
    PSM: 'San Martín',
    TMZA: 'Taller Mendoza',
    VMZA: 'Ventas Mendoza',
    LMZA: 'Laboratorio Mendoza',
    CMZA: 'Compras Mendoza',
    GMZA: 'Gerencia Mendoza',
    SJ: 'San Juan',
    ALT: 'Altamira'
};

/** Nombre legible de un centro de costo a partir de su código; si no está mapeado, muestra el código tal cual para no perder equipos de centros nuevos. */
export function getNombreCentroCosto(centroCosto) {
    const c = normalizeString(centroCosto).replace(/\s+/g, '');
    if (!c) return '';
    return NOMBRE_POR_CENTRO_COSTO[c] || c;
}

/**
 * Clasifica un LUGAR DE CARGA (columna del Excel de Cargas) como sede propia (carga a granel,
 * bandera YPF) o estación de servicio de terceros (bandera Axion). Corregido a mano por HSV
 * contra los 9 valores reales de "Cargas_Combustible_HSV_2026.xlsx" — el nombre del lugar NO
 * alcanza para deducirlo solo (ej: "GRIS" es una estación Axion pese a no tener "estación" ni
 * "GNC" en el nombre, y "SAN JUAN (EXTERNO)" es una sede principal pese a tener "EXTERNO" en
 * el nombre), así que se usa una lista explícita en vez de un patrón de texto:
 *
 *  - SEDE (a granel, YPF — Infinia Diesel, YPF 500): Godoy Cruz, Tunuyán, San Martín, Áridos,
 *    Altamira, San Juan (Externo). San Juan (Externo) es sede principal al mismo nivel que
 *    Mendoza — el "(Externo)" del nombre es solo porque queda fuera del predio de Mendoza,
 *    no porque sea una estación de terceros.
 *  - ESTACIÓN DE SERVICIO (Axion — Quantium Diesel, Quantium Nafta, Nafta Super, X10): Gris,
 *    EE SS Coronel Díaz, GNC Godoy Cruz.
 *
 * Un lugar nuevo que no esté en ninguna de las dos listas se clasifica como "Sede" por
 * default (para no marcar de más), pero conviene revisar y sumarlo a la lista correcta.
 */
const LUGARES_ESTACION_SERVICIO = new Set(['GRIS', 'EE SS CORONEL DIAZ', 'GNC GODOY CRUZ']);

export function tipoLugarCarga(lugar) {
    const u = normalizeString(lugar);
    if (!u) return '';
    return LUGARES_ESTACION_SERVICIO.has(u) ? 'Estación de servicio' : 'Sede';
}

/**
 * Bandera de combustible a partir del TIPO DE COMBUSTIBLE de la carga. Verificado contra los
 * 7 valores reales: INFINIA DIESEL e YPF 500/YPF500 son de sedes propias (bandera YPF);
 * QUANTIUM DIESEL, QUANTIUM NAFTA, NAFTA SUPER y X10 son de estaciones Axion. Coincide con
 * tipoLugarCarga() (una sede carga YPF, una estación de servicio carga Axion) pero se calcula
 * aparte porque viene de una columna distinta y puede haber excepciones sueltas.
 */
const COMBUSTIBLES_YPF = new Set(['INFINIA DIESEL', 'YPF 500', 'YPF500']);
const COMBUSTIBLES_AXION = new Set(['QUANTIUM DIESEL', 'QUANTIUM NAFTA', 'NAFTA SUPER', 'X10']);

export function getBandera(combustible) {
    const u = normalizeString(combustible);
    if (!u) return '';
    if (COMBUSTIBLES_YPF.has(u)) return 'YPF';
    if (COMBUSTIBLES_AXION.has(u)) return 'Axion';
    return '';
}

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
/**
 * Descompone una fecha ISO (YYYY-MM-DD) en sus partes, para poder filtrar y agrupar por
 * día, mes o año sin volver a parsear el string en cada cálculo.
 */
export function partesFecha(iso) {
    if (!iso || typeof iso !== 'string' || iso.length < 7) return { anio: null, mes: null, dia: null, ym: null };
    const [a, m, d] = iso.split('-');
    return {
        anio: parseInt(a, 10) || null,
        mes: parseInt(m, 10) || null,
        dia: parseInt(d, 10) || null,
        ym: a && m ? `${a}-${m}` : null
    };
}

export const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** Convierte un nombre de columna del Excel en una clave estable. */
export function slugCampo(nombre) {
    return normalizeString(nombre)
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase() || 'campo';
}

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

/**
 * Clasifica un token suelto como DOMINIO (patente) o INTERNO.
 *
 * Patentes argentinas:
 *   - Formato viejo:     3 letras + 3 números   (JNU923, HHA905)
 *   - Formato Mercosur:  2 letras + 3 números + 2 letras (AF809IC, AD031FG)
 * Internos de la flota: 2 o más letras + 1 a 3 números (TR20, CM43, BM09, AE01).
 *
 * Distinguirlos importa porque en las planillas vienen mezclados en una sola celda
 * ("BM09 JNU923") o repartidos en columnas distintas según el archivo.
 */
export function clasificarIdentificador(token) {
    const t = normalizeString(token).replace(/[\s\-_.]/g, '');
    if (!t) return { tipo: 'vacio', valor: '' };
    if (/^[A-Z]{3}\d{3}$/.test(t)) return { tipo: 'dominio', valor: t };        // JNU923
    if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(t)) return { tipo: 'dominio', valor: t }; // AF809IC
    if (/^[A-Z]{2,}\d{1,3}$/.test(t)) return { tipo: 'interno', valor: t };      // TR20, BM09
    return { tipo: 'desconocido', valor: t };
}

/**
 * Extrae INTERNO y DOMINIO a partir de uno o varios valores crudos de una fila.
 *
 * Este es el "común denominador" de todo el sistema: hay equipos que en una planilla figuran
 * solo por interno y en otra solo por patente. Guardando ambas claves normalizadas, el cruce
 * funciona con cualquiera de las dos y deja de perder registros.
 *
 * @param  {...any} valores  Celdas candidatas (ej: "BM09 JNU923", "BM-09", "JNU923")
 * @returns {{interno, dominio, interno_key, dominio_key}}
 */
export function extraerIdentidad(...valores) {
    let interno = '', dominio = '', sueltos = [];

    valores.filter(Boolean).forEach(val => {
        normalizeString(val).split(/[\s/|]+/).filter(Boolean).forEach(tok => {
            const c = clasificarIdentificador(tok);
            if (c.tipo === 'dominio' && !dominio) dominio = c.valor;
            else if (c.tipo === 'interno' && !interno) interno = c.valor;
            else if (c.tipo === 'desconocido') sueltos.push(c.valor);
        });
    });

    // Si no se pudo clasificar nada (códigos atípicos como "CALDERA", "DEMO"), se usa el
    // primer token como interno para no descartar la fila: son consumos reales que hay que
    // poder ver aunque su código no siga la nomenclatura.
    if (!interno && !dominio && sueltos.length) interno = sueltos[0];

    return {
        interno,
        dominio,
        interno_key: normalizeEquipoKey(interno),
        dominio_key: normalizeEquipoKey(dominio)
    };
}

/**
 * Clave de cruce preferida de un registro: el interno si existe, si no la patente.
 * Sirve para agrupar cuando no hay maestro contra el cual resolver.
 */
export function claveDe(idOrRecord) {
    const o = idOrRecord || {};
    return o.interno_key || o.dominio_key || '';
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
