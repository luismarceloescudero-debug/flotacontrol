/**
 * Importador de planillas.
 *
 * Reconoce cuatro formatos conocidos (Equipos, Cargas, Resumen de Flota, Consumos Estimados)
 * y acepta CUALQUIER otra planilla mediante un importador genérico, con la única condición de
 * que tenga una columna que identifique al equipo por interno o por dominio. Eso permite
 * sumar cubiertas, insumos, filtros o lo que venga después sin tocar el código.
 *
 * Dos decisiones de diseño importantes:
 *  1. INTERNO + DOMINIO como doble clave. Hay planillas que traen solo el interno y otras
 *     solo la patente; guardando ambas normalizadas, el cruce contra el maestro funciona con
 *     cualquiera de las dos y dejan de perderse registros.
 *  2. Se preservan TODAS las columnas originales en `datos`. Los campos que el sistema
 *     entiende (litros, km, horas...) se extraen aparte, pero nada del Excel se descarta.
 */
import {
    upsertEquipos, insertRawRecords, insertEstimados, insertPrecios, registrarArchivo, getMapeo
} from '../data/database.js';
import {
    parseDate, parseNumber, normalizeString, normalizeEquipoKey, aggregateHours,
    getDenominacion, parseConsumoEstimado, extraerIdentidad, partesFecha, slugCampo
} from '../data/normalizer.js';

// Nombres de columna que identifican al equipo, en orden de preferencia.
const COLS_IDENTIDAD = ['INTERNO-DOMINIO', 'INTERNO', 'UNIDAD', 'MOVIL', 'EQUIPO', 'DOMINIO', 'PATENTE', 'MATRICULA', 'VEHICULO'];

export async function parseXLSX(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                resolve(await procesarLibro(new Uint8Array(e.target.result), file.name));
            } catch (err) { reject(err); }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

