/**
 * Dispatcher para archivos a procesar.
 * Devuelve la metadata del archivo procesado ({tipo, filas, ...}) para que la UI pueda
 * mostrar qué se detectó en cada uno en vez de un genérico "listo".
 */

import { parseXLSX } from './xlsx-parser.js';

export async function dispatchFileParser(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'xlsx' || ext === 'xls') {
        return await parseXLSX(file);
    }

    if (ext === 'csv') {
        // SheetJS lee CSV con el mismo lector, así que se reusa el parser de Excel:
        // la detección de formato es por contenido de encabezados, no por extensión.
        return await parseXLSX(file);
    }

    throw new Error(`Formato no soportado: .${ext}. Subí los archivos en .xlsx o .csv`);
}
