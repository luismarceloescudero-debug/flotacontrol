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
    CA: 'CALDERA',
    CF: 'CARGADORA FRONTAL',
    CH: 'CAMIÓN HIDROGRÚA',
    CL: 'CALOVENTOR',
    CM: 'CAMIONETA',
    CR: 'CARRETÓN',
    LM: 'LIMPIEZA',
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
 * Provincia real de cada centro de costo. No alcanza con "termina en MZA" (PTY = Tunuyán y
 * PSM = San Martín son Mendoza igual, y ALT = Altamira es San Juan pese al nombre) — se usa
 * un mapeo explícito, verificado contra "Equipos HSV SJ-MZA 2026.xlsx": el único equipo real
 * que carga con centro de costo ALT (CF37) figura con UBICACIÓN "SAN JUAN" en el padrón.
 *
 * Sirve para restringir a Mendoza funciones que no deben aplicarse a San Juan sin revisar
 * (ej. el alta automática de códigos nuevos como "oficiales" — ver detectarPrefijosNuevos en
 * diagnostico.js).
 */
export const PROVINCIA_POR_CENTRO_COSTO = {
    PMZA: 'MENDOZA', AMZA: 'MENDOZA', PTY: 'MENDOZA', PSM: 'MENDOZA',
    TMZA: 'MENDOZA', VMZA: 'MENDOZA', LMZA: 'MENDOZA', CMZA: 'MENDOZA', GMZA: 'MENDOZA',
    SJ: 'SAN JUAN', ALT: 'SAN JUAN'
};

