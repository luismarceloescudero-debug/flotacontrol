/**
 * IndexedDB Wrapper para FlotaControl
 *
 * Modelo de datos:
 *   MAESTRO (`equipos`)     -> el padrón editable. Fusiona la planilla de Equipos y la de
 *                              Consumos Estimados en una sola fila por equipo, identificada
 *                              por INTERNO + DOMINIO (el común denominador de todo el sistema).
 *                              Admite columnas propias definidas por el usuario.
 *   MOVIMIENTOS (`raw_records`) -> todo lo que pasa en el tiempo: cargas de combustible,
 *                              resúmenes de GPS, cubiertas, insumos, filtros y cualquier
 *                              planilla futura. Cada registro guarda además TODAS sus columnas
 *                              originales en `datos`, para no perder información al importar.
 *   `mapeos`                -> cómo se traduce cada columna de un tipo de planilla a los
 *                              campos del sistema. Editable, así un cambio de nombre de
 *                              columna en el Excel no rompe la importación.
 *   `config`                -> definición de las columnas propias del maestro y otros ajustes.
 */

const DB_NAME = 'FlotaControlDB';
// v4: maestro unificado (equipos + metas), columnas propias, mapeos de columnas y
// movimientos genéricos con todas sus columnas originales.
const DB_VERSION = 4;

let dbInstance = null;

export function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (e) => { console.error('Database error:', e.target.error); reject(e.target.error); };
        request.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            if (!db.objectStoreNames.contains('equipos')) {
                const s = db.createObjectStore('equipos', { keyPath: 'interno' });
                s.createIndex('dominio', 'dominio', { unique: false });
            }
            if (!db.objectStoreNames.contains('raw_records')) {
                const s = db.createObjectStore('raw_records', { keyPath: 'id', autoIncrement: true });
                s.createIndex('interno', 'interno', { unique: false });
                s.createIndex('fecha', 'fecha', { unique: false });
                s.createIndex('source_file', 'source_file', { unique: false });
                s.createIndex('type', 'type', { unique: false });
            }
            if (!db.objectStoreNames.contains('files_meta')) {
                db.createObjectStore('files_meta', { keyPath: 'filename' });
            }
            // Se mantiene por compatibilidad con bases v2/v3; el maestro ya integra las metas.
            if (!db.objectStoreNames.contains('estimados')) {
                db.createObjectStore('estimados', { keyPath: 'interno' });
            }
            if (!db.objectStoreNames.contains('precios')) {
                db.createObjectStore('precios', { keyPath: 'combustible' });
            }
            if (!db.objectStoreNames.contains('mapeos')) {
                db.createObjectStore('mapeos', { keyPath: 'tipo' });
            }
            if (!db.objectStoreNames.contains('config')) {
                db.createObjectStore('config', { keyPath: 'k' });
            }
        };
    });
}

export function getDB() {
    if (!dbInstance) throw new Error('Database not initialized. Call initDB() first.');
    return dbInstance;
}

function writeTx(storeNames, fn) {
    return new Promise((resolve, reject) => {
        const tx = getDB().transaction(storeNames, 'readwrite');
        let result;
        try { result = fn(storeNames.map(n => tx.objectStore(n)), tx); }
        catch (e) { reject(e); return; }
        tx.oncomplete = () => resolve(result);
        tx.onerror = (e) => reject(e.target.error);
        tx.onabort = (e) => reject(e.target.error);
    });
}

