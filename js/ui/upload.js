import { AppState } from '../app.js';
import { dispatchFileParser } from '../parsers/index.js';

export function initUploadUI() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const btnProcess = document.getElementById('btn-process-all');

    // Drag events
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    // Handle drops
    dropZone.addEventListener('drop', (e) => {
        let dt = e.dataTransfer;
        let files = dt.files;
        handleFiles(files);
    }, false);

    // Handle input change
    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
    });

    // Process button
    btnProcess.addEventListener('click', processAllFiles);
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function handleFiles(files) {
    [...files].forEach(file => {
        // Avoid duplicates by name
        if (!AppState.filesQueue.find(f => f.file.name === file.name)) {
            AppState.filesQueue.push({
                file: file,
                status: 'pending', // pending, processing, done, error
                type: detectVisualType(file.name)
            });
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

function updateProcessButton() {
    const btn = document.getElementById('btn-process-all');
    const hasPending = AppState.filesQueue.some(f => f.status === 'pending');
    btn.disabled = !hasPending;
}

function detectVisualType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'xlsx' || ext === 'xls') return 'excel';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'csv') return 'csv';
    if (ext === 'json') return 'json';
    return 'unknown';
}

function renderFileList() {
    const list = document.getElementById('file-list');
    list.innerHTML = '';

    AppState.filesQueue.forEach(f => {
        const item = document.createElement('div');
        item.className = 'file-item';
        
        let iconClass = 'fa-file';
        if (f.type === 'excel') iconClass = 'fa-file-excel';
        if (f.type === 'pdf') iconClass = 'fa-file-pdf';
        if (f.type === 'csv') iconClass = 'fa-file-csv';

        // Size format
        let size = (f.file.size / 1024 / 1024).toFixed(2) + ' MB';

        item.innerHTML = `
            <div class="file-info">
                <i class="fa-solid ${iconClass} file-icon ${f.type}"></i>
                <div class="file-details">
                    <h4>${f.file.name}</h4>
                    <p>${size}</p>
                </div>
            </div>
            <div class="file-status">
                <span class="badge ${f.status}" id="badge-${f.file.name.replace(/[^a-z0-9]/gi, '')}">
                    ${f.status.toUpperCase()}
                </span>
                <button class="btn-icon" onclick="window.removeFile('${f.file.name}')">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;
        list.appendChild(item);
    });
}

// Make removeFile global for inline onclick
window.removeFile = removeFile;

async function processAllFiles() {
    const pendingFiles = AppState.filesQueue.filter(f => f.status === 'pending');
    if (pendingFiles.length === 0) return;

    for (const f of pendingFiles) {
        await processSingleFile(f);
    }
    
    // Once done, re-check DB and update dashboard?
    alert("Procesamiento terminado.");
}

async function processSingleFile(f) {
    const badgeId = `badge-${f.file.name.replace(/[^a-z0-9]/gi, '')}`;
    const badge = document.getElementById(badgeId);
    
    // Update UI to processing
    f.status = 'processing';
    if (badge) {
        badge.className = 'badge processing';
        badge.innerText = 'PROCESSING';
    }

    try {
        // Await the specific parser
        await dispatchFileParser(f.file);
        
        f.status = 'done';
        if (badge) {
            badge.className = 'badge done';
            badge.innerText = 'DONE';
        }
    } catch (e) {
        console.error("Error processing file:", f.file.name, e);
        f.status = 'error';
        if (badge) {
            badge.className = 'badge error';
            badge.innerText = 'ERROR';
        }
    }
    
    updateProcessButton();
}