async function procesarLibro(data, filename) {
    const workbook = XLSX.read(data, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
    if (!rawRows.length) throw new Error('El archivo está vacío');

    const det = detectarFormato(rawRows, filename);
    if (det.headerRowIdx === -1) {
        return await registrar({ filename, tipo: 'DESCONOCIDO', filas: 0, motivo: 'No se encontró una fila de encabezados con una columna de interno o dominio.' });
    }

    const headers = extraerHeaders(rawRows[det.headerRowIdx]);
    const filas = filasComoObjetos(rawRows, det.headerRowIdx, headers);

    // Mapeo guardado por el usuario para este tipo (si corrigió alguna columna alguna vez).
    const mapeoGuardado = await getMapeo(det.tipo).catch(() => null);
    const mapeo = (mapeoGuardado && mapeoGuardado.columnas) || {};

    let n = 0;
    if (det.tipo === 'EQUIPOS') n = await handleEquipos(filas, filename, mapeo);
    else if (det.tipo === 'ESTIMADOS') n = await handleEstimados(filas, filename, mapeo);
    else if (det.tipo === 'CARGAS') { n = await handleCargas(filas, filename, mapeo); await handlePrecios(workbook, filename); }
    else if (det.tipo === 'GPS') n = await handleGPS(filas, filename, det.desde, det.hasta, mapeo);
    else n = await handleGenerico(filas, filename, det, mapeo);

    return await registrar({
        filename, tipo: det.tipo, etiqueta: det.etiqueta, filas: n,
        columnas: headers.filter(Boolean),
        periodo_desde: det.desde || null, periodo_hasta: det.hasta || null
    });
}

async function registrar(meta) {
    meta.procesado = new Date().toISOString();
    await registrarArchivo(meta);
    console.log(`[${meta.tipo}] ${meta.filename}: ${meta.filas} filas`);
    return meta;
}

// ---------------------------------------------------------------- detección

function detectarFormato(rawRows, filename) {
    const out = { tipo: 'UNKNOWN', etiqueta: '', headerRowIdx: -1, desde: null, hasta: null };
    const limite = Math.min(15, rawRows.length);

    for (let i = 0; i < limite; i++) {
        const t = normalizeString(rawRows[i].join('|'));

        if (out.headerRowIdx === -1) {
            if (t.includes('CONSUMO ESTIMADO')) { out.tipo = 'ESTIMADOS'; out.etiqueta = 'Consumos Estimados'; out.headerRowIdx = i; }
            else if (t.includes('LITROS') && t.includes('LUGAR DE CARGA')) { out.tipo = 'CARGAS'; out.etiqueta = 'Cargas de Combustible'; out.headerRowIdx = i; }
            else if (t.includes('TIPO') && t.includes('MARCA') && t.includes('POTENCIA') && t.includes('INTERNO')) { out.tipo = 'EQUIPOS'; out.etiqueta = 'Equipos'; out.headerRowIdx = i; }
            else if (t.includes('KILOMETROS RECORRIDOS') || t.includes('TIEMPO EN MOVIMIENTO')) { out.tipo = 'GPS'; out.etiqueta = 'Resumen de Flota (GPS)'; out.headerRowIdx = i; }
        }
        // Los metadatos de período del reporte GPS pueden estar antes o después del encabezado.
        const c0 = normalizeString(rawRows[i][0]);
        if (c0.includes('DESDE')) out.desde = parseDate(rawRows[i][1]);
        if (c0.includes('HASTA')) out.hasta = parseDate(rawRows[i][1]);
    }

    if (out.headerRowIdx !== -1) return out;

    // ---- Importador genérico: buscar la primera fila que tenga una columna de identidad ----
    for (let i = 0; i < limite; i++) {
        const celdas = rawRows[i].map(c => normalizeString(c).replace(/\s+/g, ''));
        const tieneId = celdas.some(c => c && COLS_IDENTIDAD.some(k => c.includes(k.replace(/[\s-]/g, ''))));
        const suficientes = celdas.filter(Boolean).length >= 2;
        if (tieneId && suficientes) {
            out.tipo = slugCampo(filename.replace(/\.(xlsx|xls|csv)$/i, '').replace(/[\d_\-.]+$/g, ''));
            out.etiqueta = tituloDesdeArchivo(filename);
            out.headerRowIdx = i;
            return out;
        }
    }
    return out;
}

function tituloDesdeArchivo(filename) {
    const limpio = filename
        .replace(/\.(xlsx|xls|csv)$/i, '')
        .replace(/[_]+/g, ' ')
        .replace(/\s*\d{4}\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    // Un archivo bajado de un sistema puede llegar con un nombre opaco (un hash, un id largo
    // sin vocales ni espacios). Usarlo como etiqueta de la pestaña deja al usuario mirando
    // "286d98d10cb2f87e2d217e0362aad59e" sin saber qué subió: mejor un nombre honesto.
    const opaco = !limpio
        || (limpio.length >= 16 && !/\s/.test(limpio) && (/^[0-9a-f]+$/i.test(limpio) || !/[AEIOUaeiou]/.test(limpio)));
    return opaco ? 'Otra planilla' : limpio;
}

/** Encabezados normalizados; las columnas repetidas se numeran para que no se pisen. */
function extraerHeaders(fila) {
    const cuenta = {};
    return fila.map(h => {
        const base = normalizeString(h).trim();
        if (!base) return '';
        cuenta[base] = (cuenta[base] || 0) + 1;
        return cuenta[base] === 1 ? base : `${base}_${cuenta[base]}`;
    });
}

function filasComoObjetos(rawRows, headerRowIdx, headers) {
    const out = [];
    for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
        const obj = {};
        let hayDatos = false;
        for (let j = 0; j < headers.length; j++) {
            if (!headers[j]) continue;
            obj[headers[j]] = rawRows[i][j];
            if (rawRows[i][j] !== '' && rawRows[i][j] !== null) hayDatos = true;
        }
        if (hayDatos) out.push(obj);
    }
    return out;
}

// ---------------------------------------------------------------- helpers de fila

/** Busca un valor por nombre de columna, respetando primero el mapeo elegido por el usuario. */
function val(row, campo, candidatos, mapeo) {
    if (mapeo && mapeo[campo] && row[mapeo[campo]] !== undefined) return row[mapeo[campo]];
    return getValFuzzy(row, candidatos);
}

function getValFuzzy(row, possibleKeys) {
    const keys = Object.keys(row).map(k => ({ original: k, norm: normalizeString(k).replace(/\s+/g, '') }));
    for (const pk of possibleKeys) {
        const normPk = normalizeString(pk).replace(/\s+/g, '');
        const m = keys.find(rk => rk.norm.includes(normPk));
        if (m) return row[m.original];
    }
    return null;
}

/** Identidad (interno + dominio) de una fila, mirando todas las columnas candidatas. */
function identidadDeFila(row, mapeo) {
    const candidatas = [];
    if (mapeo && mapeo.interno && row[mapeo.interno] !== undefined) candidatas.push(row[mapeo.interno]);
    if (mapeo && mapeo.dominio && row[mapeo.dominio] !== undefined) candidatas.push(row[mapeo.dominio]);
    COLS_IDENTIDAD.forEach(c => {
        const v = getValFuzzy(row, [c]);
        if (v) candidatas.push(v);
    });
    return extraerIdentidad(...candidatas);
}

/** Campos comunes a todo movimiento: identidad, fecha desglosada y columnas originales. */
function baseMovimiento(row, id, fecha, filename) {
    const p = partesFecha(fecha);
    return {
        interno: id.interno,
        dominio: id.dominio,
        interno_key: id.interno_key,
        dominio_key: id.dominio_key,
        fecha,
        anio: p.anio,
        mes: p.mes,
        dia: p.dia,
        periodo: p.ym,
        datos: { ...row },   // todas las columnas del Excel, sin descartar nada
        source_file: filename
    };
}

// ---------------------------------------------------------------- maestro

async function handleEquipos(filas, filename, mapeo) {
    const porKey = new Map();

    filas.forEach(row => {
        const id = identidadDeFila(row, mapeo);
        if (!id.interno && !id.dominio) return;

        const interno = id.interno || id.dominio;
        const key = normalizeEquipoKey(interno);
        const marca = normalizeString(val(row, 'marca', ['MARCA'], mapeo)) || '';
        const modelo = normalizeString(val(row, 'modelo', ['MODELO'], mapeo)) || '';
        const tipoExcel = val(row, 'tipo', ['TIPO', 'CATEGORIA'], mapeo);
        // POTENCIA y CAPACIDAD vienen como texto libre con la unidad incluida ("310 HP",
        // "440 KVA", "25 M3", "30 TN", "6X4"...), sin un formato único: se guardan tal cual,
        // no se intenta parsear un número suelto.
        const potencia = normalizeString(val(row, 'potencia', ['POTENCIA'], mapeo)) || '';
        const capacidad = normalizeString(val(row, 'capacidad', ['CAPACIDAD'], mapeo)) || '';

        const prev = porKey.get(key);
        if (!prev) {
            porKey.set(key, {
                interno,
                interno_key: key,
                dominio: id.dominio,
                dominio_key: id.dominio_key,
                denominacion: getDenominacion(interno, tipoExcel),
                marca, modelo,
                potencia, capacidad,
                tipo: normalizeString(tipoExcel) || '',
                ubicacion: normalizeString(val(row, 'ubicacion', ['UBICACION'], mapeo)) || '',
                anio: parseNumber(val(row, 'anio', ['ANO', 'AÑO'], mapeo)) || null,
                origen: [filename]
            });
        } else {
            // El Excel lista cada bomba dos veces (chasis con dominio + equipo bomba sin él).
            // Se fusionan para no perder la patente ni el modelo del equipo montado.
            prev.dominio = prev.dominio || id.dominio;
            prev.dominio_key = prev.dominio_key || id.dominio_key;
            prev.marca = unirDistinto(prev.marca, marca);
            prev.modelo = unirDistinto(prev.modelo, modelo);
            prev.potencia = unirDistinto(prev.potencia, potencia);
            prev.capacidad = unirDistinto(prev.capacidad, capacidad);
        }
    });

    const equipos = [...porKey.values()];
    if (equipos.length) await upsertEquipos(equipos);
    return equipos.length;
}

/**
 * Los consumos estimados se escriben SOBRE el maestro (misma fila del equipo), no en una
 * tabla aparte. Si el equipo todavía no existe (se subió esta planilla primero), se crea la
 * fila igual: el orden en que se carguen los archivos no debe importar.
 */
async function handleEstimados(filas, filename, mapeo) {
    const equipos = [];
    const legacy = [];

    filas.forEach(row => {
        const id = identidadDeFila(row, mapeo);
        if (!id.interno && !id.dominio) return;

        const interno = id.interno || id.dominio;
        const p = parseConsumoEstimado(val(row, 'meta', ['CONSUMO ESTIMADO', 'ESTIMADO', 'META'], mapeo));
        const tipoExcel = val(row, 'tipo', ['TIPO'], mapeo);

        equipos.push({
            interno,
            interno_key: normalizeEquipoKey(interno),
            dominio: id.dominio,
            dominio_key: id.dominio_key,
            denominacion: getDenominacion(interno, tipoExcel),
            marca: normalizeString(val(row, 'marca', ['MARCA'], mapeo)) || '',
            modelo: normalizeString(val(row, 'modelo', ['MODELO'], mapeo)) || '',
            meta_valor: p.valor,
            meta_unidad: p.unidad,
            meta_texto: p.texto,
            origen: [filename]
        });

        legacy.push({
            interno, interno_key: normalizeEquipoKey(interno),
            consumo_estimado: p.texto, consumo_estimado_valor: p.valor,
            consumo_estimado_unidad: p.unidad, source_file: filename
        });
    });

    if (equipos.length) {
        await upsertEquipos(equipos);
        await insertEstimados(legacy); // compatibilidad con la vista de tablas anterior
    }
    return equipos.length;
}

function unirDistinto(a, b) {
    if (!b) return a;
    if (!a) return b;
    if (a.includes(b) || b.includes(a)) return a.length >= b.length ? a : b;
    return `${a} / ${b}`;
}

// ---------------------------------------------------------------- movimientos

async function handleCargas(filas, filename, mapeo) {
    const recs = [];
    filas.forEach(row => {
        const id = identidadDeFila(row, mapeo);
        if (!id.interno && !id.dominio) return;

        const fecha = parseDate(val(row, 'fecha', ['FECHA', 'DATE'], mapeo));
        recs.push({
            ...baseMovimiento(row, id, fecha, filename),
            type: 'carga',
            type_label: 'Cargas de Combustible',
            litros: parseNumber(val(row, 'litros', ['LITROS', 'CANTIDAD'], mapeo)),
            importe: parseNumber(val(row, 'importe', ['COSTO TOTAL', 'IMPORTE', 'MONTO'], mapeo)),
            precio_unitario: parseNumber(val(row, 'precio', ['PRECIO UNITARIO'], mapeo)),
            combustible: normalizeString(val(row, 'combustible', ['TIPO DE COMBUSTIBLE'], mapeo)) || '',
            chofer: normalizeString(val(row, 'chofer', ['CHOFER'], mapeo)) || '',
            sector: normalizeString(val(row, 'sector', ['SECTOR'], mapeo)) || '',
            centro_costo: normalizeString(val(row, 'centro_costo', ['CENTRO DE COSTO', 'C. COSTO'], mapeo)) || '',
            lugar_carga: normalizeString(val(row, 'lugar', ['LUGAR DE CARGA', 'LUGAR', 'SURTIDOR'], mapeo)) || ''
        });
    });
    if (recs.length) await insertRawRecords(recs);
    return recs.length;
}

async function handleGPS(filas, filename, desde, hasta, mapeo) {
    const recs = [];
    filas.forEach(row => {
        const id = identidadDeFila(row, mapeo);
        if (!id.interno && !id.dominio) return;

        // El reporte trae dos columnas de tiempo (ralentí y movimiento) como fracción de día
        // de Excel. aggregateHours() las suma y las convierte a horas reales.
        const horas = aggregateHours({
            ralenti: val(row, 'ralenti', ['TIEMPO EN RALENTI', 'RALENTI'], mapeo),
            movimiento: val(row, 'movimiento', ['TIEMPO EN MOVIMIENTO', 'HORAS', 'HS'], mapeo),
            parado: val(row, 'parado', ['TIEMPO PARADO', 'TIEMPO DETENIDO'], mapeo)
        });

        const fecha = parseDate(val(row, 'fecha', ['FECHA'], mapeo)) || desde || '';
        recs.push({
            ...baseMovimiento(row, id, fecha, filename),
            type: 'gps',
            type_label: 'Resumen de Flota (GPS)',
            fecha_hasta: hasta || null,
            distancia: parseNumber(val(row, 'km', ['KILOMETROS RECORRIDOS', 'KILOMETROS', 'DISTANCIA'], mapeo)),
            horas,
            odometro: parseNumber(val(row, 'odometro', ['ODOMETRO'], mapeo)),
            horometro: parseNumber(val(row, 'horometro', ['HOROMETRO'], mapeo)),
            grupo: normalizeString(val(row, 'grupo', ['GRUPO'], mapeo)) || ''
        });
    });
    if (recs.length) await insertRawRecords(recs);
    return recs.length;
}

/**
 * Importador genérico: cubiertas, insumos, filtros y cualquier planilla futura.
 * Guarda todas las columnas, detecta automáticamente la fecha y las columnas numéricas
 * (para poder sumarlas), y cruza por interno o dominio contra el maestro.
 */
async function handleGenerico(filas, filename, det, mapeo) {
    const recs = [];
    filas.forEach(row => {
        const id = identidadDeFila(row, mapeo);
        if (!id.interno && !id.dominio) return;

        const fecha = parseDate(val(row, 'fecha', ['FECHA', 'DATE', 'DIA'], mapeo)) || '';
        const numericos = {};
        Object.entries(row).forEach(([col, v]) => {
            if (v === '' || v === null || v === undefined) return;
            const n = typeof v === 'number' ? v : parseNumber(v);
            // Solo se toma como métrica si el valor original era realmente numérico.
            if (n !== 0 && (typeof v === 'number' || /^[\d.,\s$]+$/.test(String(v)))) {
                numericos[slugCampo(col)] = n;
            }
        });

        recs.push({
            ...baseMovimiento(row, id, fecha, filename),
            type: det.tipo,
            type_label: det.etiqueta,
            numericos
        });
    });
    if (recs.length) await insertRawRecords(recs);
    return recs.length;
}

async function handlePrecios(workbook, filename) {
    const hoja = workbook.SheetNames.find(n => normalizeString(n).includes('PRECIO'));
    if (!hoja) return;
    try {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[hoja], { header: 1, defval: '' });
        const precios = [];
        for (let i = 1; i < rows.length; i++) {
            const tipo = normalizeString(rows[i][0]);
            const precio = parseNumber(rows[i][1]);
            if (tipo && precio > 0) precios.push({ combustible: tipo, precio, source_file: filename });
        }
        if (precios.length) await insertPrecios(precios);
    } catch (e) {
        console.warn('No se pudo leer la hoja de Precios:', e);
    }
}
