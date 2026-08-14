/**
 * IndexedDB Wrapper para FlotaControl
 */

const DB_NAME = 'FlotaControlDB';
// v3: agrega el store 'precios' y el índice interno_key. El salto de versión también fuerza
// el onupgradeneeded en navegadores que ya tenían la base v2 con datos de la versión anterior.
const DB_VERSION = 3;

let dbInstance = null;

export function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error('Database error: ', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = (event) => {
            dbInstance = event.target.result;
            resolve(dbInstance);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            if (!db.objectStoreNames.contains('equipos')) {
                const s = db.createObjectStore('equipos', { keyPath: 'interno' });
                s.createIndex('dominio', 'dominio', { unique: false });
                s.createIndex('tipo', 'tipo', { unique: false });
            }

            if (!db.objectStoreNames.contains('raw_records')) {
                const s = db.createObjectStore('raw_records', { keyPath: 'id', autoIncrement: true });
                s.createIndex('interno', 'interno', { unique: false });
                s.createIndex('fecha', 'fecha', { unique: false });
                s.createIndex('source_file', 'source_file', { unique: false });
                s.createIndex('type', 'type', { unique: false });
            }

            if (!db.objectStoreNames.contains('corrections')) {
                const s = db.createObjectStore('corrections', { keyPath: 'id', autoIncrement: true });
                s.createIndex('record_id', 'record_id', { unique: false });
            }

            if (!db.objectStoreNames.contains('files_meta')) {
                db.createObjectStore('files_meta', { keyPath: 'filename' });
            }

            if (!db.objectStoreNames.contains('estimados')) {
                db.createObjectStore('estimados', { keyPath: 'interno' });
            }

            // Nuevo en v3: precios por tipo de combustible (2da hoja de Cargas)
            if (!db.objectStoreNames.contains('precios')) {
                db.createObjectStore('precios', { keyPath: 'combustible' });
            }
        };
    });
}

export function getDB() {
    if (!dbInstance) throw new Error('Database not initialized. Call initDB() first.');
    return dbInstance;
}

/** Helper: envuelve una transacción de escritura en una promesa que resuelve al completarse. */
function writeTx(storeNames, fn) {
    return new Promise((resolve, reject) => {
        const tx = getDB().transaction(storeNames, 'readwrite');
        let result;
        try {
            result = fn(storeNames.map(n => tx.objectStore(n)), tx);
        } catch (e) {
            reject(e);
            return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = (e) => reject(e.target.error);
        tx.onabort = (e) => reject(e.target.error);
    });
}

/** Helper: lectura completa de un store. */
function readAll(storeName) {
    return new Promise((resolve, reject) => {
        const tx = getDB().transaction([storeName], 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

// ---------- ESTIMADOS ----------
export function insertEstimados(arr) {
    return writeTx(['estimados'], ([store]) => { arr.forEach(e => store.put(e)); return arr.length; });
}
export function getAllEstimados() { return readAll('estimados'); }

// ---------- EQUIPOS ----------
export function insertEquipos(arr) {
    return writeTx(['equipos'], ([store]) => { arr.forEach(e => store.put(e)); return arr.length; });
}
export function getAllEquipos() { return readAll('equipos'); }

/**
 * Guarda un equipo editado desde la tarjeta.
 * Fix: la versión anterior hacía `await tx.objectStore(...).put(...)` y devolvía
 * `tx.complete`, que no existe en IndexedDB nativo (es de la librería idb). La escritura se
 * encolaba pero la promesa resolvía a `undefined` antes de completarse, así que la UI podía
 * refrescar antes de que el dato estuviera guardado.
 */
export function updateEquipo(equipo) {
    return writeTx(['equipos'], ([store]) => { store.put(equipo); return equipo; });
}

// ---------- RAW RECORDS ----------
export function insertRawRecords(arr) {
    return writeTx(['raw_records'], ([store]) => { arr.forEach(r => store.add(r)); return arr.length; });
}
export function getAllRawRecords() { return readAll('raw_records'); }
export function clearRawRecords() {
    return writeTx(['raw_records'], ([store]) => { store.clear(); });
}

// ---------- PRECIOS ----------
export function insertPrecios(arr) {
    return writeTx(['precios'], ([store]) => { arr.forEach(p => store.put(p)); return arr.length; });
}
export function getAllPrecios() { return readAll('precios'); }

// ---------- ARCHIVOS PROCESADOS ----------
export function registrarArchivo(meta) {
    return writeTx(['files_meta'], ([store]) => { store.put(meta); return meta; });
}
export function getArchivosProcesados() { return readAll('files_meta'); }

/**
 * Guarda/actualiza la meta de consumo de un equipo editada a mano en la tarjeta.
 * Recalcula el texto y la unidad para que quede consistente con lo que produce el parser.
 */
export function updateEstimado(estimado) {
    return writeTx(['estimados'], ([store]) => { store.put(estimado); return estimado; });
}

/**
 * Borra TODOS los datos analizados (equipos, registros, metas, precios, archivos).
 * Es lo que usa el botón "Re-analizar": la app guarda los datos en el navegador, así que si
 * no se limpia primero, un reprocesamiento acumula los registros viejos junto con los nuevos
 * y los totales quedan duplicados.
 */
export function clearAllData() {
    return writeTx(
        ['equipos', 'raw_records', 'corrections', 'files_meta', 'estimados', 'precios'],
        (stores) => { stores.forEach(s => s.clear()); }
    );
}

/** Resumen de qué hay cargado, para mostrar en la UI antes/después de re-analizar. */
export async function getDBStats() {
    const [equipos, records, estimados, archivos] = await Promise.all([
        getAllEquipos(), getAllRawRecords(), getAllEstimados(), getArchivosProcesados()
    ]);
    return {
        equipos: equipos.length,
        cargas: records.filter(r => r.type === 'carga').length,
        gps: records.filter(r => r.type === 'gps').length,
        estimados: estimados.length,
        archivos: archivos.length
    };
}
