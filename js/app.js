/**
 * FlotaControl - Core Application Logic
 */

import { initDB, clearAllData, getDBStats, getArchivosProcesados } from './data/database.js';
import { initUploadUI, renderDBStatus } from './ui/upload.js';
import { renderPanel, initPanelControls } from './ui/panel.js';
import { openConfigModal } from './ui/config.js';
import { initAIChat } from './ai/chat.js';
import { renderDataTable, saveDBRow } from './ui/datatable.js';
import * as Exporter from './export/exporter.js';

export const AppState = {
    currentView: 'upload',
    filesQueue: [],
    dateFilter: { from: null, to: null }
};

document.addEventListener('DOMContentLoaded', async () => {
    console.log('FlotaControl inicializando...');

    try {
        await initDB();
        console.log('IndexedDB lista.');
    } catch (e) {
        console.error('Falló la inicialización de la base:', e);
        alert('Error crítico: no se pudo inicializar la base de datos local del navegador.');
    }

    setupNavigation();
    initUploadUI();
    initPanelControls();
    setupAIPanel();
    initAIChat();

    document.getElementById('btn-config')?.addEventListener('click', openConfigModal);
    document.getElementById('btn-reanalizar')?.addEventListener('click', reanalizar);

    // Globals para los onclick inline del HTML
    window.exportUnitToPDF = Exporter.exportUnitToPDF;
    window.exportTableToXLSX = Exporter.exportTableToXLSX;
    window.showDataTable = renderDataTable;
    window.saveDBRow = saveDBRow;
    window.renderPanel = renderPanel;

    await renderDBStatus();

    // Si ya hay datos guardados de una sesión anterior, arrancar directo en el panel.
    try {
        const stats = await getDBStats();
        if (stats.equipos > 0 || stats.cargas > 0) irA('panel');
    } catch (e) { /* base vacía, se queda en la vista de carga */ }
});

/**
 * Botón "Re-analizar": borra todo lo guardado en el navegador y deja la app lista para
 * volver a procesar los archivos.
 *
 * Por qué hace falta: la app guarda los datos procesados en IndexedDB (el almacenamiento
 * local del navegador). Al mejorar el parser, los registros que quedaron de la versión
 * anterior siguen ahí, con denominaciones y horas mal calculadas, y se mezclan con los
 * nuevos. Sin este botón la única forma de limpiarlos era borrar los datos del sitio a mano
 * desde las herramientas del navegador.
 */
async function reanalizar() {
    let stats;
    try { stats = await getDBStats(); } catch (e) { stats = null; }

    const detalle = stats
        ? `\n\nSe van a borrar:\n· ${stats.equipos} equipos\n· ${stats.cargas} cargas de combustible\n· ${stats.gps} registros GPS\n· ${stats.estimados} consumos estimados`
        : '';

    if (!confirm(`¿Borrar los datos analizados y volver a empezar?${detalle}\n\nLos archivos Excel originales NO se tocan: vas a poder volver a subirlos y procesarlos con las reglas corregidas.`)) return;

    const btn = document.getElementById('btn-reanalizar');
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Limpiando...';

    try {
        await clearAllData();
        AppState.filesQueue = [];
        await renderDBStatus();
        irA('upload');
        alert('Base limpia. Volvé a subir los 4 archivos Excel y presioná "Procesar y Analizar".');
    } catch (e) {
        console.error('Error limpiando la base:', e);
        alert('No se pudo limpiar la base: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = prev;
    }
}

export function irA(vista) {
    AppState.currentView = vista;

    document.querySelectorAll('.app-nav button').forEach(b => {
        b.classList.toggle('active', b.id === `nav-${vista}`);
    });

    document.querySelectorAll('.view-section').forEach(v => {
        const activa = v.id === `view-${vista}`;
        v.classList.toggle('active', activa);
        v.classList.toggle('hidden', !activa);
    });

    if (vista === 'panel') renderPanel();
}

function setupNavigation() {
    document.querySelectorAll('.app-nav button').forEach(btn => {
        btn.addEventListener('click', () => irA(btn.id.replace('nav-', '')));
    });
}

function setupAIPanel() {
    const aiPanel = document.getElementById('ai-panel');
    const aiHeader = aiPanel?.querySelector('.ai-header');
    const toggleBtn = aiPanel?.querySelector('#btn-toggle-ai');

    if (!aiHeader || !aiPanel || !toggleBtn) return;

    aiHeader.addEventListener('click', () => {
        aiPanel.classList.toggle('collapsed');
        const icon = toggleBtn.querySelector('i');
        if (icon) {
            const colapsado = aiPanel.classList.contains('collapsed');
            icon.classList.toggle('fa-chevron-up', !colapsado);
            icon.classList.toggle('fa-chevron-down', colapsado);
        }
    });
}
