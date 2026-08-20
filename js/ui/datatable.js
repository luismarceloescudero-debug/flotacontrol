/**
 * Vista "Base de Datos".
 *
 * Tres vistas de tabla, todas con la misma barra de búsqueda y filtros:
 *  - MAESTRO: el padrón (Equipos + Consumos Estimados fusionados). Totalmente editable:
 *    se puede corregir cualquier celda, agregar columnas propias y dar de alta equipos.
 *    Lo que se edita a mano queda marcado para que una reimportación no lo pise.
 *  - ESTIMADOS: misma estructura visual que el maestro, con columnas de comparación
 *    estimado vs meta actual. Acciones masivas: "Adoptar estimado como meta".
 *  - MOVIMIENTOS: cargas, GPS y cualquier planilla genérica (cubiertas, insumos, filtros…).
 *    Se muestran en solo lectura, con INTERNO + DOMINIO siempre visibles y filtros de
 *    año/mes, porque son el registro histórico de lo que pasó.
 *
 * Búsqueda mejorada: por defecto filtra por INTERNO / DOMINIO (las dos columnas de
 * identidad), con opción de ampliar a toda la tabla. Filtros adicionales de denominación
 * y estado (con/sin meta, editado, etc.) para maestro y estimados.
 *
 * Edición masiva: seleccionar filas con checkbox y aplicar acciones en lote.
 */
import {
    getAllEquipos, getAllRawRecords, getAllEstimados, updateEquipo, deleteEquipo, editarCampoEquipo,
    getColumnasExtra, setColumnasExtra, getTiposDeMovimiento, updateEstimado,
    huellaCarga, getCorreccionesCargas, saveCorreccionCarga, deleteCorreccionCarga,
    updateRawRecord, deleteRawRecord
} from '../data/database.js';
import { periodosDisponibles, filtrarPorPeriodo } from '../data/analyzer.js';
import { MESES, getDenominacion, normalizeEquipoKey, slugCampo } from '../data/normalizer.js';

const PAGINA = 300;

const estado = { tipo: 'maestro', buscar: '', buscarCol: 'id', filtroDeno: 'ALL', filtroEstado: 'ALL', anio: '', mes: '', pagina: 0, soloHuerfanas: false };
let filasActuales = [];
let columnasExtra = [];
let columnasVisibles = [];
const seleccionMasiva = new Set();

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Búsqueda inteligente: primero prueba por INTERNO y DOMINIO (los dos campos de
 * identidad, que son lo que más se busca). Si el usuario elige "Toda la tabla",
 * busca en el JSON completo de cada fila.
 */
function matchBusqueda(fila, q) {
    if (!q) return true;
    const upper = q.toUpperCase();
    if (estado.buscarCol === 'id') {
        const interno = (fila.interno || fila.interno_key || '').toUpperCase();
        const dominio = (fila.dominio || fila.dominio_key || '').toUpperCase();
        return interno.includes(upper) || dominio.includes(upper);
    }
    return JSON.stringify(fila).toUpperCase().includes(upper);
}

export async function renderDataTable(tipo) {
    if (tipo) { estado.tipo = tipo; estado.pagina = 0; estado.soloHuerfanas = false; }
    const tbody = document.getElementById('table-body');
    const header = document.getElementById('table-header');
    if (!tbody || !header) return;

    // Sincronizar el input de búsqueda con el estado interno: si se llegó acá desde
    // abrirTablaConBusqueda() el valor ya está en `estado.buscar`, pero el <input> del DOM
    // sigue mostrando lo que había antes si no se actualiza acá también.
    const inputBuscar = document.getElementById('tabla-buscar');
    if (inputBuscar && inputBuscar.value !== estado.buscar) inputBuscar.value = estado.buscar;
    const selCol = document.getElementById('tabla-buscar-col');
    if (selCol && selCol.value !== estado.buscarCol) selCol.value = estado.buscarCol;

    tbody.innerHTML = '<tr><td colspan="10">Cargando...</td></tr>';

    try {
        await renderTabs();
        columnasExtra = await getColumnasExtra();

        if (estado.tipo === 'maestro') await renderMaestro();
        else if (estado.tipo === 'estimados') await renderEstimados();
        else await renderMovimientos(estado.tipo);
    } catch (e) {
        console.error('Error al renderizar la tabla:', e);
        tbody.innerHTML = `<tr><td colspan="10" style="color:var(--accent-red)">Error: ${esc(e.message)}</td></tr>`;
    }
}

/**
 * Punto de entrada único para "ir a la tabla y buscar algo" desde otras vistas (Panel,
 * diagnóstico, hallazgos). Antes cada botón intentaba llamar a `window.renderDataTable`
 * directamente, pero esa función nunca se publicaba en `window` — por eso "Ver cargas" y
 * varias acciones de los hallazgos no hacían nada. Ahora todo pasa por acá, que sí queda
 * expuesta como `window.abrirTablaConBusqueda` desde app.js.
 */
export function abrirTablaConBusqueda(tipo, query = '', buscarCol = 'id') {
    estado.tipo = tipo || estado.tipo;
    estado.buscar = query || '';
    estado.buscarCol = buscarCol;
    estado.pagina = 0;
    return renderDataTable(estado.tipo);
}

async function renderTabs() {
    const cont = document.getElementById('tabla-tabs');
    if (!cont) return;
    const tipos = await getTiposDeMovimiento();
    const equipos = await getAllEquipos();

    const estimados = await getAllEstimados();
    const tabs = [
        { tipo: 'maestro', etiqueta: 'Maestro de Equipos', n: equipos.length },
        { tipo: 'estimados', etiqueta: 'Consumos Estimados', n: estimados.length },
        ...tipos
    ];
    cont.innerHTML = tabs.map(t => `
        <button class="btn-tab ${estado.tipo === t.tipo ? 'active' : ''}" data-tipo="${esc(t.tipo)}">
            ${esc(t.etiqueta || t.tipo)} <span class="tab-n">${nf(t.n)}</span>
        </button>`).join('');

    cont.querySelectorAll('.btn-tab').forEach(b => {
        b.addEventListener('click', () => renderDataTable(b.dataset.tipo));
    });
}

// ============================================================ MAESTRO

const CAMPOS_MAESTRO = [
    { k: 'interno', label: 'Interno', clave: true },
    { k: 'dominio', label: 'Dominio', editable: true },
    { k: 'denominacion', label: 'Denominación', editable: true },
    { k: 'marca', label: 'Marca', editable: true },
    { k: 'modelo', label: 'Modelo', editable: true },
    { k: 'anio', label: 'Año', editable: true, num: true },
    { k: 'potencia', label: 'Potencia', editable: true },
    { k: 'capacidad', label: 'Capacidad', editable: true },
    { k: 'meta_valor', label: 'Meta', editable: true, num: true },
    { k: 'meta_unidad', label: 'Unidad', editable: true, opciones: ['', 'L/Hora', 'L/100Km', 'No Aplica'] },
    { k: 'ubicacion', label: 'Ubicación', editable: true },
    { k: 'equipo_asociado', label: 'Equipo asociado', editable: true }
];

