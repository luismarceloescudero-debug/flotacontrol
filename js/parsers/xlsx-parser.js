/**
 * XLSX Parser wrapper using SheetJS
 * Maneja 4 formatos: Equipos, Cargas de Combustible, GPS (Resumen de Flota), Consumos Estimados.
 */
import { insertEquipos, insertRawRecords, insertEstimados, insertPrecios, registrarArchivo } from '../data/database.js';
import {
    extractDataFromString, parseDate, parseNumber, normalizeString,
    normalizeEquipoKey, aggregateHours, getDenominacion, parseConsumoEstimado
} from '../data/normalizer.js';

export async function parseXLSX(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

                const rawRows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
                if (rawRows.length === 0) throw new Error('Excel vacío');

                let fileType = 'UNKNOWN';
                let headerRowIdx = -1;

                // 1. Consumos Estimados
                for (let i = 0; i < Math.min(5, rawRows.length); i++) {
                    if (normalizeString(rawRows[i].join('|')).includes('CONSUMO ESTIMADO')) {
                        fileType = 'ESTIMADOS';
                        headerRowIdx = i;
                        break;
                    }
                }

                // 2. Cargas de Combustible
                if (fileType === 'UNKNOWN') {
                    for (let i = 0; i < Math.min(5, rawRows.length); i++) {
                        const t = normalizeString(rawRows[i].join('|'));
                        if (t.includes('LITROS') && t.includes('LUGAR DE CARGA')) {
                            fileType = 'CARGAS';
                            headerRowIdx = i;
                            break;
                        }
                    }
                }

                // 3. Equipos
                if (fileType === 'UNKNOWN') {
                    for (let i = 0; i < Math.min(10, rawRows.length); i++) {
                        const t = normalizeString(rawRows[i].join('|'));
                        if (t.includes('TIPO') && t.includes('MARCA') && t.includes('POTENCIA') && t.includes('INTERNO')) {
                            fileType = 'EQUIPOS';
                            headerRowIdx = i;
                            break;
                        }
                    }
                }

                let gpsDesde = null;
                let gpsHasta = null;

                // 4. GPS / Resumen de Flota
                if (fileType === 'UNKNOWN') {
                    for (let i = 0; i < Math.min(12, rawRows.length); i++) {
                        const t = normalizeString(rawRows[i].join('|'));
                        if (headerRowIdx === -1 && (t.includes('KILOMETROS RECORRIDOS') || t.includes('TIEMPO EN MOVIMIENTO'))) {
                            fileType = 'GPS';
                            headerRowIdx = i;
                        }
                        const c0 = normalizeString(rawRows[i][0]);
                        if (c0.includes('DESDE')) gpsDesde = parseDate(rawRows[i][1]);
                        if (c0.includes('HASTA')) gpsHasta = parseDate(rawRows[i][1]);
                    }
                }

                if (headerRowIdx === -1) {
                    console.warn('No se pudo detectar el formato del archivo:', file.name);
                    resolve({ tipo: 'DESCONOCIDO', filas: 0, archivo: file.name });
                    return;
                }

                // Encabezados. Las columnas repetidas (el Excel de Equipos trae "TIPO" dos
                // veces) se renombran TIPO, TIPO_2... para que la segunda no pise a la primera.
                const headerCounts = {};
                const headers = rawRows[headerRowIdx].map(h => {
                    const base = normalizeString(h).trim();
                    if (!base) return base;
                    headerCounts[base] = (headerCounts[base] || 0) + 1;
                    return headerCounts[base] === 1 ? base : `${base}_${headerCounts[base]}`;
                });

                const jsonData = [];
                for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
                    const obj = {};
                    let hasData = false;
                    for (let j = 0; j < headers.length; j++) {
                        if (headers[j]) {
                            obj[headers[j]] = rawRows[i][j];
                            if (rawRows[i][j] !== '') hasData = true;
                        }
                    }
                    if (hasData) jsonData.push(obj);
                }

                let filas = 0;
                if (fileType === 'EQUIPOS') filas = await handleEquipos(jsonData, file.name);
                else if (fileType === 'CARGAS') {
                    filas = await handleCargas(jsonData, file.name);
                    await handlePrecios(workbook, file.name); // 2da hoja "Precios", si existe
                }
                else if (fileType === 'GPS') filas = await handleGPS(jsonData, file.name, gpsDesde, gpsHasta);
                else if (fileType === 'ESTIMADOS') filas = await handleEstimados(jsonData, file.name);

                const meta = { filename: file.name, tipo: fileType, filas, procesado: new Date().toISOString(), periodo_desde: gpsDesde, periodo_hasta: gpsHasta };
                await registrarArchivo(meta);
                console.log(`[${fileType}] ${file.name}: ${filas} filas procesadas`);
                resolve(meta);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = (err) => reject(err);
        reader.readAsArrayBuffer(file);
    });
}

