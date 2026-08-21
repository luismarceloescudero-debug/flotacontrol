/**
 * FlotaControl - Arranque y navegación.
 */
import { initDB, clearAllData, clearMovimientos, getDBStats } from './data/database.js';
import { initUploadUI, renderDBStatus } from './ui/upload.js';
import { renderPanel, initPanelControls, buscarEquipo } from './ui/panel.js';
import { renderDataTable, initDataTableControls, exportarTablaVisible, abrirTablaConBusqueda } from './ui/datatable.js';
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

    window.exportTableToXLSX = exportarTablaVisible;
    window.showDataTable = (t) => { irA('datos'); renderDataTable(t); };
    window.renderPanel = renderPanel;
    // Punto único para navegar a Base de Datos con una búsqueda ya aplicada (interno/dominio),
    // usado desde los hallazgos del diagnóstico y desde las tarjetas del Panel. Antes esos
    // botones llamaban a `window.renderDataTable`, que nunca se publicó acá — por eso no hacían
    // nada ("Ver cargas" y las acciones de alta/asignación de los hallazgos, entre otras).
    window.abrirTablaConBusqueda = (tipo, query = '', buscarCol = 'id', periodo = null) => {
        irA('datos');
        return abrirTablaConBusqueda(tipo, query, buscarCol, periodo);
    };
    // Usado desde la vista de Seguimiento: volver al Panel ya con la tarjeta del equipo buscada
    // y a la vista, en vez de solo cambiar de pestaña y dejar que el usuario la busque a mano.
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
 * Re-analizar: da a elegir entre borrar solo los movimientos (conservando el padrón y las
 * correcciones hechas a mano) o borrar absolutamente todo. Lo primero es lo habitual al
 * cargar los archivos de un mes nuevo; lo segundo, para empezar de cero.
 */
async function reanalizar() {
    let s;
    try { s = await getDBStats(); } catch (e) { s = null; }

    const detalle = s ? `\n\nHoy hay guardados:\n· ${s.equipos} equipos en el maestro (${s.conMeta} con meta)\n· ${s.movimientos} movimientos` : '';
    const soloMovimientos = confirm(
        `¿Qué querés borrar?${detalle}\n\n` +
        `ACEPTAR = borrar solo los movimientos (cargas, GPS, etc.) y conservar el maestro con tus ediciones.\n` +
        `CANCELAR = elegir borrar todo.`
    );

    let accion;
    if (soloMovimientos) accion = 'movimientos';
    else {
        if (!confirm('¿Borrar TODO, incluido el maestro de equipos, las metas y las columnas propias?\n\nEsta acción no se puede deshacer.')) return;
        accion = 'todo';
    }

    const btn = document.getElementById('btn-reanalizar');
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        if (accion === 'todo') await clearAllData(); else await clearMovimientos();
        AppState.filesQueue = [];
        await renderDBStatus();
        irA('upload');
        alert(accion === 'todo'
            ? 'Base vacía. Subí las planillas y presioná "Procesar y Analizar".'
            : 'Movimientos borrados. El maestro quedó intacto: subí las planillas del período y procesá.');
    } catch (e) {
        console.error('Error limpiando la base:', e);
        alert('No se pudo limpiar: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = prev;
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