async function renderMaestro() {
    const equipos = await getAllEquipos();
    document.getElementById('table-title').textContent = 'Maestro de Equipos';
    document.getElementById('table-desc').innerHTML =
        'Padrón + metas de consumo en una sola tabla. <strong>Todas las celdas son editables</strong> y lo que corrijas a mano queda protegido: si volvés a importar la planilla, no se pisa. La llave es <strong>interno + dominio</strong>.';
    mostrarBotonesMaestro(true);
    mostrarBotonesEstimados(false);
    mostrarFiltrosFecha(false);
    mostrarFiltrosMaestro(true);
    mostrarBulkBar(true);

    // Poblar filtro de denominación
    const denos = [...new Set(equipos.map(e => e.denominacion || getDenominacion(e.interno, e.tipo)).filter(Boolean))].sort();
    const selDeno = document.getElementById('tabla-filtro-deno');
    if (selDeno) {
        const actual = selDeno.value || 'ALL';
        selDeno.innerHTML = '<option value="ALL">Todas las denom.</option>' + denos.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
        selDeno.value = denos.includes(actual) ? actual : 'ALL';
    }

    let filas = equipos.slice().sort((a, b) => (a.interno || '').localeCompare(b.interno || ''));

    // Filtro de búsqueda inteligente
    if (estado.buscar) filas = filas.filter(e => matchBusqueda(e, estado.buscar));

    // Filtro de denominación
    if (estado.filtroDeno !== 'ALL') {
        filas = filas.filter(e => (e.denominacion || getDenominacion(e.interno, e.tipo)) === estado.filtroDeno);
    }

    // Filtro de estado
    if (estado.filtroEstado !== 'ALL') {
        if (estado.filtroEstado === 'con_meta') filas = filas.filter(e => e.meta_valor > 0);
        else if (estado.filtroEstado === 'sin_meta') filas = filas.filter(e => !e.meta_valor);
        else if (estado.filtroEstado === 'editado') filas = filas.filter(e => e.editado_manual && e.editado_manual.length > 0);
    }

    filasActuales = filas;
    columnasVisibles = [...CAMPOS_MAESTRO.map(c => c.label), ...columnasExtra.map(c => c.label)];

    document.getElementById('table-header').innerHTML =
        '<th class="th-sel"><input type="checkbox" id="th-sel-all" title="Seleccionar todos"></th>' +
        CAMPOS_MAESTRO.map(c => `<th>${esc(c.label)}</th>`).join('') +
        columnasExtra.map(c => `<th class="th-extra">${esc(c.label)}
            <button class="th-del" data-col="${esc(c.id)}" title="Eliminar columna"><i class="fa-solid fa-xmark"></i></button></th>`).join('') +
        '<th class="th-acciones"></th>';

    const pagina = filas.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
    document.getElementById('table-body').innerHTML = pagina.map(e => {
        const editados = e.editado_manual || [];
        const tieneAsociado = e.equipo_asociado ? 'row-asociado' : '';
        const sel = seleccionMasiva.has(e.interno);
        return `<tr data-interno="${esc(e.interno)}" class="${tieneAsociado} ${sel ? 'row-sel' : ''}" ${e.equipo_asociado ? `title="Asociado a ${esc(e.equipo_asociado)}"` : ''}>
            <td class="td-sel"><input type="checkbox" class="chk-fila" data-interno="${esc(e.interno)}" ${sel ? 'checked' : ''}></td>
            ${CAMPOS_MAESTRO.map(c => {
                const v = c.k === 'denominacion' ? (e.denominacion || getDenominacion(e.interno, e.tipo)) : (e[c.k] ?? '');
                if (c.clave) return `<td class="cell-key">${esc(v)}</td>`;
                const marca = editados.includes(c.k) ? ' cell-editado' : '';
                if (c.opciones) {
                    return `<td class="cell-edit${marca}"><select data-campo="${c.k}">
                        ${c.opciones.map(o => `<option value="${o}" ${String(v) === o ? 'selected' : ''}>${o || '—'}</option>`).join('')}
                    </select></td>`;
                }
                return `<td class="cell-edit${marca}" contenteditable="true" data-campo="${c.k}" data-num="${c.num ? 1 : 0}">${esc(v)}</td>`;
            }).join('')}
            ${columnasExtra.map(c => `<td class="cell-edit" contenteditable="true" data-extra="${esc(c.id)}">${esc((e.extra || {})[c.id] ?? '')}</td>`).join('')}
            <td class="th-acciones"><button class="btn-icon btn-del-row" title="Eliminar equipo"><i class="fa-solid fa-trash"></i></button></td>
        </tr>`;
    }).join('') || '<tr><td colspan="14">No hay equipos en el maestro. Subí la planilla de Equipos o agregá uno con el botón "Equipo".</td></tr>';

    actualizarContador(filas.length, pagina.length);
    actualizarSelCount();
    renderPaginacion(filas.length);
    conectarEdicionMaestro();
    conectarCheckboxes();
}