async function handleEquipos(data, filename) {
    // Se agrupa por clave normalizada en vez de empujar una fila por renglón.
    //
    // Por qué: el Excel real lista cada bomba de hormigón DOS veces con el mismo interno —
    // una fila como chasis (tiene el dominio, ej "BM09 / JNU923 / 31320") y otra como el
    // equipo bomba montado encima (sin dominio, ej "BM09 / - / BSF 38Z 12L"). Como el store
    // usa `interno` como clave, la segunda fila pisaba a la primera y el equipo terminaba
    // SIN DOMINIO. Eso a su vez disparaba la vieja regla "BM sin dominio = No Aplica" y
    // dejaba 10 bombas fuera del control de combustible.
    // Ahora las filas del mismo interno se fusionan: se conserva el dominio del chasis y se
    // combinan los modelos (chasis + bomba), que es la información real de la unidad.
    const porKey = new Map();

    data.forEach(row => {
        const internoRaw = getValFuzzy(row, ['INTERNO', 'NRO', 'ID']);
        const dominio = getValFuzzy(row, ['DOMINIO', 'PATENTE']);
        const tipoExcel = getValFuzzy(row, ['TIPO', 'CATEGORIA']);

        const idData = extractDataFromString(internoRaw || dominio);
        if (!idData.interno && !idData.dominio) return;

        const interno = (idData.interno || idData.dominio).toUpperCase();
        const key = normalizeEquipoKey(interno);
        const marca = normalizeString(getValFuzzy(row, ['MARCA'])) || '';
        const modelo = normalizeString(getValFuzzy(row, ['MODELO'])) || '';

        const prev = porKey.get(key);
        if (!prev) {
            porKey.set(key, {
                interno,
                interno_key: key,
                dominio: idData.dominio || normalizeString(dominio) || '',
                marca,
                modelo,
                // Denominación canónica por prefijo: la columna TIPO del Excel trae valores
                // erróneos (los TR figuran como "CAMION" siendo tractores, los MX mezclan
                // mixer/volcador/regador). Se guarda igual el original para trazabilidad.
                denominacion: getDenominacion(interno, tipoExcel),
                tipo: normalizeString(tipoExcel) || '',
                ubicacion: normalizeString(getValFuzzy(row, ['UBICACION'])) || '',
                anio: parseNumber(getValFuzzy(row, ['ANO', 'AÑO'])) || null,
                filas_origen: 1,
                source_file: filename
            });
        } else {
            // Fusionar: se completa lo que falte y se acumulan marca/modelo distintos.
            prev.dominio = prev.dominio || idData.dominio || normalizeString(dominio) || '';
            prev.marca = unirDistinto(prev.marca, marca);
            prev.modelo = unirDistinto(prev.modelo, modelo);
            prev.tipo = prev.tipo || normalizeString(tipoExcel) || '';
            prev.ubicacion = prev.ubicacion || normalizeString(getValFuzzy(row, ['UBICACION'])) || '';
            prev.anio = prev.anio || parseNumber(getValFuzzy(row, ['ANO', 'AÑO'])) || null;
            prev.filas_origen++;
        }
    });

    const equipos = [...porKey.values()];
    if (equipos.length > 0) await insertEquipos(equipos);
    return equipos.length;
}

/** Une dos valores de texto sin repetir (para fusionar marca/modelo de chasis + equipo). */
function unirDistinto(a, b) {
    if (!b) return a;
    if (!a) return b;
    if (a.includes(b) || b.includes(a)) return a.length >= b.length ? a : b;
    return `${a} / ${b}`;
}

async function handleEstimados(data, filename) {
    const estimados = [];
    data.forEach(row => {
        const internoRaw = getValFuzzy(row, ['INTERNO']);
        if (!internoRaw) return;
        const idData = extractDataFromString(internoRaw);
        if (!idData.interno) return;

        // El valor viene como texto con unidad: " 3 L/hora ", " 7 L/100km ".
        // Se guarda el texto original (para mostrar), el número (para comparar) y la
        // UNIDAD, que es lo que define si el equipo se mide por hora o por distancia.
        const parsed = parseConsumoEstimado(getValFuzzy(row, ['CONSUMO ESTIMADO', 'ESTIMADO']));
        const interno = idData.interno.toUpperCase();

        estimados.push({
            interno,
            interno_key: normalizeEquipoKey(interno),
            consumo_estimado: parsed.texto,
            consumo_estimado_valor: parsed.valor,
            consumo_estimado_unidad: parsed.unidad,
            source_file: filename
        });
    });

    if (estimados.length > 0) await insertEstimados(estimados);
    return estimados.length;
}