function readAll(storeName) {
    return new Promise((resolve, reject) => {
        const tx = getDB().transaction([storeName], 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

function readOne(storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = getDB().transaction([storeName], 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

// ============================ MAESTRO ============================

export function getAllEquipos() { return readAll('equipos'); }

/**
 * Inserta o fusiona filas en el maestro.
 *
 * La fusión es la parte importante: la planilla de Equipos y la de Consumos Estimados
 * escriben sobre la MISMA fila, y el orden en que se suban no debe importar. Además, al
 * reimportar una planilla no se pueden perder ni las columnas propias que agregó el usuario
 * ni las correcciones que hizo a mano.
 *
 * @param {Array} filas    Filas a escribir (deben traer al menos `interno`)
 * @param {Object} opts    { preservarEdiciones: true }
 */
export function upsertEquipos(filas, opts = {}) {
    const preservar = opts.preservarEdiciones !== false;
    return new Promise((resolve, reject) => {
        const tx = getDB().transaction(['equipos'], 'readwrite');
        const store = tx.objectStore('equipos');
        let escritas = 0;

        filas.forEach(nueva => {
            const req = store.get(nueva.interno);
            req.onsuccess = () => {
                const previa = req.result;
                if (!previa) {
                    store.put({ extra: {}, origen: [], ...nueva });
                } else {
                    const fusionada = { ...previa };
                    // Solo se pisan los campos que la nueva fila realmente trae con valor.
                    Object.entries(nueva).forEach(([k, v]) => {
                        if (k === 'extra' || k === 'origen') return;
                        if (v === null || v === undefined || v === '') return;
                        // Un valor corregido a mano no lo pisa una reimportación.
                        if (preservar && previa.editado_manual && previa.editado_manual.includes(k)) return;
                        fusionada[k] = v;
                    });
                    fusionada.extra = { ...(previa.extra || {}), ...(nueva.extra || {}) };
                    fusionada.origen = [...new Set([...(previa.origen || []), ...(nueva.origen || [])])];
                    store.put(fusionada);
                }
                escritas++;
            };
        });

        tx.oncomplete = () => resolve(escritas);
        tx.onerror = (e) => reject(e.target.error);
    });
}

/** Alias histórico: el parser de Equipos sigue llamando a insertEquipos. */
export const insertEquipos = (filas) => upsertEquipos(filas);

/** Guarda un equipo completo (edición manual desde la grilla o la tarjeta). */
export function updateEquipo(equipo) {
    return writeTx(['equipos'], ([store]) => { store.put(equipo); return equipo; });
}

export function deleteEquipo(interno) {
    return writeTx(['equipos'], ([store]) => { store.delete(interno); });
}

/**
 * Marca un campo como corregido a mano para que una reimportación no lo pise.
 */
export async function editarCampoEquipo(interno, campo, valor, esExtra = false) {
    const eq = await readOne('equipos', interno);
    if (!eq) throw new Error(`No existe el equipo ${interno}`);

    if (esExtra) {
        eq.extra = { ...(eq.extra || {}), [campo]: valor };
    } else {
        eq[campo] = valor;
        eq.editado_manual = [...new Set([...(eq.editado_manual || []), campo])];
    }
    return updateEquipo(eq);
}

// ============================ COLUMNAS PROPIAS ============================

const COLS_KEY = 'columnas_extra';

/** Columnas propias del maestro: [{id, label}] */
export async function getColumnasExtra() {
    const r = await readOne('config', COLS_KEY);
    return (r && r.v) || [];
}

export function setColumnasExtra(cols) {
    return writeTx(['config'], ([store]) => { store.put({ k: COLS_KEY, v: cols }); return cols; });
}

// ============================ MAPEOS DE COLUMNAS ============================

/**
 * Mapeo guardado para un tipo de planilla: { tipo, columnas: {campoSistema: 'NOMBRE EN EXCEL'} }
 * Permite que si HSV renombra una columna, se corrija una vez y quede aprendido.
 */
export function getMapeo(tipo) { return readOne('mapeos', tipo); }
export function getAllMapeos() { return readAll('mapeos'); }
export function saveMapeo(tipo, columnas) {
    return writeTx(['mapeos'], ([store]) => { store.put({ tipo, columnas, actualizado: new Date().toISOString() }); });
}

// ============================ MOVIMIENTOS ============================

export function insertRawRecords(arr) {
    return writeTx(['raw_records'], ([store]) => { arr.forEach(r => store.add(r)); return arr.length; });
}
export function getAllRawRecords() { return readAll('raw_records'); }

/** Borra los movimientos de un archivo puntual, para poder reimportarlo sin duplicar. */
export function deleteRecordsPorArchivo(filename) {
    return new Promise((resolve, reject) => {
        const tx = getDB().transaction(['raw_records'], 'readwrite');
        const store = tx.objectStore('raw_records');
        const idx = store.index('source_file');
        const req = idx.openCursor(IDBKeyRange.only(filename));
        let n = 0;
        req.onsuccess = (e) => {
            const cur = e.target.result;
            if (cur) { cur.delete(); n++; cur.continue(); }
        };
        tx.oncomplete = () => resolve(n);
        tx.onerror = (ev) => reject(ev.target.error);
    });
}

export function clearRawRecords() {
    return writeTx(['raw_records'], ([store]) => { store.clear(); });
}

/** Tipos de movimiento presentes (carga, gps, cubiertas, insumos, filtros, …). */
export async function getTiposDeMovimiento() {
    const recs = await getAllRawRecords();
    const m = new Map();
    recs.forEach(r => {
        if (!m.has(r.type)) m.set(r.type, { tipo: r.type, etiqueta: r.type_label || r.type, n: 0 });
        m.get(r.type).n++;
    });
    return [...m.values()].sort((a, b) => b.n - a.n);
}

// ============================ OTROS ============================

export function insertEstimados(arr) {
    return writeTx(['estimados'], ([store]) => { arr.forEach(e => store.put(e)); return arr.length; });
}
export function getAllEstimados() { return readAll('estimados'); }
export function updateEstimado(e) {
    return writeTx(['estimados'], ([store]) => { store.put(e); return e; });
}

export function insertPrecios(arr) {
    return writeTx(['precios'], ([store]) => { arr.forEach(p => store.put(p)); return arr.length; });
}
export function getAllPrecios() { return readAll('precios'); }

export function registrarArchivo(meta) {
    return writeTx(['files_meta'], ([store]) => { store.put(meta); return meta; });
}
export function getArchivosProcesados() { return readAll('files_meta'); }

/**
 * Borra los MOVIMIENTOS pero conserva el maestro (padrón y metas) con sus ediciones.
 * Es lo habitual al recargar los archivos del mes: no tiene sentido volver a cargar el
 * padrón y perder las correcciones hechas a mano.
 */
export function clearMovimientos() {
    return writeTx(['raw_records', 'files_meta'], (stores) => { stores.forEach(s => s.clear()); });
}

/** Borra absolutamente todo, incluido el maestro y las columnas propias. */
export function clearAllData() {
    return writeTx(
        ['equipos', 'raw_records', 'files_meta', 'estimados', 'precios', 'mapeos', 'config'],
        (stores) => { stores.forEach(s => s.clear()); }
    );
}

export async function getDBStats() {
    const [equipos, records, archivos, cols] = await Promise.all([
        getAllEquipos(), getAllRawRecords(), getArchivosProcesados(), getColumnasExtra()
    ]);
    const porTipo = {};
    records.forEach(r => { porTipo[r.type] = (porTipo[r.type] || 0) + 1; });
    return {
        equipos: equipos.length,
        conMeta: equipos.filter(e => e.meta_valor > 0).length,
        movimientos: records.length,
        porTipo,
        cargas: porTipo.carga || 0,
        gps: porTipo.gps || 0,
        archivos: archivos.length,
        columnasExtra: cols.length
    };
}
