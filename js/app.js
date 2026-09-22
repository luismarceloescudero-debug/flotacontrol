/**
 * FlotaControl - Arranque y navegación.
 */
import { initDB, clearAllData, clearMovimientos, getDBStats } from './data/database.js';
import { initUploadUI, renderDBStatus } from './ui/upload.js';
import { renderPanel, initPanelControls, buscarEquipo, setMesesFiltro } from './ui/panel.js';
import { renderDataTable, initDataTableControls, exportarTablaVisible, abrirTablaConBusqueda } from './ui/datatable.js';
import { renderRendimiento } from './ui/rendimiento.js';
import { renderSeguimiento } from './ui/seguimiento.js';
import { initCalcPopover } from './ui/calcpopover.js';
import { openConfigModal } from './ui/config.js';
import { initAIChat } from './ai/chat.js';

export const AppState = {
    currentView: 'panel',
    filesQueue: [],
    dateFilter: { from: null, to: null }
};

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initDB();
    } catch (e) {
        console.error('Falló la inicialización de la base:', e);
        alert('Error crítico: no se pudo inicializar la base de datos local del navegador.');
    }

    // Los movimientos (cargas, GPS, cubiertas…) son datos de sesión: se limpian al iniciar.
    // Solo el maestro (equipos + estimados + mapeos + config) persiste entre sesiones, porque
    // tiene ediciones manuales y columnas propias que no se deben perder.
    try { await clearMovimientos(); } catch (e) { console.warn('No se pudieron limpiar los movimientos al iniciar:', e); }

    setupNavigation();
    initUploadUI();
    initPanelControls();
    initDataTableControls();
    initCalcPopover();
    setupAIPanel();
    initAIChat();

    document.getElementById('btn-config')?.addEventListener('click', openConfigModal);
    document.getElementById('btn-reanalizar')?.addEventListener('click', reanalizar);
    // Delegado porque el botón vive dentro de #db-status, que renderDBStatus() reemplaza
    // por completo cada vez (subir un archivo, borrar uno, etc.) — atarlo por id una sola
    // vez acá se perdería en el primer re-render.
    document.getElementById('db-status')?.addEventListener('click', (e) => {
        if (e.target.closest('#btn-empezar-cero')) empezarDeCero();
    });

    window.exportTableToXLSX = exportarTablaVisible;
    window.showDataTable = (t) => { irA('datos'); renderDataTable(t); };
    window.renderPanel = renderPanel;
    window.setMesesFiltro = setMesesFiltro;
    // Punto único para navegar a Base de Datos con una búsqueda ya aplicada (interno/dominio),
    // usado desde los hallazgos del diagnóstico y desde las tarjetas del Panel. Antes esos
    // botones llamaban a `window.renderDataTable`, que nunca se publicó acá — por eso no hacían
    // nada ("Ver cargas" y las acciones de alta/asignación de los hallazgos, entre otras).
    window.abrirTablaConBusqueda = (tipo, query = '', buscarCol = 'id', periodo = null, filtroCorrec = null) => {
        irA('datos');
        return abrirTablaConBusqueda(tipo, query, buscarCol, periodo, filtroCorrec);
    };
    // Usado desde la vista de Seguimiento: volver al Panel ya con la tarjeta del equipo buscada
    // y a la vista, en vez de solo cambiar de pestaña y dejar que el usuario la busque a mano.
    // Navegación genérica publicada para los hallazgos que no se resuelven dentro del Panel
    // (ej. "faltan los Resumen de Flota de julio y agosto": eso se arregla subiendo el archivo).
    window.irA = irA;
    window.irAPanelConBusqueda = (interno) => {
        irA('panel');
        buscarEquipo(interno);
    };

    await renderDBStatus();

    // Después de limpiar movimientos, arrancar en panel solo si hay equipos cargados
    // (el maestro persiste); de lo contrario, ir a carga de datos.
    try {
        const s = await getDBStats();
        irA(s.equipos > 0 ? 'panel' : 'upload');
    } catch (e) { irA('upload'); }
});

/**
 * Re-analizar: lleva a Carga de Datos, donde el estado de la base ya se ve (equipos, metas,
 * movimientos, archivos) antes de decidir nada. Antes esto abría dos `confirm()` encadenados
 * pidiendo elegir qué borrar sin mostrar ese contexto primero — una decisión en una ventana
 * emergente sin análisis previo. Ahora no borra nada por sí solo: el checkbox "Borrar los
 * movimientos anteriores antes de procesar" (ya en la pantalla de Carga de Datos) cubre el
 * caso normal —cargar los archivos de un mes nuevo—, y "Empezar de cero" (ahí mismo, ver
 * `renderDBStatus` en upload.js) cubre el caso destructivo, con el detalle de lo que hay
 * guardado ya visible arriba.
 */
function reanalizar() {
    irA('upload');
}

/**
 * Borra absolutamente todo (maestro de equipos, metas y columnas propias incluidos), no solo
 * los movimientos. Vive junto al panel que ya muestra qué hay guardado (`db-status`), así que
 * la decisión se toma viendo el dato, no a ciegas. Es irreversible, por eso el único confirm()
 * que queda es específico de ESTA acción, no un menú de opciones.
 */
async function empezarDeCero() {
    if (!confirm('¿Borrar TODO, incluido el maestro de equipos, las metas y las columnas propias?\n\nEsta acción no se puede deshacer.')) return;

    const btn = document.getElementById('btn-empezar-cero');
    const prev = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    try {
        await clearAllData();
        AppState.filesQueue = [];
        await renderDBStatus();
        alert('Base vacía. Subí las planillas y presioná "Procesar y Analizar".');
    } catch (e) {
        console.error('Error limpiando la base:', e);
        alert('No se pudo limpiar: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = prev; }
    }
}

export function irA(vista) {
    AppState.currentView = vista;
    document.querySelectorAll('.app-nav button').forEach(b => b.classList.toggle('active', b.id === `nav-${vista}`));
    document.querySelectorAll('.view-section').forEach(v => {
        const activa = v.id === `view-${vista}`;
        v.classList.toggle('active', activa);
        v.classList.toggle('hidden', !activa);
    });
    if (vista === 'panel') renderPanel();
    if (vista === 'datos') renderDataTable();
    if (vista === 'seguimiento') renderSeguimiento();
    if (vista === 'rendimiento') renderRendimiento(document.getElementById('view-rendimiento'), window.ultimoAnalisis);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setupNavigation() {
    document.querySelectorAll('.app-nav button').forEach(btn => {
        btn.addEventListener('click', () => irA(btn.id.replace('nav-', '')));
    });
}

function setupAIPanel() {
    const panel = document.getElementById('ai-panel');
    const header = panel?.querySelector('.ai-header');
    const btn = panel?.querySelector('#btn-toggle-ai');
    if (!header || !panel || !btn) return;

    header.addEventListener('click', () => {
        panel.classList.toggle('collapsed');
        const icon = btn.querySelector('i');
        if (icon) {
            const col = panel.classList.contains('collapsed');
            icon.classList.toggle('fa-chevron-up', col);
            icon.classList.toggle('fa-chevron-down', !col);
        }
    });
}
