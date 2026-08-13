/**
 * XLSX Parser wrapper using SheetJS
 * Handles 4 specific file formats: Equipos, Cargas, GPS, Consumos Estimados
 */
import { insertEquipos, insertRawRecords, insertEstimados } from '../data/database.js';
import { extractDataFromString, parseDate, parseNumber, normalizeString, aggregateHours } from '../data/normalizer.js';

export async function parseXLSX(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                
                // Get all data as raw arrays
                const rawRows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
                if (rawRows.length === 0) throw new Error("Excel vacío");

                // Detect File Type and Header Row
                let fileType = 'UNKNOWN';
                let headerRowIdx = -1;

                // 1. Check if it's "Consumos Estimados" (Header at 0, contains 'CONSUMO ESTIMADO')
                for (let i = 0; i < Math.min(5, rawRows.length); i++) {
                    const rowText = rawRows[i].join('|').toUpperCase();
                    if (rowText.includes('CONSUMO ESTIMADO')) {
                        fileType = 'ESTIMADOS';
                        headerRowIdx = i;
                        break;
                    }
                }

                // 2. Check if it's "Cargas Combustible" (Header at 0, contains 'LITROS' and 'CHOFER')
                if (fileType === 'UNKNOWN') {
                    for (let i = 0; i < Math.min(5, rawRows.length); i++) {
                        const rowText = rawRows[i].join('|').toUpperCase();
                        if (rowText.includes('LITROS') && rowText.includes('LUGAR DE CARGA')) {
                            fileType = 'CARGAS';
                            headerRowIdx = i;
                            break;
                        }
                    }
                }

                // 3. Check if it's "Equipos" (Header at 4 or contains 'POTENCIA', 'CAPACIDAD')
                if (fileType === 'UNKNOWN') {
                    for (let i = 0; i < Math.min(10, rawRows.length); i++) {
                        const rowText = rawRows[i].join('|').toUpperCase();
                        if (rowText.includes('TIPO') && rowText.includes('MARCA') && rowText.includes('POTENCIA') && rowText.includes('INTERNO')) {
                            fileType = 'EQUIPOS';
                            headerRowIdx = i;
                            break;
                        }
                    }
                }

                let gpsDesde = null;
                let gpsHasta = null;

                // 4. Check if it's "GPS Resumen" (Header at 6 or contains 'KILÓMETROS RECORRIDOS')
                if (fileType === 'UNKNOWN') {
                    for (let i = 0; i < Math.min(10, rawRows.length); i++) {
                        const rowText = normalizeString(rawRows[i].join('|').toUpperCase());
                        if (rowText.includes('KILOMETROS RECORRIDOS') || rowText.includes('TIEMPO EN MOVIMIENTO')) {
                            fileType = 'GPS';
                            headerRowIdx = i;
                        }
                        // Search for metadata dates
                        if (rawRows[i][0] && String(rawRows[i][0]).toUpperCase().includes('DESDE:')) {
                            gpsDesde = parseDate(rawRows[i][1]);
                        }
                        if (rawRows[i][0] && String(rawRows[i][0]).toUpperCase().includes('HASTA:')) {
                            gpsHasta = parseDate(rawRows[i][1]);
                        }
                    }
                }

                if (headerRowIdx === -1) {
                    console.warn("No se pudo detectar el formato del archivo:", file.name);
                    resolve();
                    return;
                }

                // Extract Headers
                // NOTA (fix): algunos Excel reales (ej. "Equipos HSV*.xlsx") repiten el
                // encabezado "TIPO" dos veces en la misma fila (una vez con la categoría
                // descriptiva y otra vez con una clasificación por peso). Si dos columnas
                // tienen el mismo nombre, la conversión a objeto de más abajo pisaba el
                // valor de la primera con el de la segunda y se perdía el dato. Para evitar
                // eso, las columnas repetidas se renombran TIPO, TIPO_2, TIPO_3...
                const headerCounts = {};
                const headers = rawRows[headerRowIdx].map(h => {
                    const base = normalizeString(h).trim();
                    if (!base) return base;
                    headerCounts[base] = (headerCounts[base] || 0) + 1;
                    return headerCounts[base] === 1 ? base : `${base}_${headerCounts[base]}`;
                });
                console.log(`[${fileType}] Headers at row ${headerRowIdx}:`, headers);

                // Convert remaining rows to objects
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

                // Dispatch to specific handler
                if (fileType === 'EQUIPOS') {
                    await handleEquipos(jsonData, file.name);
                } else if (fileType === 'CARGAS') {
                    await handleCargas(jsonData, file.name);
                } else if (fileType === 'GPS') {
                    await handleGPS(jsonData, file.name, gpsDesde, gpsHasta);
                } else if (fileType === 'ESTIMADOS') {
                    await handleEstimados(jsonData, file.name);
                }

                resolve();
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = (err) => reject(err);
        reader.readAsArrayBuffer(file);
    });
}