function conectarEdicionMaestro() {
    const tbody = document.getElementById('table-body');

    tbody.querySelectorAll('td[contenteditable]').forEach(td => {
        td.addEventListener('blur', async () => {
            const tr = td.closest('tr');
            const interno = tr.dataset.interno;
            const texto = td.innerText.trim();
            try {
                if (td.dataset.extra) {
                    await editarCampoEquipo(interno, td.dataset.extra, texto, true);
                } else {
                    const campo = td.dataset.campo;
                    const valor = td.dataset.num === '1' ? (parseFloat(texto.replace(',', '.')) || 0) : texto.toUpperCase();
                    await editarCampoEquipo(interno, campo, valor);
                    if (campo === 'meta_valor') {
                        const eq = (await getAllEquipos()).find(x => x.interno === interno);
                        if (eq) { eq.meta_texto = `${valor} ${eq.meta_unidad === 'L/Hora' ? 'L/hora' : 'L/100km'}`; await updateEquipo(eq); }
                    }
                    if (campo === 'dominio') {
                        const eq = (await getAllEquipos()).find(x => x.interno === interno);
                        if (eq) { eq.dominio_key = normalizeEquipoKey(valor); await updateEquipo(eq); }
                    }
                }
                td.classList.add('cell-editado');
                flash(td);
                if (typeof window.renderPanel === 'function') window.renderPanel();
            } catch (e) { console.error(e); td.classList.add('cell-error'); }
        });
    });

    tbody.querySelectorAll('select[data-campo]').forEach(sel => {
        sel.addEventListener('change', async () => {
            const interno = sel.closest('tr').dataset.interno;
            await editarCampoEquipo(interno, sel.dataset.campo, sel.value);
            if (sel.dataset.campo === 'meta_unidad') {
                await editarCampoEquipo(interno, 'tipo_calculo_manual', sel.value || null);
            }
            flash(sel.closest('td'));
            if (typeof window.renderPanel === 'function') window.renderPanel();
        });
    });

    tbody.querySelectorAll('.btn-del-row').forEach(b => {
        b.addEventListener('click', async () => {
            const interno = b.closest('tr').dataset.interno;
            if (!confirm(`¿Eliminar el equipo ${interno} del maestro?\n\nSus movimientos quedan en la base pero pasan a figurar como "sin padrón".`)) return;
            await deleteEquipo(interno);
            renderDataTable();
            if (typeof window.renderPanel === 'function') window.renderPanel();
        });
    });

    document.querySelectorAll('.th-del').forEach(b => {
        b.addEventListener('click', async () => {
            if (!confirm('¿Eliminar esta columna del maestro? Se pierden sus valores.')) return;
            await setColumnasExtra(columnasExtra.filter(c => c.id !== b.dataset.col));
            renderDataTable();
        });
    });
}

function flash(el) {
    el.classList.add('cell-guardado');
    setTimeout(() => el.classList.remove('cell-guardado'), 900);
}

// ============================================================ CONSUMOS ESTIMADOS

/**
 * Los estimados ahora se muestran en una tabla con la misma estructura que el maestro:
 * editable, con checkboxes para selección masiva, y con una columna de comparación
 * "Estimado vs Meta actual" que muestra cuál es la diferencia.
 */
