import { AppState, irA } from '../app.js';
import { dispatchFileParser } from '../parsers/index.js';
import { clearMovimientos, getDBStats, getArchivosProcesados } from '../data/database.js';

export function initUploadUI() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const btnProcess = document.getElementById('btn-process-all');

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev =>
        dropZone.addEventListener(ev, preventDefaults, false));
    ['dragenter', 'dragover'].forEach(ev =>
        dropZone.addEventListener(ev, () => dropZone.classList.add('dragover'), false));
    ['dragleave', 'drop'].forEach(ev =>
        dropZone.addEventListener(ev, () => dropZone.classList.remove('dragover'), false));

    dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files), false);
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
    btnProcess.addEventListener('click', processAllFiles);
}

function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }

function handleFiles(files) {
    [...files].forEach(file => {
        if (!AppState.filesQueue.find(f => f.file.name === file.name)) {
            AppState.filesQueue.push({ file, status: 'pending', type: detectVisualType(file.name) });
        }
    });
    renderFileList();
    updateProcessButton();
}

export function removeFile(filename) {
    AppState.filesQueue = AppState.filesQueue.filter(f => f.file.name !== filename);
    renderFileList();
    updateProcessButton();
}
window.removeFile = removeFile;

function updateProcessButton() {
    const btn = document.getElementById('btn-process-all');
    if (btn) btn.disabled = !AppState.filesQueue.some(f => f.status === 'pending');
}

function detectVisualType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'xlsx' || ext === 'xls') return 'excel';
    if (ext === 'csv') return 'csv';
    if (ext === 'json') return 'json';
    return 'unknown';
}

const BADGE_LABEL = { pending: 'PENDIENTE', processing: 'PROCESANDO', done: 'LISTO', error: 'ERROR' };

function renderFileList() {
    const list = document.getElementById('file-list');
    if (!list) return;
    list.innerHTML = '';

    AppState.filesQueue.forEach(f => {
        const item = document.createElement('div');
        item.className = 'file-item';
        let iconClass = 'fa-file';
        if (f.type === 'excel') iconClass = 'fa-file-excel';
        if (f.type === 'csv') iconClass = 'fa-file-csv';

        item.innerHTML = `
            <div class="file-info">
                <i class="fa-solid ${iconClass} file-icon ${f.type}"></i>
                <div class="file-details">
                    <h4>${f.file.name}</h4>
                    <p>${(f.file.size / 1024 / 1024).toFixed(2)} MB${f.detalle ? ' · ' + f.detalle : ''}</p>
                </div>
            </div>
            <div class="file-status">
                <span class="badge ${f.status}" id="badge-${safeId(f.file.name)}">${BADGE_LABEL[f.status] || f.status.toUpperCase()}</span>
                <button class="btn-icon" onclick="window.removeFile('${f.file.name.replace(/'/g, "\\'")}')">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>`;
        list.appendChild(item);
    });
}

const safeId = (name) => name.replace(/[^a-z0-9]/gi, '');

/**
 * Muestra qué hay actualmente guardado en la base local del navegador.
 * Sirve para que se note cuándo quedaron datos de un procesamiento anterior (que era
 * justamente la causa de ver denominaciones y consumos viejos después de una corrección).
 */
export async function renderDBStatus() {
    const el = document.getElementById('db-status');
    if (!el) return;

    try {
        const stats = await getDBStats();
        const archivos = await getArchivosProcesados();

        if (stats.equipos === 0 && stats.movimientos === 0) {
            el.innerHTML = `<div class="db-status-inner empty"><i class="fa-solid fa-database"></i> La base local está vacía. Subí los archivos para empezar.</div>`;
            return;
        }

        el.innerHTML = `
            <div class="db-status-inner">
                <div>
                    <i class="fa-solid fa-database"></i>
                    <strong>Datos guardados en este navegador:</strong>
                    ${stats.equipos} equipos en el maestro (${stats.conMeta} con meta) · ${stats.movimientos} movimientos${stats.columnasExtra ? ` · ${stats.columnasExtra} columnas propias` : ''}
                </div>
                <div class="db-status-files">
                    ${archivos.map(a => `<span class="chip">${a.tipo}: ${a.filename.slice(0, 34)}${a.filename.length > 34 ? '…' : ''}</span>`).join('')}
                </div>
            </div>`;
    } catch (e) {
        el.innerHTML = '';
    }
}

async function processAllFiles() {
    const pendientes = AppState.filesQueue.filter(f => f.status === 'pending');
    if (pendientes.length === 0) return;

    const btn = document.getElementById('btn-process-all');
    const limpiar = document.getElementById('chk-limpiar')?.checked;
    btn.disabled = true;

    // Se borran solo los MOVIMIENTOS, nunca el maestro: reprocesar el mismo archivo sin
    // limpiar duplicaría litros, km y horas en todos los totales, pero borrar el padrón
    // haría perder las correcciones hechas a mano y las columnas propias.
    if (limpiar) {
        try {
            await clearMovimientos();
        } catch (e) {
            console.error('No se pudieron limpiar los movimientos antes de procesar:', e);
        }
    }

    let ok = 0, errores = 0;
    const resumen = [];

    for (const f of pendientes) {
        const badge = document.getElementById(`badge-${safeId(f.file.name)}`);
        f.status = 'processing';
        if (badge) { badge.className = 'badge processing'; badge.innerText = 'PROCESANDO'; }

        try {
            const meta = await dispatchFileParser(f.file);
            f.status = 'done';
            f.detalle = meta && meta.tipo ? `${meta.tipo} · ${meta.filas} filas` : '';
            if (meta && meta.tipo === 'DESCONOCIDO') {
                f.status = 'error';
                f.detalle = 'No se reconoció el formato';
                errores++;
            } else {
                ok++;
                if (meta) resumen.push(`${meta.tipo}: ${meta.filas} filas`);
            }
            if (badge) {
                badge.className = `badge ${f.status}`;
                badge.innerText = f.status === 'done' ? 'LISTO' : 'ERROR';
            }
        } catch (e) {
            console.error('Error procesando', f.file.name, e);
            f.status = 'error';
            f.detalle = e.message;
            errores++;
            if (badge) { badge.className = 'badge error'; badge.innerText = 'ERROR'; }
        }
    }

    renderFileList();
    updateProcessButton();
    await renderDBStatus();

    if (ok > 0) {
        irA('panel');
    } else if (errores > 0) {
        alert('Ninguno de los archivos se pudo procesar. Revisá que sean los Excel de Equipos, Cargas, Resumen de Flota o Consumos Estimados.');
    }
}
