/**
 * IndexedDB Wrapper for FlotaControl v2.0
 */

const DB_NAME = 'FlotaControlDB';
const DB_VERSION = 2; // Incremented to create 'estimados' table

let dbInstance = null;

export function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error("Database error: ", event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = (event) => {
            dbInstance = event.target.result;
            resolve(dbInstance);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // 1. Equipos (Master List)
            if (!db.objectStoreNames.contains('equipos')) {
                const equiposStore = db.createObjectStore('equipos', { keyPath: 'interno' });
                equiposStore.createIndex('dominio', 'dominio', { unique: false });
                equiposStore.createIndex('tipo', 'tipo', { unique: false });
            }

            // 2. Registros Crudos (Cargas, GPS, Insumos)
            if (!db.objectStoreNames.contains('raw_records')) {
                const recordsStore = db.createObjectStore('raw_records', { keyPath: 'id', autoIncrement: true });
                recordsStore.createIndex('interno', 'interno', { unique: false });
                recordsStore.createIndex('fecha', 'fecha', { unique: false });
                recordsStore.createIndex('source_file', 'source_file', { unique: false });
                recordsStore.createIndex('type', 'type', { unique: false }); // 'carga', 'gps', 'insumo'
            }

            // 3. Correcciones (Overlays inmutables)
            if (!db.objectStoreNames.contains('corrections')) {
                const correctionsStore = db.createObjectStore('corrections', { keyPath: 'id', autoIncrement: true });
                correctionsStore.createIndex('record_id', 'record_id', { unique: false });
            }

            // 4. Metadatos de Archivos
            if (!db.objectStoreNames.contains('files_meta')) {
                db.createObjectStore('files_meta', { keyPath: 'filename' });
            }

            // 5. Estimados
            if (!db.objectStoreNames.contains('estimados')) {
                db.createObjectStore('estimados', { keyPath: 'interno' });
            }
        };
    });
}

export function getDB() {
    if (!dbInstance) throw new Error("Database not initialized. Call initDB() first.");
    return dbInstance;
}

// ESTIMADOS
export function insertEstimados(estimadosArray) {
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction(['estimados'], 'readwrite');
        const store = transaction.objectStore('estimados');
        
        estimadosArray.forEach(est => store.put(est));
        
        transaction.oncomplete = () => resolve();
        transaction.onerror = (e) => reject(e.target.error);
    });
}

export function getAllEstimados() {
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction(['estimados'], 'readonly');
        const store = transaction.objectStore('estimados');
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

export function getAllRawRecords() {
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction(['raw_records'], 'readonly');
        const store = transaction.objectStore('raw_records');
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

// Utility wrappers for common operations
export function insertEquipos(equiposArray) {
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction(['equipos'], 'readwrite');
        const store = transaction.objectStore('equipos');
        
        let count = 0;
        equiposArray.forEach(eq => {
            store.put(eq);
            count++;
        });

        transaction.oncomplete = () => resolve(count);
        transaction.onerror = (e) => reject(e.target.error);
    });
}

export function getAllEquipos() {
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction(['equipos'], 'readonly');
        const store = transaction.objectStore('equipos');
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function clearRawRecords() {
    const db = await getDB();
    const tx = db.transaction(['raw_records'], 'readwrite');
    await tx.objectStore('raw_records').clear();
    return tx.complete;
}

export async function updateEquipo(equipo) {
    const db = await getDB();
    const tx = db.transaction(['equipos'], 'readwrite');
    await tx.objectStore('equipos').put(equipo); // Put acts as upsert if key exists
    return tx.complete;
}

export async function updateEstimado(estimado) {
    const db = await getDB();
    const tx = db.transaction(['estimados'], 'readwrite');
    await tx.objectStore('estimados').put(estimado);
    return tx.complete;
}

export function insertRawRecords(recordsArray) {
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction(['raw_records'], 'readwrite');
        const store = transaction.objectStore('raw_records');
        
        recordsArray.forEach(rec => store.add(rec));

        transaction.oncomplete = () => resolve(recordsArray.length);
        transaction.onerror = (e) => reject(e.target.error);
    });
}

export function getRecordsByDateRange(from, to, type = null) {
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction(['raw_records'], 'readonly');
        const store = transaction.objectStore('raw_records');
        const index = store.index('fecha');
        
        let range = null;
        if (from && to) {
            range = IDBKeyRange.bound(from, to);
        } else if (from) {
            range = IDBKeyRange.lowerBound(from);
        } else if (to) {
            range = IDBKeyRange.upperBound(to);
        }

        const request = index.getAll(range);
        
        request.onsuccess = () => {
            let results = request.result;
            if (type) {
                results = results.filter(r => r.type === type);
            }
            resolve(results);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

export function clearAllData() {
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction(['equipos', 'raw_records', 'corrections', 'files_meta'], 'readwrite');
        transaction.objectStore('equipos').clear();
        transaction.objectStore('raw_records').clear();
        transaction.objectStore('corrections').clear();
        transaction.objectStore('files_meta').clear();
        
        transaction.oncomplete = () => resolve();
        transaction.onerror = (e) => reject(e.target.error);
    });
}