async function renderEstimados() {
    const estimados = await getAllEstimados();
    const equipos = await getAllEquipos();
    const rawRecords = await getAllRawRecords();

    document.getElementById('table-title').textContent = 'Consumos Estimados';
    document.getElementById('table-desc').innerHTML =
        'Metas de consumo importadas de la planilla. La columna <strong>"vs Meta"</strong> muestra la diferencia con la meta actual del maestro. ' +
        'Usá <strong>"Adoptar estimado como meta"</strong> en la barra de acciones para trasladar el estimado al maestro de un grupo de equipos.';
    mostrarBotonesMaestro(false);
    mostrarBotonesEstimados(true);
    mostrarFiltrosFecha(false);
    mostrarFiltrosMaestro(true);
    mostrarBulkBar(true);

    // Enriquecer estimados con datos del equipo y detección de "sin actividad"
    const cargasPorInterno = new Map();
    const gpsPorInterno = new Map();
    rawRecords.forEach(r => {
        const k = r.interno_key || r.interno || '';
        if (r.type === 'carga') { cargasPorInterno.set(k, (cargasPorInterno.get(k) || 0) + 1); }
        if (r.type === 'gps') { gpsPorInterno.set(k, (gpsPorInterno.get(k) || 0) + 1); }
    });

    let filas = estimados.map(e => {
        const key = normalizeEquipoKey(e.interno);
        const eq = equipos.find(x => (x.interno_key || normalizeEquipoKey(x.interno)) === key);
        const nCargas = cargasPorInterno.get(key) || 0;
        const nGps = gpsPorInterno.get(key) || 0;
        return {
            ...e,
            denominacion: eq?.denominacion || getDenominacion(e.interno, ''),
            dominio: eq?.dominio || '',
            meta_actual: eq?.meta_valor || 0,
            meta_unidad_actual: eq?.meta_unidad || '',
            en_maestro: !!eq,
            cargas: nCargas,
            gps: nGps,
            sin_actividad: nCargas > 0 && nGps === 0
        };
    }).sort((a, b) => (a.interno || '').localeCompare(b.interno || ''));

    // Poblar filtro de denominación
    const denos = [...new Set(filas.map(f => f.denominacion).filter(Boolean))].sort();
    const selDeno = document.getElementById('tabla-filtro-deno');
    if (selDeno) {
        const actual = selDeno.value || 'ALL';
        selDeno.innerHTML = '<option value="ALL">Todas las denom.</option>' + denos.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
        selDeno.value = denos.includes(actual) ? actual : 'ALL';
    }

    // Aplicar filtros
    if (estado.buscar) filas = filas.filter(e => matchBusqueda(e, estado.buscar));
    if (estado.filtroDeno !== 'ALL') filas = filas.filter(e => e.denominacion === estado.filtroDeno);
    if (estado.filtroEstado !== 'ALL') {
        if (estado.filtroEstado === 'con_meta') filas = filas.filter(e => e.meta_actual > 0);
        else if (estado.filtroEstado === 'sin_meta') filas = filas.filter(e => !e.meta_actual);
        else if (estado.filtroEstado === 'con_estimado') filas = filas.filter(e => e.consumo_estimado_valor > 0);
    }

    filasActuales = filas;

    const cols = [
        '', 'Interno', 'Dominio', 'Denominación',
        'Estimado', 'Unidad',
        'Meta actual', 'vs Meta',
        'Cargas', 'GPS', 'Estado'
    ];
    document.getElementById('table-header').innerHTML =
        '<th class="th-sel"><input type="checkbox" id="th-sel-all" title="Seleccionar todos"></th>' +
        cols.slice(1).map(c => `<th>${esc(c)}</th>`).join('');

    const pagina = filas.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
    document.getElementById('table-body').innerHTML = pagina.map(e => {
        const sel = seleccionMasiva.has(e.interno);
        const estadoTxt = !e.en_maestro ? '<span class="badge-warn">Sin maestro</span>'
            : e.sin_actividad ? '<span class="badge-warn">Sin actividad</span>'
            : e.gps > 0 ? '<span class="badge-ok">Con GPS</span>'
            : '<span class="badge-neutral">—</span>';

        // Comparación estimado vs meta
        let vsMeta = '';
        if (e.consumo_estimado_valor && e.meta_actual) {
            const diff = ((e.consumo_estimado_valor - e.meta_actual) / e.meta_actual * 100);
            const cls = Math.abs(diff) < 5 ? 'cmp-ok' : (diff > 0 ? 'cmp-alto' : 'cmp-bajo');
            vsMeta = `<span class="${cls}">${diff > 0 ? '+' : ''}${nf(diff, 0)}%</span>`;
        } else if (e.consumo_estimado_valor && !e.meta_actual) {
            vsMeta = '<span class="cmp-nuevo">sin meta</span>';
        } else {
            vsMeta = '<span class="cell-muted">—</span>';
        }

        return `<tr data-interno="${esc(e.interno)}" class="${sel ? 'row-sel' : ''}">
            <td class="td-sel"><input type="checkbox" class="chk-fila" data-interno="${esc(e.interno)}" ${sel ? 'checked' : ''}></td>
            <td class="cell-key">${esc(e.interno)}</td>
            <td>${esc(e.dominio)}</td>
            <td>${esc(e.denominacion)}</td>
            <td class="cell-num"><strong>${e.consumo_estimado_valor ? nf(e.consumo_estimado_valor, 2) : '—'}</strong></td>
            <td>${esc(e.consumo_estimado_unidad || '')}</td>
            <td class="cell-num">${e.meta_actual ? nf(e.meta_actual, 2) : '<span class="cell-muted">—</span>'}</td>
            <td class="cell-num">${vsMeta}</td>
            <td class="cell-num">${nf(e.cargas)}</td>
            <td class="cell-num">${nf(e.gps)}</td>
            <td>${estadoTxt}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="11">No hay datos de consumos estimados. Subí la planilla de Consumos Estimados.</td></tr>';

    actualizarContador(filas.length, pagina.length,
        `${filas.filter(e => e.sin_actividad).length} sin actividad · ${filas.filter(e => !e.meta_actual && e.consumo_estimado_valor).length} sin meta`);
    actualizarSelCount();
    renderPaginacion(filas.length);
    conectarCheckboxes();
}

// ============================================================ MOVIMIENTOS

/** Columnas fijas por tipo conocido; el resto se arma con las columnas del propio Excel. */
const COLS_MOV = {
    carga: [
        { k: 'fecha', label: 'Fecha' }, { k: 'litros', label: 'Litros', num: 2 },
        { k: 'importe', label: 'Importe', money: true }, { k: 'combustible', label: 'Combustible' },
        { k: 'lugar_carga', label: 'Lugar' }, { k: 'centro_costo', label: 'Centro de costo' },
        { k: 'chofer', label: 'Chofer' }
    ],
    gps: [
        { k: 'fecha', label: 'Desde' }, { k: 'fecha_hasta', label: 'Hasta' },
        { k: 'distancia', label: 'Km', num: 0 },
        { k: '_ralenti', label: 'Hs ralentí', num: 1 }, { k: '_movimiento', label: 'Hs movimiento', num: 1 },
        { k: '_total', label: 'Hs total', num: 1, fuerte: true }
    ]
};

async function renderMovimientos(tipo) {
    const todos = (await getAllRawRecords()).filter(r => r.type === tipo);
    const etiqueta = todos[0]?.type_label || tipo;

    document.getElementById('table-title').textContent = etiqueta;
    document.getElementById('table-desc').innerHTML = tipo === 'carga'
        ? 'Registro histórico de cargas. Las filas marcadas en naranja tienen un interno desconocido — hacé clic en <strong>Corregir</strong> para asignarlas a un equipo o eliminarlas. La corrección se guarda y se re-aplica automáticamente al reimportar el mismo archivo.'
        : 'Registro histórico, en solo lectura. Se muestra <strong>interno + dominio</strong> de cada fila: es la llave con la que se cruza contra el maestro.';
    mostrarBotonesMaestro(false);
    mostrarBotonesEstimados(false);
    mostrarFiltrosFecha(true);
    mostrarFiltrosMaestro(false);
    mostrarBulkBar(false);
    poblarFiltrosFecha(todos);

    // Para cargas: armar el set de internos del maestro y el mapa de correcciones ya guardadas
    let equiposSet = new Set();
    let correccionesMap = new Map();
    if (tipo === 'carga') {
        const [eqs, corrs] = await Promise.all([getAllEquipos(), getCorreccionesCargas()]);
        eqs.forEach(e => equiposSet.add(e.interno_key || normalizeEquipoKey(e.interno)));
        corrs.forEach(c => correccionesMap.set(c.huella, c));
    }

    let filas = filtrarPorPeriodo(todos, { anio: estado.anio || null, mes: estado.mes || null });
    if (estado.buscar) filas = filas.filter(r => matchBusqueda(r, estado.buscar));
    // Filtro "Solo sin asignar" (huérfanas)
    if (tipo === 'carga' && estado.soloHuerfanas) {
        filas = filas.filter(r => {
            const ikey = r.interno_key || normalizeEquipoKey(r.interno || '');
            const esHuerfana = !ikey || !equiposSet.has(ikey);
            const yaCorregida = correccionesMap.has(huellaCarga(r));
            return esHuerfana && !yaCorregida;
        });
    }
    filas.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    filasActuales = filas;

    // Columnas: identidad siempre primero, después las propias del tipo.
    let cols = COLS_MOV[tipo];
    if (!cols) {
        const muestra = filas[0]?.datos || {};
        cols = Object.keys(muestra)
            .filter(c => !/INTERNO|DOMINIO|PATENTE|UNIDAD|MATRICULA/.test(c))
            .slice(0, 12)
            .map(c => ({ k: `datos.${c}`, label: c }));
    }
    columnasVisibles = ['Interno', 'Dominio', ...cols.map(c => c.label)];

    const colspan = cols.length + 2 + (tipo === 'carga' ? 1 : 0);
    document.getElementById('table-header').innerHTML =
        '<th>Interno</th><th>Dominio</th>' + cols.map(c => `<th>${esc(c.label)}</th>`).join('') +
        (tipo === 'carga' ? '<th class="th-acciones"></th>' : '');

    const pagina = filas.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
    let nHuerfanas = 0;

    document.getElementById('table-body').innerHTML = pagina.map(r => {
        const h = (r.horas && typeof r.horas === 'object') ? r.horas : { ralenti: 0, movimiento: parseFloat(r.horas) || 0, total: parseFloat(r.horas) || 0 };

        let esHuerfana = false;
        let yaCorregida = false;
        if (tipo === 'carga') {
            const ikey = r.interno_key || normalizeEquipoKey(r.interno || '');
            esHuerfana = !ikey || !equiposSet.has(ikey);
            yaCorregida = correccionesMap.has(huellaCarga(r));
            if (esHuerfana && !yaCorregida) nHuerfanas++;
        }

        const rowClass = esHuerfana && !yaCorregida ? 'carga-huerfana' : (yaCorregida ? 'carga-corregida' : '');
        const dataAttrs = tipo === 'carga' ? ` data-recid="${r.id}"` : '';
        const accionTd = tipo === 'carga' ? `<td class="td-correc">${
            esHuerfana && !yaCorregida
                ? `<button class="btn-corregir-carga btn-warn btn-sm"><i class="fa-solid fa-wand-magic-sparkles"></i> Corregir</button>`
                : (yaCorregida ? `<span class="badge-corregida"><i class="fa-solid fa-check"></i> Corregido</span>` : '')
        }</td>` : '';

        return `<tr${rowClass ? ` class="${rowClass}"` : ''}${dataAttrs}>
            <td class="cell-key">${esc(r.interno || '—')}</td>
            <td class="cell-dom">${esc(r.dominio || '—')}</td>
            ${cols.map(c => {
                let v;
                if (c.k === '_ralenti') v = nf(h.ralenti, 1);
                else if (c.k === '_movimiento') v = nf(h.movimiento, 1);
                else if (c.k === '_total') v = `<strong>${nf(h.total, 1)}</strong>`;
                else if (c.k.startsWith('datos.')) v = esc(r.datos?.[c.k.slice(6)] ?? '');
                else if (c.money) v = `$${nf(r[c.k], 2)}`;
                else if (c.num !== undefined) v = nf(r[c.k], c.num);
                else v = esc(r[c.k] ?? '');
                return `<td>${v}</td>`;
            }).join('')}
            ${accionTd}
        </tr>`;
    }).join('') || `<tr><td colspan="${colspan}">No hay registros${estado.anio || estado.mes ? ' en el período elegido' : ''}.</td></tr>`;

    // Botón "Sin asignar" en contador (solo cargas)
    let btnHuerfanasHtml = '';
    if (tipo === 'carga') {
        const nHuerfanasTotal = todos.filter(r => {
            const ikey = r.interno_key || normalizeEquipoKey(r.interno || '');
            return (!ikey || !equiposSet.has(ikey)) && !correccionesMap.has(huellaCarga(r));
        }).length;
        if (nHuerfanasTotal > 0) {
            const activo = estado.soloHuerfanas ? ' btn-warn-active' : '';
            btnHuerfanasHtml = ` <button class="btn-sm btn-warn btn-filtro-huerfanas${activo}" style="margin-left:8px">` +
                `<i class="fa-solid fa-triangle-exclamation"></i> ${estado.soloHuerfanas ? 'Todos' : `Sin asignar (${nHuerfanasTotal})`}</button>`;
        }
    }
    const resExtra = tipo === 'carga' && nHuerfanas > 0 && !estado.soloHuerfanas
        ? ` · <span style="color:#f5a623;font-weight:600">${nHuerfanas} sin asignar</span>` : '';
    actualizarContador(filas.length, pagina.length, resumenNumerico(filas, tipo) + resExtra + btnHuerfanasHtml);
    renderPaginacion(filas.length);

    // Listener del botón filtro huérfanas
    document.querySelector('.btn-filtro-huerfanas')?.addEventListener('click', () => {
        estado.soloHuerfanas = !estado.soloHuerfanas;
        estado.pagina = 0;
        renderDataTable();
    });

    // Listener delegado para el panel de corrección (solo cargas)
    if (tipo === 'carga') {
        const tbody = document.getElementById('table-body');
        tbody.addEventListener('click', async (e) => {
            const btn = e.target.closest('.btn-corregir-carga');
            if (!btn) return;
            const tr = btn.closest('tr');
            const recid = parseInt(tr.dataset.recid, 10);
            const record = todos.find(r => r.id === recid);
            if (!record) return;

            // Toggle: cerrar si ya está abierto para esta misma fila
            const prevPanel = tbody.querySelector('.carga-correccion-row');
            if (prevPanel) {
                const esMismaFila = prevPanel.previousElementSibling === tr;
                prevPanel.remove();
                if (esMismaFila) return;
            }

            const equipos = await getAllEquipos();
            const panelTr = buildCorrecionRow(record, todos, equipos, colspan);
            tr.insertAdjacentElement('afterend', panelTr);
            conectarPanelCorreccion(panelTr, record, todos);
        });
    }
}

/** Construye el <tr> con el panel de corrección inline para una carga huérfana. */
function buildCorrecionRow(record, todasCargas, equipos, colspan) {
    const fecha = record.fecha || '';
    const anioMes = fecha.slice(0, 7); // 'YYYY-MM'

    // Calcular actividad por período y día para el ranking de candidatos
    const cargasDia = new Map();     // interno_key → n cargas ese día exacto
    const cargasPeriodo = new Map(); // interno_key → n cargas en el mismo mes
    todasCargas.forEach(r => {
        const ik = r.interno_key || normalizeEquipoKey(r.interno || '');
        if (!ik) return;
        if (r.fecha === fecha) cargasDia.set(ik, (cargasDia.get(ik) || 0) + 1);
        if (anioMes && r.fecha && r.fecha.startsWith(anioMes)) {
            cargasPeriodo.set(ik, (cargasPeriodo.get(ik) || 0) + 1);
        }
    });

    const candidatos = equipos.map(eq => {
        const ik = eq.interno_key || normalizeEquipoKey(eq.interno);
        let score = 0;
        const razones = [];
        const nPer = cargasPeriodo.get(ik) || 0;
        const nDia = cargasDia.get(ik) || 0;

        if (nPer > 0) { score += 2; razones.push('activo en el período'); }
        else score -= 1;

        if (nDia === 0 && nPer > 0) { score += 1; razones.push('no cargó ese día'); }
        else if (nDia > 0) { score -= 3; razones.push('ya cargó ese día'); }

        if (record.centro_costo && eq.centro_costo && record.centro_costo === eq.centro_costo) {
            score += 2; razones.push('mismo CC');
        }
        if (record.lugar_carga && eq.ubicacion &&
            String(record.lugar_carga).toUpperCase().includes(String(eq.ubicacion).toUpperCase().slice(0, 4))) {
            score += 3; razones.push('mismo lugar');
        }

        return { eq, ik, score, razones, nDia, nPer };
    }).filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    const candidatosHtml = candidatos.length
        ? candidatos.map(c => `
            <div class="candidato-item">
                <div class="candidato-info">
                    <span class="candidato-interno">${esc(c.eq.interno)}</span>
                    <span class="candidato-deno">${esc(c.eq.denominacion || c.eq.marca || '')}</span>
                    <span class="candidato-score">Score ${c.score}</span>
                    <span class="candidato-razones">${c.razones.join(' · ')}</span>
                </div>
                <button class="btn-asignar-cand btn-primary btn-sm"
                    data-interno="${esc(c.eq.interno)}" data-dominio="${esc(c.eq.dominio || '')}">
                    Asignar a ${esc(c.eq.interno)}
                </button>
            </div>`).join('')
        : '<p class="correc-sin-cand">Sin candidatos claros para este período. Usá el campo manual.</p>';

    const listaSugg = equipos
        .map(e => `<option value="${esc(e.interno)}">${esc(e.interno)}${e.denominacion ? ' – ' + esc(e.denominacion) : ''}</option>`)
        .join('');

    const tr = document.createElement('tr');
    tr.className = 'carga-correccion-row';
    tr.dataset.recid = record.id;
    tr.innerHTML = `<td colspan="${colspan}"><div class="correc-panel">
        <div class="correc-header">
            <span class="badge-huerfana"><i class="fa-solid fa-triangle-exclamation"></i> Sin asignar</span>
            <span class="correc-detalle">
                ${esc(record.fecha || '—')} &nbsp;·&nbsp;
                ${nf(record.litros, 1)} L &nbsp;·&nbsp;
                $${nf(record.importe, 2)} &nbsp;·&nbsp;
                Lugar: ${esc(record.lugar_carga || '—')} &nbsp;·&nbsp;
                CC: ${esc(record.centro_costo || '—')} &nbsp;·&nbsp;
                Chofer / interno original: <strong>${esc(record.interno || '—')}</strong>
            </span>
            <button class="btn-cerrar-correc btn-icon" title="Cerrar"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="correc-cuerpo">
            <div class="correc-candidatos-wrap">
                <p class="correc-titulo">Equipos candidatos — actividad del período</p>
                <div class="candidato-list">${candidatosHtml}</div>
            </div>
            <div class="correc-manual-wrap">
                <p class="correc-titulo">Asignación manual y datos extra</p>
                <div class="correc-manual-row">
                    <datalist id="correc-sugg-${record.id}">${listaSugg}</datalist>
                    <label class="correc-field-label">Interno</label>
                    <input type="text" class="correc-interno-input"
                        placeholder="Ej: MX66" list="correc-sugg-${record.id}" autocomplete="off">
                </div>
                <div class="correc-manual-row">
                    <label class="correc-field-label">Dominio</label>
                    <input type="text" class="correc-dominio-input"
                        placeholder="Ej: JNU923" value="${esc(record.dominio || '')}">
                </div>
                <div class="correc-manual-row">
                    <label class="correc-field-label">Centro de costo</label>
                    <input type="text" class="correc-cc-input"
                        placeholder="Ej: HORMIGÓN" value="${esc(record.centro_costo || '')}">
                </div>
                <div class="correc-manual-row">
                    <label class="correc-field-label">Lugar de carga</label>
                    <input type="text" class="correc-lugar-input"
                        placeholder="Ej: GRIS" value="${esc(record.lugar_carga || '')}">
                </div>
                <div class="correc-manual-row">
                    <label class="correc-field-label">Sector</label>
                    <input type="text" class="correc-sector-input"
                        placeholder="Ej: BOMBAS" value="${esc(record.sector || '')}">
                </div>
                <div class="correc-manual-row">
                    <label class="correc-field-label">Observación</label>
                    <input type="text" class="correc-obs-input"
                        placeholder="Nota libre" value="">
                </div>
                <div class="correc-manual-row" style="margin-top:10px">
                    <button class="btn-asignar-manual btn-primary btn-sm"><i class="fa-solid fa-check"></i> Guardar corrección</button>
                </div>
            </div>
        </div>
        <div class="correc-footer">
            <button class="btn-eliminar-carga btn-danger btn-sm">
                <i class="fa-solid fa-trash"></i> Eliminar registro
            </button>
            <span class="correc-footer-hint">La corrección se re-aplica automáticamente si reimportás el archivo.</span>
        </div>
    </div></td>`;
    return tr;
}

/** Conecta los handlers dentro del panel de corrección inline. */
function conectarPanelCorreccion(panelTr, record, todasCargas) {
    const huella = huellaCarga(record);

    function leerCamposExtra() {
        return {
            dominio_correcto:    (panelTr.querySelector('.correc-dominio-input')?.value || '').trim(),
            centro_costo_correcto: (panelTr.querySelector('.correc-cc-input')?.value || '').trim(),
            lugar_carga_correcto:  (panelTr.querySelector('.correc-lugar-input')?.value || '').trim(),
            sector_correcto:     (panelTr.querySelector('.correc-sector-input')?.value || '').trim(),
            observacion:         (panelTr.querySelector('.correc-obs-input')?.value || '').trim(),
        };
    }

    async function asignarA(interno, dominioHint) {
        interno = (interno || '').toUpperCase().trim();
        if (!interno) { alert('Ingresá un interno válido (ej: MX66).'); return; }
        // Misma normalización que se usa para cruzar Cargas/GPS/Equipos en todos lados
        // (normalizeEquipoKey saca ceros a la izquierda: BM07 y BM7 tienen que quedar con la
        // misma clave). Antes acá se armaba la clave a mano sin esa normalización, así que una
        // asignación manual podía terminar con una interno_key que no calzaba con el resto de
        // las planillas del mismo equipo — justo el tipo de desvío que puede afectar un análisis.
        const ikey = normalizeEquipoKey(interno);
        const extra = leerCamposExtra();
        const dominio = extra.dominio_correcto || dominioHint || '';
        await saveCorreccionCarga({
            huella,
            accion: 'asignar',
            interno_correcto: interno,
            dominio_correcto: dominio,
            centro_costo_correcto: extra.centro_costo_correcto,
            lugar_carga_correcto: extra.lugar_carga_correcto,
            sector_correcto: extra.sector_correcto,
            observacion: extra.observacion,
            interno_original: record.interno || '',
            fecha: record.fecha,
            litros: record.litros,
            importe: record.importe
        });
        const cambiosRecord = {
            interno,
            interno_key: ikey,
            dominio: dominio || record.dominio || '',
            dominio_key: normalizeEquipoKey(dominio || record.dominio || ''),
            _corregido: true,
            _interno_original: record.interno
        };
        if (extra.centro_costo_correcto) cambiosRecord.centro_costo = extra.centro_costo_correcto;
        if (extra.lugar_carga_correcto) cambiosRecord.lugar_carga = extra.lugar_carga_correcto;
        if (extra.sector_correcto) cambiosRecord.sector = extra.sector_correcto;
        await updateRawRecord(record.id, cambiosRecord);
        panelTr.remove();
        renderDataTable();
        if (typeof window.renderPanel === 'function') window.renderPanel();
    }

    panelTr.querySelectorAll('.btn-asignar-cand').forEach(btn => {
        btn.addEventListener('click', () => {
            // Pre-fill the interno/dominio fields from candidate
            const inpI = panelTr.querySelector('.correc-interno-input');
            const inpD = panelTr.querySelector('.correc-dominio-input');
            if (inpI) inpI.value = btn.dataset.interno;
            if (inpD && btn.dataset.dominio) inpD.value = btn.dataset.dominio;
            asignarA(btn.dataset.interno, btn.dataset.dominio);
        });
    });

    panelTr.querySelector('.btn-asignar-manual')?.addEventListener('click', () => {
        const inp = panelTr.querySelector('.correc-interno-input');
        asignarA(inp?.value, '');
    });

    panelTr.querySelector('.btn-eliminar-carga')?.addEventListener('click', async () => {
        const litros = nf(parseFloat(record.litros) || 0, 1);
        if (!confirm(`¿Eliminar este registro (${litros} L del ${record.fecha})?\n\nSi reimportás el archivo, el registro se va a omitir automáticamente.`)) return;
        await saveCorreccionCarga({
            huella,
            accion: 'eliminar',
            interno_original: record.interno || '',
            fecha: record.fecha,
            litros: record.litros,
            importe: record.importe
        });
        await deleteRawRecord(record.id);
        panelTr.remove();
        renderDataTable();
        if (typeof window.renderPanel === 'function') window.renderPanel();
    });

    panelTr.querySelector('.btn-cerrar-correc')?.addEventListener('click', () => panelTr.remove());
}

function resumenNumerico(filas, tipo) {
    if (tipo === 'carga') {
        const l = filas.reduce((s, r) => s + (parseFloat(r.litros) || 0), 0);
        const i = filas.reduce((s, r) => s + (parseFloat(r.importe) || 0), 0);
        return `${nf(l, 1)} L · $${nf(i)}`;
    }
    if (tipo === 'gps') {
        const km = filas.reduce((s, r) => s + (parseFloat(r.distancia) || 0), 0);
        const hs = filas.reduce((s, r) => s + ((r.horas && r.horas.total) || 0), 0);
        return `${nf(km)} km · ${nf(hs, 1)} hs`;
    }
    return '';
}

// ============================================================ SELECCIÓN MASIVA Y ACCIONES

function conectarCheckboxes() {
    const tbody = document.getElementById('table-body');
    const thSel = document.getElementById('th-sel-all');

    tbody.querySelectorAll('.chk-fila').forEach(ch => {
        ch.addEventListener('change', () => {
            if (ch.checked) seleccionMasiva.add(ch.dataset.interno);
            else seleccionMasiva.delete(ch.dataset.interno);
            ch.closest('tr').classList.toggle('row-sel', ch.checked);
            actualizarSelCount();
        });
    });

    if (thSel) {
        thSel.addEventListener('change', () => {
            const visibles = filasActuales.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
            if (thSel.checked) visibles.forEach(f => seleccionMasiva.add(f.interno));
            else visibles.forEach(f => seleccionMasiva.delete(f.interno));
            tbody.querySelectorAll('.chk-fila').forEach(ch => {
                ch.checked = seleccionMasiva.has(ch.dataset.interno);
                ch.closest('tr').classList.toggle('row-sel', ch.checked);
            });
            actualizarSelCount();
        });
    }
}

function actualizarSelCount() {
    const el = document.getElementById('tabla-sel-count');
    if (el) el.textContent = seleccionMasiva.size ? `${seleccionMasiva.size} seleccionados` : '';
    const chkTodos = document.getElementById('tabla-sel-todos');
    if (chkTodos) chkTodos.checked = seleccionMasiva.size > 0;
}

async function ejecutarAccionMasiva(accion) {
    if (!seleccionMasiva.size) { alert('No hay equipos seleccionados.'); return; }
    const internos = [...seleccionMasiva];

    switch (accion) {
        case 'adoptar_estimado': {
            const estimados = await getAllEstimados();
            const equipos = await getAllEquipos();
            let aplicados = 0;
            for (const int of internos) {
                const key = normalizeEquipoKey(int);
                const est = estimados.find(e => normalizeEquipoKey(e.interno) === key);
                if (!est || !est.consumo_estimado_valor) continue;
                const eq = equipos.find(e => (e.interno_key || normalizeEquipoKey(e.interno)) === key);
                if (!eq) continue;
                eq.meta_valor = est.consumo_estimado_valor;
                eq.meta_unidad = est.consumo_estimado_unidad || eq.meta_unidad || '';
                eq.meta_texto = `${est.consumo_estimado_valor} ${eq.meta_unidad === 'L/Hora' ? 'L/hora' : 'L/100km'}`;
                eq.meta_origen = 'Consumos Estimados (planilla)';
                eq.editado_manual = [...new Set([...(eq.editado_manual || []), 'meta_valor', 'meta_unidad', 'meta_texto'])];
                await updateEquipo(eq);
                aplicados++;
            }
            alert(`Listo: meta actualizada en ${aplicados} equipos desde los consumos estimados.`);
            break;
        }
        case 'limpiar_meta': {
            if (!confirm(`¿Limpiar la meta de ${internos.length} equipos?`)) return;
            const equipos = await getAllEquipos();
            let limpiados = 0;
            for (const int of internos) {
                const eq = equipos.find(e => e.interno === int);
                if (!eq) continue;
                eq.meta_valor = 0;
                eq.meta_texto = '';
                eq.meta_origen = '';
                eq.editado_manual = (eq.editado_manual || []).filter(c => c !== 'meta_valor' && c !== 'meta_texto');
                await updateEquipo(eq);
                limpiados++;
            }
            alert(`Meta limpiada en ${limpiados} equipos.`);
            break;
        }
        case 'set_unidad_lh':
        case 'set_unidad_lkm':
        case 'set_no_aplica': {
            const unidad = accion === 'set_unidad_lh' ? 'L/Hora' : (accion === 'set_unidad_lkm' ? 'L/100Km' : 'No Aplica');
            const equipos = await getAllEquipos();
            let cambiados = 0;
            for (const int of internos) {
                const eq = equipos.find(e => e.interno === int);
                if (!eq) continue;
                eq.meta_unidad = unidad;
                if (eq.meta_valor) eq.meta_texto = `${eq.meta_valor} ${unidad === 'L/Hora' ? 'L/hora' : (unidad === 'L/100Km' ? 'L/100km' : 'N/A')}`;
                eq.editado_manual = [...new Set([...(eq.editado_manual || []), 'meta_unidad'])];
                await updateEquipo(eq);
                cambiados++;
            }
            alert(`Unidad cambiada a "${unidad}" en ${cambiados} equipos.`);
            break;
        }
        default:
            alert('Acción no reconocida.');
            return;
    }

    seleccionMasiva.clear();
    renderDataTable();
    if (typeof window.renderPanel === 'function') window.renderPanel();
}

// ============================================================ UI compartida

function mostrarBotonesMaestro(v) {
    ['btn-add-col', 'btn-add-row'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.style.display = v ? '' : 'none';
    });
}

function mostrarBotonesEstimados(v) {
    const b = document.getElementById('btn-ajustar-metas-estimados');
    if (b) b.style.display = v ? '' : 'none';
}

function mostrarFiltrosFecha(v) {
    ['tabla-anio', 'tabla-mes'].forEach(id => {
        const s = document.getElementById(id);
        if (s) s.style.display = v ? '' : 'none';
    });
}

function mostrarFiltrosMaestro(v) {
    ['tabla-filtro-deno', 'tabla-filtro-estado'].forEach(id => {
        const s = document.getElementById(id);
        if (s) s.style.display = v ? '' : 'none';
    });
}

function mostrarBulkBar(v) {
    const bar = document.getElementById('tabla-bulk-bar');
    if (bar) bar.style.display = v ? '' : 'none';
    if (!v) seleccionMasiva.clear();
}

function poblarFiltrosFecha(records) {
    const { anios, meses } = periodosDisponibles(records);
    const a = document.getElementById('tabla-anio');
    const m = document.getElementById('tabla-mes');
    if (a) { a.innerHTML = '<option value="">Todos los años</option>' + anios.map(x => `<option value="${x}">${x}</option>`).join(''); a.value = estado.anio; }
    if (m) { m.innerHTML = '<option value="">Todos los meses</option>' + meses.map(x => `<option value="${x}">${MESES[x - 1]}</option>`).join(''); m.value = estado.mes; }
}

function actualizarContador(total, mostradas, extra = '') {
    const el = document.getElementById('tabla-count');
    if (el) el.textContent = `${nf(mostradas)} de ${nf(total)} filas${extra ? ' · ' + extra : ''}`;
}

function renderPaginacion(total) {
    const el = document.getElementById('tabla-paginacion');
    if (!el) return;
    const paginas = Math.ceil(total / PAGINA);
    if (paginas <= 1) { el.innerHTML = ''; return; }
    el.innerHTML = `
        <button class="btn-secondary btn-sm" ${estado.pagina === 0 ? 'disabled' : ''} data-p="${estado.pagina - 1}">← Anterior</button>
        <span>Página ${estado.pagina + 1} de ${paginas}</span>
        <button class="btn-secondary btn-sm" ${estado.pagina >= paginas - 1 ? 'disabled' : ''} data-p="${estado.pagina + 1}">Siguiente →</button>`;
    el.querySelectorAll('button[data-p]').forEach(b => b.addEventListener('click', () => {
        estado.pagina = parseInt(b.dataset.p, 10);
        renderDataTable();
    }));
}

export function initDataTableControls() {
    let deb;
    document.getElementById('tabla-buscar')?.addEventListener('input', e => {
        clearTimeout(deb);
        deb = setTimeout(() => { estado.buscar = e.target.value.trim(); estado.pagina = 0; renderDataTable(); }, 250);
    });
    document.getElementById('tabla-buscar-col')?.addEventListener('change', e => {
        estado.buscarCol = e.target.value;
        if (estado.buscar) { estado.pagina = 0; renderDataTable(); }
    });
    document.getElementById('tabla-filtro-deno')?.addEventListener('change', e => { estado.filtroDeno = e.target.value; estado.pagina = 0; renderDataTable(); });
    document.getElementById('tabla-filtro-estado')?.addEventListener('change', e => { estado.filtroEstado = e.target.value; estado.pagina = 0; renderDataTable(); });
    document.getElementById('tabla-anio')?.addEventListener('change', e => { estado.anio = e.target.value; estado.pagina = 0; renderDataTable(); });
    document.getElementById('tabla-mes')?.addEventListener('change', e => { estado.mes = e.target.value; estado.pagina = 0; renderDataTable(); });

    // Selección masiva global
    document.getElementById('tabla-sel-todos')?.addEventListener('change', e => {
        if (e.target.checked) filasActuales.forEach(f => seleccionMasiva.add(f.interno));
        else seleccionMasiva.clear();
        renderDataTable();
    });

    // Botón de acción masiva
    document.getElementById('tabla-bulk-aplicar')?.addEventListener('click', () => {
        const accion = document.getElementById('tabla-bulk-accion')?.value;
        if (!accion) { alert('Elegí una acción masiva del desplegable.'); return; }
        ejecutarAccionMasiva(accion);
    });

    document.getElementById('btn-ajustar-metas-estimados')?.addEventListener('click', () => {
        if (typeof window.abrirAjusteMetasDesdeTabla === 'function') {
            window.abrirAjusteMetasDesdeTabla('sin_meta');
        }
    });

    document.getElementById('btn-add-col')?.addEventListener('click', async () => {
        const label = prompt('Nombre de la nueva columna (ej: RESPONSABLE, N° DE MOTOR):');
        if (!label || !label.trim()) return;
        const id = slugCampo(label);
        if (columnasExtra.some(c => c.id === id)) { alert('Ya existe una columna con ese nombre.'); return; }
        await setColumnasExtra([...columnasExtra, { id, label: label.trim().toUpperCase() }]);
        renderDataTable();
    });

    document.getElementById('btn-add-row')?.addEventListener('click', async () => {
        const interno = prompt('Interno del equipo nuevo (ej: TR40):');
        if (!interno || !interno.trim()) return;
        const key = normalizeEquipoKey(interno);
        const existentes = await getAllEquipos();
        if (existentes.some(e => (e.interno_key || normalizeEquipoKey(e.interno)) === key)) { alert('Ese interno ya existe.'); return; }
        await updateEquipo({
            interno: key, interno_key: key, dominio: '', dominio_key: '',
            denominacion: getDenominacion(key, ''), marca: '', modelo: '',
            extra: {}, origen: ['Alta manual'], editado_manual: ['interno']
        });
        estado.tipo = 'maestro';
        renderDataTable();
        if (typeof window.renderPanel === 'function') window.renderPanel();
    });
}

/** Exporta a Excel exactamente lo que se está viendo (con filtros aplicados). */
export function exportarTablaVisible() {
    const tabla = document.getElementById('data-table');
    if (!tabla || !filasActuales.length) { alert('No hay datos para exportar.'); return; }
    const ws = XLSX.utils.table_to_sheet(tabla);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, estado.tipo.slice(0, 28));
    XLSX.writeFile(wb, `FlotaControl_${estado.tipo}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/** Compatibilidad con el onblur inline de versiones anteriores. */
export async function saveDBRow() { /* la edición ahora se maneja con listeners */ }
