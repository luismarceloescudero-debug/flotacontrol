/**
 * Dispatcher para archivos a procesar
 */

import { parseXLSX } from './xlsx-parser.js';

export async function dispatchFileParser(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    
    if (ext === 'xlsx' || ext === 'xls') {
        return await parseXLSX(file);
    } else if (ext === 'csv') {
        // TODO: parseCSV(file)
        console.warn("CSV parsing not implemented yet");
    } else if (ext === 'pdf') {
        // TODO: parsePDF(file)
        console.warn("PDF parsing not implemented yet");
    } else if (ext === 'json') {
        // TODO: parseJSONTemplate(file)
        console.warn("JSON parsing not implemented yet");
    } else {
        throw new Error(`Extensión no soportada: ${ext}`);
    }
}