export function provinciaDeCentroCosto(centroCosto) {
    const c = normalizeString(centroCosto).replace(/\s+/g, '');
    if (!c) return null;
    return PROVINCIA_POR_CENTRO_COSTO[c] || null;
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
 * Todas las fechas se guardan internamente en formato ISO ("YYYY-MM-DD", para poder
 * ordenar/comparar como texto sin parsear). Para MOSTRAR una fecha en la interfaz, siempre
 * hay que pasarla por acá primero: la app es para una empresa argentina, así que el formato
 * visible tiene que ser DD/MM/AAAA (es-AR), nunca el ISO crudo que se ve en varias tablas.
 * @param {String} iso Fecha en formato "YYYY-MM-DD" (o "YYYY-MM-DDTHH:mm:ss")
 * @returns {String} "DD/MM/AAAA", o el valor original si no matchea el formato esperado.
 */
export function formatFechaAR(iso) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(iso);
    return `${m[3]}/${m[2]}/${m[1]}`;
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
/**
 * Verificado contra archivos reales: el GPS ("Resumen de Flota") exporta el interno sin
 * ceros a la izquierda ("CF1", "TR9"), mientras que el padrón de Equipos lo trae relleno
 * ("CF01", "TR09") para el MISMO equipo físico. Como antes la clave se armaba solo quitando
 * espacios/guiones, "CF1" y "CF01" quedaban como claves distintas y el cruce fallaba: las
 * horas y los km de ese equipo cualquier mes se iban a "huérfanos" en silencio.
 *
 * Se le quita el cero a la izquierda al primer bloque de dígitos (después del prefijo de
 * letras) para que ambas grafías crucen. Lo que venga después de ese bloque (letras extra,
 * más dígitos) se conserva tal cual, así que no confunde equipos realmente distintos:
 * "MX63" y "MX630" no colapsan (ninguno tiene cero a la izquierda) y un sufijo como
 * "MX108VL" no se toca.
 */
export function normalizeEquipoKey(interno) {
    if (!interno) return '';
    const base = normalizeString(interno).replace(/[\s\-_]/g, '').trim();
    return base.replace(/^([A-Z]+)0+(\d)/, '$1$2');
}

/**
 * ¿"a" y "b" difieren en, como mucho, UN carácter (una sustitución, o una letra de más o de
 * menos)? No es una distancia de edición completa (no hace falta: alcanza con distinguir
 * "0 o 1 edición" de "2 o más"), así que corre en una sola pasada por string.
 *
 * Caso real que motivó esto: una carga con interno "GR01" — un chofer que esa semana cargó
 * GE01, GE02 y GE03 (grupos electrógenos reales de Áridos) una sola vez escribió "GR01" en vez
 * de "GE01". El maestro no tiene ningún prefijo "GR" — es del todo ajeno a la nomenclatura de
 * la flota (ver TIPO_POR_PREFIJO) — así que no calzaba ni como "interno nuevo" ni como nada
 * reconocible, y quedaba como huérfano genérico sin ninguna pista de qué pasó en realidad.
 */
function aUnaEdicion(a, b) {
    if (a === b) return false; // idéntico no es "parecido", es el mismo
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    if (la === lb) {
        let dif = 0;
        for (let i = 0; i < la; i++) { if (a[i] !== b[i]) { dif++; if (dif > 1) return false; } }
        return dif === 1;
    }
    const [corta, larga] = la < lb ? [a, b] : [b, a];
    let i = 0, j = 0, edits = 0;
    while (i < corta.length && j < larga.length) {
        if (corta[i] === larga[j]) { i++; j++; }
        else { edits++; if (edits > 1) return false; j++; }
    }
    return true;
}

/**
 * Un código huérfano (sin equipo en el maestro) que está a un solo carácter de un interno REAL
 * del maestro es, con mucha más probabilidad, un error de tipeo que un equipo nuevo — pero SOLO
 * cuando su prefijo no existe en ningún lado de la flota. Si el prefijo ya tiene equipos reales
 * (ej. "CL03" con "CL-01" y "CL-02" ya en el maestro), lo más probable es lo contrario: es el
 * tercer equipo de esa serie, no un tipeo de uno de los dos primeros — un tipeo casi siempre
 * cae, por azar, a una edición de distancia de OTRO número de la misma serie (todos comparten
 * prefijo y largo parecido), así que sin este filtro cualquier alta legítima de un prefijo
 * conocido se marcaría como sospechosa. El caso real que sí tiene que detectarse: "GR01", con
 * un chofer que esa semana cargó GE01/GE02/GE03 y ningún "GR" existe en ningún lado de la
 * nomenclatura de la flota (ver TIPO_POR_PREFIJO) — ahí sí, la única explicación razonable es
 * el tipeo.
 *
 * "El prefijo ya existe en el maestro" no alcanza como filtro: verificado contra datos reales,
 * "CA01" (CALDERA, 11 cargas sostenidas — consumo real, no un tipeo aislado) y "LM02" (LIMPIEZA)
 * también se marcaban como sospechosos de "CF01"/"BM02" porque CA y LM no tienen ningún equipo
 * dado de alta todavía — pero SÍ son categorías reconocidas (están en TIPO_POR_PREFIJO), solo
 * que sin instancia en el maestro. El filtro correcto es más estricto: el prefijo tiene que ser
 * desconocido en cualquier sentido, ni con equipos reales ni como categoría con nombre.
 *
 * Devuelve el interno real más parecido, o null si no aplica. Nunca corrige solo: es una
 * sugerencia para que una persona confirme contra el comprobante, no una asignación automática.
 */
export function sugerirPosibleTypo(codigo, internosReales) {
    const clave = normalizeEquipoKey(codigo);
    if (!clave) return null;
    const prefijo = getPrefijo(clave);
    const prefijoConocido = !!TIPO_POR_PREFIJO[prefijo]
        || internosReales.some(real => getPrefijo(normalizeEquipoKey(real)) === prefijo);
    if (prefijoConocido) return null;
    for (const real of internosReales) {
        const claveReal = normalizeEquipoKey(real);
        if (claveReal && aUnaEdicion(clave, claveReal)) return real;
    }
    return null;
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
    const raw = normalizeString(token).trim();
    if (!raw) return { tipo: 'vacio', valor: '' };

    // Verificado contra Resumen de Flota real: la columna "Unidad" del GPS a veces trae un
    // sufijo extra después de un segundo guión — "MX-108-VL", "MX-63-TK" — donde "VL"/"TK" es
    // un código de sitio o grupo, no parte del equipo. Antes esto rompía de dos formas: al
    // quitar los guiones sin mirar la forma, "MX-108-VL" quedaba "MX108VL", que por longitud
    // coincidía por casualidad con el patrón de patente Mercosur (2 letras+3 números+2 letras)
    // y se clasificaba como DOMINIO falso. Las patentes de esta flota nunca llevan guión (ver
    // Equipos.xlsx: "AF974DX", "OXZ911"...), así que un token con guión nunca se evalúa como
    // patente: se toma como interno (prefijo de letras + primer bloque de 1 a 3 números) y
    // cualquier segmento posterior con guión se descarta como sufijo de sitio/grupo.
    if (raw.includes('-')) {
        const m = raw.match(/^([A-Z]+)-?(\d{1,3})/);
        if (m) return { tipo: 'interno', valor: `${m[1]}${m[2]}` };
    }

    const t = raw.replace(/[\s\-_.]/g, '');
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
        const raw = normalizeString(val);
        if (!raw) return;

        // Se intenta clasificar la celda ENTERA primero (es el caso normal: cada columna trae
        // un solo dato — "TR-21", "AF974DX", o incluso una patente con un espacio de más como
        // "OXZ 911" u "AB 205 QO", que clasificarIdentificador ya sabe limpiar). Solo si eso no
        // da nada reconocible Y la celda tiene más de un token se prueba dividirla por espacios:
        // es el caso de una celda que mezcla dos identificadores juntos, ej. "BM09 JNU923".
        // Fix: antes SIEMPRE se dividía primero, así que una patente con espacio interno se
        // partía en fragmentos ("OXZ" + "911") que por separado no calificaban como nada.
        const entero = clasificarIdentificador(raw);
        if (entero.tipo === 'dominio' || entero.tipo === 'interno') {
            if (entero.tipo === 'dominio' && !dominio) dominio = entero.valor;
            else if (entero.tipo === 'interno' && !interno) interno = entero.valor;
            return;
        }

        const partes = raw.split(/[\s/|]+/).filter(Boolean);
        if (partes.length > 1) {
            partes.forEach(tok => {
                const c = clasificarIdentificador(tok);
                if (c.tipo === 'dominio' && !dominio) dominio = c.valor;
                else if (c.tipo === 'interno' && !interno) interno = c.valor;
                else if (c.tipo === 'desconocido') sueltos.push(c.valor);
            });
        } else if (entero.valor) {
            sueltos.push(entero.valor);
        }
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

    let clean = String(val).replace(/[$€\s]/g, '').trim();
    if (!clean) return 0;

    // El punto es ambiguo: en formato hispano separa miles ("1.234" = mil doscientos treinta y
    // cuatro), pero un archivo exportado con locale inglés lo usa como decimal ("9.5" = nueve y
    // medio). Borrarlo siempre — como se hacía antes — convertía "9.5" en 95: un error de diez
    // veces, silencioso, en litros, importes o precios. Ahora se decide por la forma:
    //   - Si hay coma, la coma manda como decimal y los puntos son miles (hispano puro).
    //   - Si solo hay puntos y la forma es exactamente de miles (1 a 3 dígitos y después grupos
    //     de 3: "1.234", "12.345.678"), se tratan como miles.
    //   - Cualquier otra forma con punto ("9.5", "0.75", "1234.56") es decimal y se respeta.
    if (clean.includes(',')) {
        clean = clean.replace(/\./g, '').replace(/,/g, '.');
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(clean)) {
        clean = clean.replace(/\./g, '');
    }

    const num = parseFloat(clean);
    return isNaN(num) ? 0 : num;
}

/**
 * Duración a horas decimales. Acepta "HH:MM:SS" y también "HH:MM".
 *
 * Antes solo se contemplaba el formato de tres partes; "07:30" caía al parseNumber del final y
 * devolvía 7 — los minutos se perdían sin aviso, que en un total de horas de motor es el tipo de
 * error que nadie nota hasta que las cuentas no cierran. Hoy los archivos reales traen estas
 * columnas como número (ver parseExcelHours), así que esto es defensa para un export futuro.
 */
export function parseDuration(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    let str = String(val).trim();

    // "3 days, 10:53:03" / "1 day, 5:00:00" — así exporta el Resumen de Flota cuando el
    // reporte abarca varios meses (ej. "Resumen de Flota Ene-Jul"), a diferencia de los
    // archivos mensuales, que traen fracción de día de Excel. Sin contemplarlo, el split por
    // ":" partía "3 days, 10" como si fuera la hora y se perdían los días enteros: 82,9 hs
    // reales se leían como 10,9 hs (o peor), y el consumo del equipo salía por las nubes
    // porque los litros quedaban divididos por una fracción de las horas que trabajó.
    let dias = 0;
    const mDias = str.match(/^\s*(\d+(?:[.,]\d+)?)\s*(?:d|d[íi]as?|days?)\b[\s,]*/i);
    if (mDias) {
        dias = parseFloat(mDias[1].replace(',', '.')) || 0;
        str = str.slice(mDias[0].length).trim();
    }

    if (str.includes(':')) {
        const parts = str.split(':');
        if (parts.length === 3 || parts.length === 2) {
            const h = parseNumber(parts[0]) || 0;
            const m = parseNumber(parts[1]) || 0;
            const s = parts.length === 3 ? (parseNumber(parts[2]) || 0) : 0;
            return dias * 24 + h + (m / 60) + (s / 3600);
        }
    }
    if (dias) return dias * 24 + (str ? (parseNumber(str) || 0) : 0);
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
    // "HH:MM:SS" y también "3 days, 10:53:03" / "2 días 4:15:00" (formato del Resumen de Flota
    // consolidado de varios meses): parseDuration ya devuelve HORAS en los dos casos.
    if (str.includes(':') || /\b(d|d[íi]as?|days?)\b/i.test(str)) return parseDuration(str);
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

/**
 * Clave de identidad EXACTA de una carga de combustible: equipo, fecha, litros, importe,
 * precio unitario, combustible, lugar de carga, centro de costo y chofer.
 *
 * Dos cargas reales del mismo equipo el mismo día no coinciden hasta el centavo y el litro
 * con un decimal: cuando esta clave se repite, es la misma fila entrada dos veces. Se usa en
 * los dos extremos del sistema y por eso vive acá, en un solo lugar:
 *   - database.js la usa al IMPORTAR, para descartar la copia antes de que llegue a los
 *     totales (incluyendo el caso de volver a subir un archivo ya procesado sin limpiar).
 *   - diagnostico.js usa el mismo criterio al AUDITAR, para poder informar cuántas se
 *     descartaron y que el número coincida con lo que efectivamente se descartó.
 *
 * Ojo: coincidir en equipo + fecha + litros pero NO en el resto (otro importe, otro lugar,
 * otro chofer) es un caso distinto — puede ser legítimo (dos surtidores el mismo día) y no
 * se toca solo. Eso se sigue reportando como "posible repetida" para decidir a mano.
 */
/**
 * Clave de identidad EXACTA de un registro de Resumen de Flota (GPS): equipo, rango del
 * reporte, km y horas. Un mes de GPS del mismo equipo con exactamente los mismos km y las
 * mismas horas es el mismo reporte importado dos veces — sumarlo duplicaría la actividad y,
 * al dividir los litros por el doble de horas, mostraría el equipo consumiendo la mitad.
 */
export function claveGpsExacta(g) {
    const txt = (v) => String(v == null ? '' : v).trim().toUpperCase();
    const h = g.horas && typeof g.horas === 'object' ? g.horas : {};
    const n2 = (v) => Math.round((parseFloat(v) || 0) * 100);
    return [
        txt(g.interno_key || g.interno),
        g.fecha || '',
        g.fecha_hasta || '',
        n2(g.distancia),
        n2(h.ralenti), n2(h.movimiento), n2(h.parado)
    ].join('|');
}

export function claveCargaExacta(c) {
    const txt = (v) => String(v == null ? '' : v).trim().toUpperCase();
    const cent = (v) => Math.round((parseFloat(v) || 0) * 100);
    return [
        txt(c.interno_key || c.interno),
        c.fecha || '',
        Math.round((parseFloat(c.litros) || 0) * 10),
        cent(c.importe),
        cent(c.precio_unitario),
        txt(c.combustible),
        txt(c.lugar_carga),
        txt(c.centro_costo),
        txt(c.chofer)
    ].join('|');
}