async function handleEquipos(data, filename) {
    const equipos = [];
    data.forEach(row => {
        const internoRaw = getValFuzzy(row, ['INTERNO', 'NRO', 'ID']);
        const dominio = getValFuzzy(row, ['DOMINIO', 'PATENTE']);
        const tipo = getValFuzzy(row, ['TIPO', 'CATEGORIA']);
        
        let idData = extractDataFromString(internoRaw || dominio);
        if (!idData.interno && !idData.dominio) return;
        
        equipos.push({
            interno: (idData.interno || idData.dominio).toUpperCase(),
            dominio: idData.dominio || dominio || '',
            marca: getValFuzzy(row, ['MARCA']) || '',
            modelo: getValFuzzy(row, ['MODELO']) || '',
            tipo: tipo || '',
            source_file: filename
        });
    });
    
    if (equipos.length > 0) {
        await insertEquipos(equipos);
        console.log(`Insertados ${equipos.length} equipos`);
    }
}

async function handleEstimados(data, filename) {
    const estimados = [];
    data.forEach(row => {
        const internoRaw = getValFuzzy(row, ['INTERNO']);
        if (!internoRaw) return;
        
        let idData = extractDataFromString(internoRaw);
        if (!idData.interno) return;

        // El Excel real trae valores como " 3 L/hora " o " 7 L/100km " (texto con unidad).
        // Se conserva el texto (para mostrarlo tal cual, ej. "Meta: 3 L/hora") y además
        // se guarda el número puro por separado para poder comparar/calcular con él sin
        // depender de un regex en cada lugar que lo use (fix: antes solo se guardaba el
        // texto crudo, lo que impedía compararlo numéricamente contra el consumo real).
        const rawEstimado = (getValFuzzy(row, ['CONSUMO ESTIMADO', 'ESTIMADO']) || '').toString().trim();
        estimados.push({
            interno: idData.interno.toUpperCase(),
            consumo_estimado: rawEstimado,
            consumo_estimado_valor: parseNumber(rawEstimado),
            source_file: filename
        });
    });

    if (estimados.length > 0) {
        await insertEstimados(estimados);
        console.log(`Insertados ${estimados.length} consumos estimados`);
    }
}

async function handleCargas(data, filename) {
    const records = [];
    data.forEach(row => {
        const identRaw = getValFuzzy(row, ['INTERNO-DOMINIO', 'INTERNO', 'PATENTE', 'DOMINIO']);
        let idData = extractDataFromString(identRaw);
        if (!idData.interno) return;

        records.push({
            type: 'carga',
            interno: idData.interno.toUpperCase(),
            fecha: parseDate(getValFuzzy(row, ['FECHA', 'DATE'])),
            litros: parseNumber(getValFuzzy(row, ['LITROS', 'CANTIDAD'])),
            importe: parseNumber(getValFuzzy(row, ['COSTO TOTAL', 'IMPORTE', 'TOTAL', 'MONTO'])),
            centro_costo: getValFuzzy(row, ['CENTRO DE COSTO', 'C. COSTO', 'AREA', 'SECTOR']) || '',
            lugar_carga: getValFuzzy(row, ['LUGAR DE CARGA', 'LUGAR', 'SURTIDOR']) || '',
            source_file: filename
        });
    });
    
    if (records.length > 0) {
        await insertRawRecords(records);
        console.log(`Insertadas ${records.length} cargas`);
    }
}

async function handleGPS(data, filename, gpsDesde, gpsHasta) {
    const records = [];
    data.forEach(row => {
        const identRaw = getValFuzzy(row, ['UNIDAD', 'MATRICULA', 'INTERNO', 'DOMINIO']);
        let idData = extractDataFromString(identRaw);
        if (!idData.interno) return;

        // Fix: el reporte real "Resumen de Flota" trae DOS columnas de tiempo separadas
        // ("Tiempo en ralentí" y "Tiempo en movimiento"; no existe una tercera columna
        // "Tiempo parado" en los archivos reales, a diferencia de lo que asumía la
        // documentación previa). Antes se leía una sola columna ("Tiempo en movimiento")
        // como número plano, perdiendo por completo las horas de ralentí. Ahora se agregan
        // ambas con aggregateHours(), que además convierte correctamente el valor numérico
        // que entrega SheetJS (fracción de día tipo Excel) a horas reales.
        const horas = aggregateHours({
            ralenti: getValFuzzy(row, ['TIEMPO EN RALENTI', 'RALENTI']),
            movimiento: getValFuzzy(row, ['TIEMPO EN MOVIMIENTO', 'HORAS', 'HS']),
            parado: getValFuzzy(row, ['TIEMPO PARADO', 'TIEMPO DETENIDO'])
        });

        records.push({
            type: 'gps',
            interno: idData.interno.toUpperCase(),
            fecha: parseDate(getValFuzzy(row, ['FECHA'])) || gpsDesde || new Date().toISOString().split('T')[0],
            fecha_hasta: gpsHasta || null,
            distancia: parseNumber(getValFuzzy(row, ['KILOMETROS RECORRIDOS', 'KILOMETROS', 'DISTANCIA'])),
            horas,
            source_file: filename
        });
    });
    
    if (records.length > 0) {
        await insertRawRecords(records);
        console.log(`Insertados ${records.length} registros GPS`);
    }
}

// Utility to find value in an object using possible keys ignoring case/accents
function getValFuzzy(row, possibleKeys) {
    const normalizedRowKeys = Object.keys(row).map(k => ({ 
        original: k, 
        norm: normalizeString(k).replace(/\s+/g, '')
    }));
    
    for (let pk of possibleKeys) {
        const normPk = normalizeString(pk).replace(/\s+/g, '');
        const match = normalizedRowKeys.find(rk => rk.norm.includes(normPk));
        if (match) {
            return row[match.original];
        }
    }
    return null;
}