async function handleCargas(data, filename) {
    const records = [];
    data.forEach(row => {
        const identRaw = getValFuzzy(row, ['INTERNO-DOMINIO', 'INTERNO', 'PATENTE', 'DOMINIO', 'VEHICULO']);
        const idData = extractDataFromString(identRaw);
        if (!idData.interno) return;

        const interno = idData.interno.toUpperCase();
        records.push({
            type: 'carga',
            interno,
            interno_key: normalizeEquipoKey(interno),
            dominio: idData.dominio || '',
            fecha: parseDate(getValFuzzy(row, ['FECHA', 'DATE'])),
            litros: parseNumber(getValFuzzy(row, ['LITROS', 'CANTIDAD'])),
            importe: parseNumber(getValFuzzy(row, ['COSTO TOTAL', 'IMPORTE', 'MONTO'])),
            precio_unitario: parseNumber(getValFuzzy(row, ['PRECIO UNITARIO'])),
            combustible: normalizeString(getValFuzzy(row, ['TIPO DE COMBUSTIBLE'])) || '',
            chofer: normalizeString(getValFuzzy(row, ['CHOFER'])) || '',
            sector: normalizeString(getValFuzzy(row, ['SECTOR'])) || '',
            centro_costo: normalizeString(getValFuzzy(row, ['CENTRO DE COSTO', 'C. COSTO'])) || '',
            lugar_carga: normalizeString(getValFuzzy(row, ['LUGAR DE CARGA', 'LUGAR', 'SURTIDOR'])) || '',
            source_file: filename
        });
    });

    if (records.length > 0) await insertRawRecords(records);
    return records.length;
}

async function handleGPS(data, filename, gpsDesde, gpsHasta) {
    const records = [];
    data.forEach(row => {
        const identRaw = getValFuzzy(row, ['UNIDAD', 'MATRICULA', 'INTERNO', 'DOMINIO']);
        const idData = extractDataFromString(identRaw);
        if (!idData.interno) return;

        // El reporte real trae DOS columnas de tiempo ("Tiempo en ralentí" y "Tiempo en
        // movimiento"). Antes se leía solo una como número plano y se perdían las horas de
        // ralentí. aggregateHours() suma ambas y convierte el valor que entrega SheetJS
        // (fracción de día de Excel) a horas reales.
        const horas = aggregateHours({
            ralenti: getValFuzzy(row, ['TIEMPO EN RALENTI', 'RALENTI']),
            movimiento: getValFuzzy(row, ['TIEMPO EN MOVIMIENTO', 'HORAS', 'HS']),
            parado: getValFuzzy(row, ['TIEMPO PARADO', 'TIEMPO DETENIDO'])
        });

        const interno = idData.interno.toUpperCase();
        records.push({
            type: 'gps',
            interno,
            interno_key: normalizeEquipoKey(interno),
            fecha: parseDate(getValFuzzy(row, ['FECHA'])) || gpsDesde || '',
            fecha_hasta: gpsHasta || null,
            distancia: parseNumber(getValFuzzy(row, ['KILOMETROS RECORRIDOS', 'KILOMETROS', 'DISTANCIA'])),
            horas,
            odometro: parseNumber(getValFuzzy(row, ['ODOMETRO'])),
            horometro: parseNumber(getValFuzzy(row, ['HOROMETRO'])),
            vel_max: parseNumber(getValFuzzy(row, ['MAXIMA VELOCIDAD'])),
            grupo: normalizeString(getValFuzzy(row, ['GRUPO'])) || '',
            source_file: filename
        });
    });

    if (records.length > 0) await insertRawRecords(records);
    return records.length;
}

/**
 * La planilla de Cargas trae una segunda hoja "Precios" con el precio por litro de cada
 * tipo de combustible. Antes se ignoraba por completo; ahora se guarda para poder mostrar
 * el costo de referencia y detectar cargas con precio fuera de lista.
 */
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
        if (precios.length > 0) await insertPrecios(precios);
    } catch (e) {
        console.warn('No se pudo leer la hoja de Precios:', e);
    }
}

// Busca un valor en la fila por nombre de columna, ignorando mayúsculas/acentos/espacios.
function getValFuzzy(row, possibleKeys) {
    const normalizedRowKeys = Object.keys(row).map(k => ({
        original: k,
        norm: normalizeString(k).replace(/\s+/g, '')
    }));

    for (let pk of possibleKeys) {
        const normPk = normalizeString(pk).replace(/\s+/g, '');
        const match = normalizedRowKeys.find(rk => rk.norm.includes(normPk));
        if (match) return row[match.original];
    }
    return null;
}
