/**
 * Vista "Base de Datos".
 *
 * Cuatro vistas de tabla, todas con la misma barra de búsqueda y filtros:
 *  - MAESTRO: el padrón (Equipos + Consumos Estimados fusionados). Totalmente editable:
 *    se puede corregir cualquier celda, agregar columnas propias y dar de alta equipos.
 *    Lo que se edita a mano queda marcado para que una reimportación no lo pise. Además de
 *    los campos del padrón, siempre muestra el CONSUMO REAL medido y la CANTIDAD DE CARGAS
 *    que lo respaldan (columnas calculadas, no editables): así "Base de Datos" deja de ser
 *    solo el padrón declarado y muestra también lo que la flota realmente consume.
 *  - ESTIMADOS: misma estructura visual que el maestro, con columnas de comparación
 *    estimado vs meta actual. Acciones masivas: "Adoptar estimado como meta".
 *  - CONSUMO REAL: la contraparte de Estimados, pero armada desde lo medido en vez de lo
 *    declarado — un equipo por fila, con su consumo real, cantidad de cargas, confiabilidad
 *    del dato y comparación contra la meta vigente. Pensada para investigar metas más fino
 *    de lo que permite mirar tarjeta por tarjeta en el Panel.
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
    updateRawRecord, deleteRawRecord, registrarEdicion, getEdicionesLog,
    getColLabelsMov, setColLabelMov,
    getSeguimientoEquipos, setSeguimientoEquipo, quitarSeguimientoEquipo
} from '../data/database.js';
import { periodosDisponibles, filtrarPorPeriodo } from '../data/analyzer.js';
import { esDiaHabil } from '../data/feriados.js';
import { confiabilidad, sugerirMeta, MIN_CARGAS_CONFIABLE, COBERTURA_MINIMA_PCT, consumoDesdeActividadDeclarada } from '../data/diagnostico.js';
import { MESES, getDenominacion, normalizeEquipoKey, slugCampo, formatFechaAR } from '../data/normalizer.js';

const PAGINA = 300;

const estado = { tipo: 'maestro', buscar: '', buscarCol: 'id', filtroDeno: 'ALL', filtroEstado: 'ALL', anio: '', mes: '', pagina: 0, soloHuerfanas: false, filtroCC: 'ALL', filtroLugar: 'ALL', orden: '', filtroCorrec: 'ALL' };
let filasActuales = [];
let columnasExtra = [];
let columnasVisibles = [];
let colLabelsMov = {};
const seleccionMasiva = new Set();
const seleccionMasivaMov = new Set(); // selección para edición masiva en tablas de movimientos (por r.id)
let seguimientoCache = new Map(); // interno -> { motivo, categoria, fecha }, recargado en renderConsumoReal()
const MIN_CARGAS_TXT = MIN_CARGAS_CONFIABLE;
const COBERTURA_TXT = COBERTURA_MINIMA_PCT;

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
    if (tipo && tipo !== estado.tipo) { seleccionMasiva.clear(); seleccionMasivaMov.clear(); }
    if (tipo) { estado.tipo = tipo; estado.pagina = 0; estado.soloHuerfanas = false; estado.filtroCorrec = 'ALL'; }
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
        colLabelsMov = await getColLabelsMov();

        if (estado.tipo === 'maestro') await renderMaestro();
        else if (estado.tipo === 'estimados') await renderEstimados();
        else if (estado.tipo === 'real') await renderConsumoReal();
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
export function abrirTablaConBusqueda(tipo, query = '', buscarCol = 'id', periodo = null, filtroCorrec = null) {
    estado.tipo = tipo || estado.tipo;
    estado.buscar = query || '';
    estado.buscarCol = buscarCol;
    estado.pagina = 0;
    estado.soloHuerfanas = false;

    // Filtro por tipo de problema: permite que un hallazgo abra la tabla mostrando EXACTAMENTE
    // las filas que lo provocan (las 38 sin valorizar, las repetidas…) en vez de buscar un
    // equipo suelto y dejar al usuario encontrando las filas a ojo entre miles.
    estado.filtroCorrec = filtroCorrec || 'ALL';
    if (filtroCorrec) { estado.anio = ''; estado.mes = ''; estado.buscar = ''; }
    const selC = document.getElementById('tabla-filtro-correc');
    if (selC) selC.value = estado.filtroCorrec;

    // periodo opcional ({ anio, mes }): además de buscar el equipo, deja la tabla de
    // movimientos filtrada al mes puntual que originó el hallazgo (ej. "cargó más veces que
    // días hábiles hubo en Marzo 2026") en vez de mostrar todo el historial del equipo.
    if (periodo && periodo.anio) estado.anio = String(periodo.anio);
    if (periodo && periodo.mes) estado.mes = String(periodo.mes);

    // Se llama SIN pasar el tipo a propósito: renderDataTable(tipo) resetea los filtros — que es
    // lo correcto cuando el usuario cambia de pestaña a mano, pero pisaba el filtro que acabamos
    // de poner acá y la tabla se abría sin filtrar.
    return renderDataTable();
}

async function renderTabs() {
    const cont = document.getElementById('tabla-tabs');
    if (!cont) return;
    const tipos = await getTiposDeMovimiento();
    const equipos = await getAllEquipos();

    const estimados = await getAllEstimados();
    const nConsumoReal = (window.ultimoAnalisis?.filas || []).filter(f => f.metrics.cantidad_cargas > 0).length;
    const tabs = [
        { tipo: 'maestro', etiqueta: 'Maestro de Equipos', n: equipos.length },
        { tipo: 'estimados', etiqueta: 'Consumos Estimados', n: estimados.length },
        { tipo: 'real', etiqueta: 'Consumo Real', n: nConsumoReal },
        ...tipos
    ];
    cont.innerHTML = tabs.map(t => `
        <button class="btn-tab ${estado.tipo === t.tipo ? 'active' : ''}" data-tipo="${esc(t.tipo)}">
            ${t.posibleDuplicadoCargas ? '<i class="fa-solid fa-triangle-exclamation" style="color:var(--accent-amber,#e0a000)" title="Parece duplicar Cargas de Combustible — no se usa en el análisis"></i> ' : ''}${t.resumenDerivable ? '<i class="fa-solid fa-circle-info" style="color:var(--text-muted)" title="Resumen ya calculable desde otra pestaña"></i> ' : ''}${esc(t.etiqueta || t.tipo)} <span class="tab-n">${nf(t.n)}</span>
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
        'Padrón + metas de consumo en una sola tabla. <strong>Todas las celdas son editables</strong> y lo que corrijas a mano queda protegido: si volvés a importar la planilla, no se pisa. La llave es <strong>interno + dominio</strong>. ' +
        'Las columnas <strong>Consumo real</strong> y <strong>Cargas</strong> se calculan solas (no son editables acá): siempre muestran lo realmente medido junto con cuántas cargas lo respaldan — usá <strong>"Ajustar metas"</strong> para llevar ese real a la meta, o la pestaña <strong>Consumo Real</strong> para investigarlo equipo por equipo.';
    mostrarBotonesMaestro(true);
    mostrarBotonAjustarMetas(true);
    mostrarFiltrosFecha(false);
    mostrarFiltrosMaestro(true);
    mostrarBulkBar(true);
    prepararBulkBarEstimados();

    // Consumo real + cantidad de cargas: no vive en el equipo (es calculado sobre el período
    // vigente), así que se saca del último análisis del Panel — la misma fuente que usan las
    // tarjetas, para que el número acá y el del Panel nunca diverjan.
    const analisisFilas = window.ultimoAnalisis?.filas || [];
    const periodoAnalisis = window.ultimoAnalisis?.totales
        ? { desde: window.ultimoAnalisis.totales.periodo_desde, hasta: window.ultimoAnalisis.totales.periodo_hasta } : null;
    const porInternoAnalisis = new Map();
    analisisFilas.forEach(f => porInternoAnalisis.set(f.equipo.interno_key || normalizeEquipoKey(f.equipo.interno), f));

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
        '<th title="Calculado: litros/hora o litros/100km realmente medidos en el período vigente">Consumo real</th>' +
        '<th title="Cantidad de cargas que respaldan el Consumo real de esa fila">Cargas</th>' +
        '<th title="Diferencia entre el Consumo real y la Meta">vs Meta</th>' +
        columnasExtra.map(c => `<th class="th-extra">${esc(c.label)}
            <button class="th-rename" data-col="${esc(c.id)}" title="Renombrar columna"><i class="fa-solid fa-pen"></i></button>
            <button class="th-del" data-col="${esc(c.id)}" title="Eliminar columna"><i class="fa-solid fa-xmark"></i></button></th>`).join('') +
        '<th class="th-acciones"></th>';

    const pagina = filas.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
    document.getElementById('table-body').innerHTML = pagina.map(e => {
        const editados = e.editado_manual || [];
        const tieneAsociado = e.equipo_asociado ? 'row-asociado' : '';
        const sel = seleccionMasiva.has(e.interno);
        const key = e.interno_key || normalizeEquipoKey(e.interno);
        const fa = porInternoAnalisis.get(key);
        const tieneReal = fa && fa.metrics.cantidad_cargas > 0;
        let consumoRealTd, vsMetaTd;
        if (tieneReal) {
            const conf = confiabilidad(fa, periodoAnalisis);
            const unidadCorta = fa.metrics.tipo_calculo === 'L/Hora' ? 'L/h' : (fa.metrics.tipo_calculo === 'L/100Km' ? 'L/100km' : '');
            consumoRealTd = `<td class="cell-num"${conf.confiable ? '' : ` title="${esc('Poco confiable: ' + conf.avisos.join(', '))}"`}><strong>${nf(fa.metrics.consumo_real, 2)}</strong> <small>${esc(unidadCorta)}</small>${conf.confiable ? '' : ' <i class="fa-solid fa-triangle-exclamation" style="color:var(--accent-yellow,#e0a000)"></i>'}</td>`;
            if (e.meta_valor > 0) {
                const diff = (fa.metrics.consumo_real - e.meta_valor) / e.meta_valor * 100;
                const cls = Math.abs(diff) < 5 ? 'cmp-ok' : (diff > 0 ? 'cmp-alto' : 'cmp-bajo');
                vsMetaTd = `<td class="cell-num"><span class="${cls}">${diff > 0 ? '+' : ''}${nf(diff, 0)}%</span></td>`;
            } else {
                vsMetaTd = `<td class="cell-num"><span class="cmp-nuevo">sin meta</span></td>`;
            }
        } else {
            consumoRealTd = '<td class="cell-num cell-muted">—</td>';
            vsMetaTd = '<td class="cell-num cell-muted">—</td>';
        }
        const cargasTd = `<td class="cell-num">${tieneReal ? nf(fa.metrics.cantidad_cargas) : 0}</td>`;
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
            ${consumoRealTd}${cargasTd}${vsMetaTd}
            ${columnasExtra.map(c => `<td class="cell-edit" contenteditable="true" data-extra="${esc(c.id)}">${esc((e.extra || {})[c.id] ?? '')}</td>`).join('')}
            <td class="th-acciones"><button class="btn-icon btn-del-row" title="Eliminar equipo"><i class="fa-solid fa-trash"></i></button></td>
        </tr>`;
    }).join('') || '<tr><td colspan="17">No hay equipos en el maestro. Subí la planilla de Equipos o agregá uno con el botón "Equipo".</td></tr>';

    actualizarContador(filas.length, pagina.length);
    actualizarSelCount();
    renderPaginacion(filas.length);
    conectarEdicionMaestro();
    conectarCheckboxes();
}

function conectarEdicionMaestro() {
    const tbody = document.getElementById('table-body');

    tbody.querySelectorAll('td[contenteditable]').forEach(td => {
        td.addEventListener('focus', () => { td.dataset.prevValor = td.innerText.trim(); });
        td.addEventListener('blur', async () => {
            const tr = td.closest('tr');
            const interno = tr.dataset.interno;
            const texto = td.innerText.trim();
            const anterior = td.dataset.prevValor ?? '';
            if (anterior === texto) return;
            try {
                if (td.dataset.extra) {
                    await editarCampoEquipo(interno, td.dataset.extra, texto, true);
                    await registrarEdicion({ tabla: 'maestro', registroId: interno, etiqueta: interno, campo: td.dataset.extra, valorAnterior: anterior, valorNuevo: texto });
                } else {
                    const campo = td.dataset.campo;
                    const valor = td.dataset.num === '1' ? (parseFloat(texto.replace(',', '.')) || 0) : texto.toUpperCase();
                    await editarCampoEquipo(interno, campo, valor);
                    await registrarEdicion({ tabla: 'maestro', registroId: interno, etiqueta: interno, campo, valorAnterior: anterior, valorNuevo: valor });
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
        sel.addEventListener('focus', () => { sel.dataset.prevValor = sel.value; });
        sel.addEventListener('change', async () => {
            const interno = sel.closest('tr').dataset.interno;
            const anterior = sel.dataset.prevValor ?? '';
            await editarCampoEquipo(interno, sel.dataset.campo, sel.value);
            await registrarEdicion({ tabla: 'maestro', registroId: interno, etiqueta: interno, campo: sel.dataset.campo, valorAnterior: anterior, valorNuevo: sel.value });
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

    // Renombrar una columna propia: el valor de cada celda queda igual (se guarda por `id`,
    // no por el texto del encabezado), solo cambia la etiqueta que se ve.
    document.querySelectorAll('.th-rename').forEach(b => {
        b.addEventListener('click', async () => {
            const col = columnasExtra.find(c => c.id === b.dataset.col);
            if (!col) return;
            const nuevo = prompt('Nuevo nombre para la columna:', col.label);
            if (!nuevo || !nuevo.trim() || nuevo.trim().toUpperCase() === col.label) return;
            await setColumnasExtra(columnasExtra.map(c => c.id === col.id ? { ...c, label: nuevo.trim().toUpperCase() } : c));
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
        'Acá conviven DOS valores distintos, a propósito: <strong title="Lo que vino escrito en la planilla Consumos Estimados. Es una propuesta, no rige hasta que se adopta.">"Estimado (planilla)"</strong> es lo que vino en el archivo importado; <strong title="La meta que efectivamente está vigente en el maestro ahora mismo — puede diferir del Estimado si nunca se adoptó, o si se ajustó a mano después.">"Meta actual (maestro)"</strong> es la que realmente rige hoy. Las ajustadas a mano (ej. desde "Ajustar metas") quedan marcadas <strong>"Ajustado a mano"</strong>. Sumamos también <strong>"Consumo real"</strong> y <strong>"Cargas"</strong> — lo medido en el período vigente del Panel — para que se vea de un vistazo si el Estimado y la Meta están cerca de lo que la flota consume de verdad. ' +
        'Usá <strong>"Adoptar estimado como meta"</strong> en la barra de acciones para trasladar el Estimado a la Meta de un grupo de equipos.';
    mostrarBotonesMaestro(false);
    mostrarBotonAjustarMetas(true);
    mostrarFiltrosFecha(false);
    mostrarFiltrosMaestro(true);
    mostrarBulkBar(true);
    prepararBulkBarEstimados();

    // Enriquecer estimados con datos del equipo y detección de "sin actividad"
    const cargasPorInterno = new Map();
    const gpsPorInterno = new Map();
    rawRecords.forEach(r => {
        const k = r.interno_key || r.interno || '';
        if (r.type === 'carga') { cargasPorInterno.set(k, (cargasPorInterno.get(k) || 0) + 1); }
        if (r.type === 'gps') { gpsPorInterno.set(k, (gpsPorInterno.get(k) || 0) + 1); }
    });

    // Esta tabla tiene que mostrar la meta vigente de CADA equipo, no solo los que vinieron
    // en la planilla original de Consumos Estimados. Si se ajusta una meta a mano — por
    // ejemplo con "Normalizar todos con el real" en el Panel — a un equipo que nunca tuvo
    // una fila en esa planilla, antes quedaba con meta puesta pero invisible acá porque esta
    // vista solo recorría `estimados`. Ahora se arma la unión: todos los estimados
    // importados + todos los equipos del maestro que tengan una meta cargada (importada o
    // ajustada a mano), sin duplicar cuando coinciden en el mismo interno.
    const porInterno = new Map();
    estimados.forEach(e => porInterno.set(normalizeEquipoKey(e.interno), { ...e }));
    equipos.forEach(eq => {
        if (!(eq.meta_valor > 0)) return;
        const key = eq.interno_key || normalizeEquipoKey(eq.interno);
        if (!porInterno.has(key)) {
            // Equipo con meta ajustada a mano pero sin fila original en Consumos Estimados:
            // se arma una fila "sintética" a partir del maestro para que no quede invisible.
            porInterno.set(key, {
                interno: eq.interno,
                consumo_estimado_valor: null,
                consumo_estimado_unidad: '',
                _solo_en_maestro: true
            });
        }
    });

    // Consumo real vigente: misma fuente que Maestro y Consumo Real, para que "Estimado" no
    // quede aislado de lo que la flota realmente consume — es justo lo que faltaba acá.
    const analisisFilas = window.ultimoAnalisis?.filas || [];
    const periodoAnalisis = window.ultimoAnalisis?.totales
        ? { desde: window.ultimoAnalisis.totales.periodo_desde, hasta: window.ultimoAnalisis.totales.periodo_hasta } : null;
    const porInternoAnalisis = new Map();
    analisisFilas.forEach(f => porInternoAnalisis.set(f.equipo.interno_key || normalizeEquipoKey(f.equipo.interno), f));

    let filas = [...porInterno.values()].map(e => {
        const key = normalizeEquipoKey(e.interno);
        const eq = equipos.find(x => (x.interno_key || normalizeEquipoKey(x.interno)) === key);
        const nCargas = cargasPorInterno.get(key) || 0;
        const nGps = gpsPorInterno.get(key) || 0;
        const fa = porInternoAnalisis.get(key);
        const tieneReal = fa && fa.metrics.cantidad_cargas > 0;
        return {
            ...e,
            denominacion: eq?.denominacion || getDenominacion(e.interno, ''),
            dominio: eq?.dominio || '',
            meta_actual: eq?.meta_valor || 0,
            meta_unidad_actual: eq?.meta_unidad || '',
            meta_origen: eq?.meta_origen || '',
            en_maestro: !!eq,
            cargas: nCargas,
            gps: nGps,
            sin_actividad: nCargas > 0 && nGps === 0,
            fa: tieneReal ? fa : null
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

    const COLSPAN_ESTIMADOS = 13;
    document.getElementById('table-header').innerHTML =
        '<th class="th-sel"><input type="checkbox" id="th-sel-all" title="Seleccionar todos"></th>' +
        '<th>Interno</th><th>Dominio</th><th>Denominación</th>' +
        '<th title="Lo que vino escrito en la planilla Consumos Estimados">Estimado (planilla)</th><th>Unidad</th>' +
        '<th title="La meta que efectivamente rige hoy en el maestro">Meta actual (maestro)</th>' +
        '<th title="Diferencia entre el Estimado de la planilla y la Meta actual">vs Meta</th>' +
        '<th title="Litros/hora o litros/100km medidos de verdad en el período vigente del Panel — no lo que dice la planilla, lo que consumió">Consumo real</th>' +
        '<th title="Diferencia entre el Consumo real medido y la Meta actual del maestro">vs real</th>' +
        '<th>Cargas</th><th>GPS</th><th>Estado</th>';

    const pagina = filas.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
    document.getElementById('table-body').innerHTML = pagina.map(e => {
        const sel = seleccionMasiva.has(e.interno);
        const estadoTxt = !e.en_maestro ? '<span class="badge-warn">Sin maestro</span>'
            : e._solo_en_maestro ? `<span class="badge-ok" title="${esc(e.meta_origen || 'meta ajustada a mano, sin fila en la planilla de Consumos Estimados')}">Ajustado a mano</span>`
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

        // Consumo real vigente (lo medido) vs Meta actual — lo que "actualiza con el real".
        // Mismo criterio que en la pestaña Consumo Real: sin km ni horas de GPS no hay consumo
        // que mostrar. "0,00 L/h" ahí no significa que no gastó nada, significa que no hay con
        // qué dividir los litros — y compararlo contra la meta daba un "-100%" inventado.
        let consumoRealTd, vsRealTd;
        if (e.fa) {
            const conf = confiabilidad(e.fa, periodoAnalisis);
            const unidadCorta = e.fa.metrics.tipo_calculo === 'L/Hora' ? 'L/h' : (e.fa.metrics.tipo_calculo === 'L/100Km' ? 'L/100km' : '');
            const declEst = consumoDesdeActividadDeclarada(e.fa, window.actividadEstimadaCache || [], periodoAnalisis);
            if (conf.sinActividad) {
                consumoRealTd = `<td class="cell-num"><span class="cell-muted" title="Cargó ${nf(e.fa.metrics.total_litros, 1)} L pero el GPS no reportó ni km ni horas en el período: no hay contra qué dividir esos litros.">sin medir</span>` +
                    (declEst ? `<br><small class="cell-est-declarada" title="${esc(declEst.base)}">≈ ${nf(declEst.valor, 2)} <i class="fa-solid fa-gauge-high"></i> declarada</small>` : '') + '</td>';
                if (declEst && e.meta_actual > 0) {
                    const diffD = (declEst.valor - e.meta_actual) / e.meta_actual * 100;
                    const clsD = Math.abs(diffD) < 5 ? 'cmp-ok' : (diffD > 0 ? 'cmp-alto' : 'cmp-bajo');
                    vsRealTd = `<td class="cell-num"><span class="${clsD}" title="Sobre el consumo estimado por actividad declarada, no sobre una medición">${diffD > 0 ? '+' : ''}${nf(diffD, 0)}% <small>est.</small></span></td>`;
                } else {
                    vsRealTd = '<td class="cell-num cell-muted" title="Sin consumo medido ni declarado no hay diferencia contra la meta que signifique algo">—</td>';
                }
            } else {
                consumoRealTd = `<td class="cell-num"${conf.confiable ? '' : ` title="${esc('Poco confiable: ' + conf.avisos.join(', '))}"`}><strong>${nf(e.fa.metrics.consumo_real, 2)}</strong> <small>${esc(unidadCorta)}</small>${conf.confiable ? '' : ' <i class="fa-solid fa-triangle-exclamation" style="color:var(--accent-yellow,#e0a000)"></i>'}</td>`;
                if (e.meta_actual > 0) {
                    const diffR = (e.fa.metrics.consumo_real - e.meta_actual) / e.meta_actual * 100;
                    const clsR = Math.abs(diffR) < 5 ? 'cmp-ok' : (diffR > 0 ? 'cmp-alto' : 'cmp-bajo');
                    vsRealTd = `<td class="cell-num"><span class="${clsR}">${diffR > 0 ? '+' : ''}${nf(diffR, 0)}%</span></td>`;
                } else {
                    vsRealTd = '<td class="cell-num"><span class="cmp-nuevo">sin meta</span></td>';
                }
            }
        } else {
            consumoRealTd = '<td class="cell-num cell-muted">—</td>';
            vsRealTd = '<td class="cell-num cell-muted">—</td>';
        }

        return `<tr data-interno="${esc(e.interno)}" class="${sel ? 'row-sel' : ''}">
            <td class="td-sel"><input type="checkbox" class="chk-fila" data-interno="${esc(e.interno)}" ${sel ? 'checked' : ''}></td>
            <td class="cell-key">${esc(e.interno)}</td>
            <td>${esc(e.dominio)}</td>
            <td>${esc(e.denominacion)}</td>
            <td class="cell-num"><strong>${e.consumo_estimado_valor ? nf(e.consumo_estimado_valor, 2) : '—'}</strong></td>
            <td>${esc(e.consumo_estimado_unidad || '')}</td>
            <td class="cell-num" ${e.meta_origen ? `title="${esc(e.meta_origen)}"` : ''}>${e.meta_actual ? nf(e.meta_actual, 2) : '<span class="cell-muted">—</span>'}</td>
            <td class="cell-num">${vsMeta}</td>
            ${consumoRealTd}${vsRealTd}
            <td class="cell-num">${nf(e.cargas)}</td>
            <td class="cell-num">${nf(e.gps)}</td>
            <td>${estadoTxt}</td>
        </tr>`;
    }).join('') || `<tr><td colspan="${COLSPAN_ESTIMADOS}">No hay datos de consumos estimados. Subí la planilla de Consumos Estimados.</td></tr>`;

    actualizarContador(filas.length, pagina.length,
        `${filas.filter(e => e.sin_actividad).length} sin actividad · ${filas.filter(e => !e.meta_actual && e.consumo_estimado_valor).length} sin meta`);
    actualizarSelCount();
    renderPaginacion(filas.length);
    conectarCheckboxes();
}

// ============================================================ CONSUMO REAL

/**
 * "Consumo Real": la contraparte de Consumos Estimados, pero armada desde lo medido en vez de
 * lo declarado — un equipo por fila con su consumo real, cuántas cargas lo respaldan, qué tan
 * confiable es ese dato y cómo queda contra la meta vigente. Es lo que permite normalizar el
 * consumo real "como si fuera estimado" y desde ahí investigar metas más fino de lo que
 * alcanza a mostrar una tarjeta del Panel.
 *
 * A propósito de solo lectura (nada se edita acá): la acción es "Investigar meta" (por equipo)
 * o "Ajustar metas" (en bloque) — ambas ya validan y guardan del lado del maestro.
 */
async function renderConsumoReal() {
    const analisis = window.ultimoAnalisis;
    document.getElementById('table-title').textContent = 'Consumo Real';
    document.getElementById('table-desc').innerHTML = analisis
        ? `Un equipo por fila, con el <strong>consumo real medido</strong> en el período vigente del Panel y la <strong>cantidad de cargas</strong> que lo respaldan — la misma estructura que "Consumos Estimados", pero desde lo medido. La confiabilidad se parte en dos: <strong title="Sí/No según el umbral fijo: ${MIN_CARGAS_TXT} cargas y ${COBERTURA_TXT}% de cobertura mínima.">"Confiable"</strong> es el veredicto, <strong title="Sobre cuántos días hábiles del período se apoya ese veredicto — ej. 'cargó 42 de 120 días hábiles (35%)'.">"Cobertura"</strong> es la proporción exacta detrás. Cuando un equipo tiene pocas cargas propias pero hay pares comparables (misma marca/modelo o denominación), se muestra además un <strong>estimado por grupo</strong> — no reemplaza el dato propio, pero evita dejarlo en blanco. Usá <strong>"Investigar meta"</strong> para ver de dónde podría salir la meta de un equipo puntual, <strong>"Seguimiento"</strong> para anotar por qué tiene poca base (fuera de servicio, cambio de sucursal, carga externa…) sin excluirlo del análisis, o <strong>"Ajustar metas"</strong> para aplicar en bloque.`
        : 'Todavía no hay datos procesados. Subí las planillas y procesalas para ver el consumo real por equipo.';
    mostrarBotonesMaestro(false);
    mostrarBotonAjustarMetas(true);
    mostrarFiltrosFecha(false);
    mostrarFiltrosMaestro(true);
    mostrarBulkBar(true);
    prepararBulkBarReal();

    seguimientoCache = new Map((await getSeguimientoEquipos()).map(s => [s.interno, s]));

    const todasFilas = analisis?.filas || [];
    let filas = todasFilas.filter(f => f.metrics.cantidad_cargas > 0);
    filas.forEach(f => { if (!f.interno) f.interno = f.equipo.interno; }); // reutiliza selección/checkboxes genéricos (por interno)
    const periodo = analisis?.totales ? { desde: analisis.totales.periodo_desde, hasta: analisis.totales.periodo_hasta } : null;

    // Poblar filtro de denominación
    const denos = [...new Set(filas.map(f => f.equipo.denominacion).filter(Boolean))].sort();
    const selDeno = document.getElementById('tabla-filtro-deno');
    if (selDeno) {
        const actual = selDeno.value || 'ALL';
        selDeno.innerHTML = '<option value="ALL">Todas las denom.</option>' + denos.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
        selDeno.value = denos.includes(actual) ? actual : 'ALL';
    }

    if (estado.buscar) filas = filas.filter(f => matchBusqueda({ interno: f.equipo.interno, dominio: f.equipo.dominio }, estado.buscar));
    if (estado.filtroDeno !== 'ALL') filas = filas.filter(f => f.equipo.denominacion === estado.filtroDeno);
    if (estado.filtroEstado === 'con_meta') filas = filas.filter(f => f.confirmed && f.confirmed.valor > 0);
    else if (estado.filtroEstado === 'sin_meta') filas = filas.filter(f => !f.confirmed || !f.confirmed.valor);

    filas = filas.slice().sort((a, b) => b.metrics.total_litros - a.metrics.total_litros);
    filasActuales = filas;

    document.getElementById('table-header').innerHTML =
        '<th class="th-sel"><input type="checkbox" id="th-sel-all" title="Seleccionar todos"></th>' +
        '<th>Interno</th><th>Dominio</th><th>Denominación</th>' +
        '<th>Consumo real</th><th>Cargas</th>' +
        `<th title="Sí/No: ${MIN_CARGAS_TXT} cargas y ${COBERTURA_TXT}% de cobertura mínima de días hábiles">Confiable</th>` +
        '<th title="Proporción real detrás del veredicto: días con carga sobre días hábiles del período">Cobertura</th>' +
        '<th>Meta actual</th><th>vs Meta</th><th>Acciones</th>';

    const pagina = filas.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
    document.getElementById('table-body').innerHTML = pagina.map(f => {
        const conf = confiabilidad(f, periodo);
        const sel = seleccionMasiva.has(f.interno);
        const seg = seguimientoCache.get(f.equipo.interno);
        const unidadCorta = f.metrics.tipo_calculo === 'L/Hora' ? 'L/h' : (f.metrics.tipo_calculo === 'L/100Km' ? 'L/100km' : '');
        const decl = consumoDesdeActividadDeclarada(f, window.actividadEstimadaCache || [], periodo);

        // "vs Meta" tiene que compararse contra el mismo número que muestra la columna de al
        // lado. Cuando no hay actividad medida, el consumo real es 0 y comparar ESO contra la
        // meta daba un -100% que además contradecía al estimado declarado que se ve al lado.
        // Si hay una declaración, la comparación se hace contra ella y se marca como estimada;
        // si no hay nada con qué comparar, no se inventa un porcentaje.
        const baseComparacion = conf.sinActividad ? (decl ? decl.valor : null) : f.metrics.consumo_real;
        let vsMeta = '<span class="cell-muted">—</span>';
        if (f.confirmed && f.confirmed.valor > 0 && baseComparacion !== null) {
            const diff = (baseComparacion - f.confirmed.valor) / f.confirmed.valor * 100;
            const cls = Math.abs(diff) < 5 ? 'cmp-ok' : (diff > 0 ? 'cmp-alto' : 'cmp-bajo');
            const esEstimado = conf.sinActividad;
            vsMeta = `<span class="${cls}"${esEstimado ? ` title="Calculado sobre el consumo estimado por actividad declarada (${esc(decl.base)}), no sobre una medición"` : ''}>${diff > 0 ? '+' : ''}${nf(diff, 0)}%${esEstimado ? ' <small>est.</small>' : ''}</span>`;
        } else if (f.confirmed && f.confirmed.valor > 0 && conf.sinActividad) {
            vsMeta = '<span class="cell-muted" title="Sin actividad medida ni declarada no hay consumo con qué comparar contra la meta">sin base</span>';
        }

        // Columna "Consumo real": la corrección más importante de esta vista. Un equipo con
        // cargas pero 0 km y 0 hs de GPS no consume 0 — no se sabe cuánto consume. Mostrar
        // "0,00 L/100km" con formato de medición era un dato inventado con cara de dato real
        // (es el caso que se veía en CM30). Ahora dice "sin medir" y, en su lugar, se ofrecen
        // los dos caminos honestos para llenar ese hueco:
        //   1) la actividad DECLARADA a mano para ese equipo, si alguien la cargó (lo más fuerte,
        //      porque son sus propios litros divididos por sus propios km/horas);
        //   2) la mediana de PARES comparables, como referencia de orden de magnitud.
        let consumoTd;
        if (conf.sinActividad) {
            const alt = decl
                ? `<br><small class="cell-est-declarada" title="${esc(decl.base)} · declarado a mano">≈ ${nf(decl.valor, 2)} ${esc(decl.unidad === 'L/Hora' ? 'L/h' : 'L/100km')} <i class="fa-solid fa-gauge-high"></i> según actividad declarada</small>`
                : (() => {
                    const sug = sugerirMeta(f, todasFilas);
                    return sug ? `<br><small class="cell-muted" title="Mediana de ${sug.n} equipos comparables confiables: ${sug.base}">≈ ${nf(sug.valor, 2)} ${esc(unidadCorta)} <i class="fa-solid fa-people-group"></i> estimado por grupo</small>` : '';
                })();
            consumoTd = `<td class="cell-num"><span class="cell-muted" title="Cargó ${nf(f.metrics.total_litros, 1)} L pero el GPS no reportó ni km ni horas en el período: no hay contra qué dividir esos litros.">sin medir</span>${alt}</td>`;
        } else {
            // Estimado por grupo cuando el propio equipo tiene poca base, para no dejar la
            // referencia en blanco.
            let grupoTd = '';
            if (!conf.confiable) {
                const sugerido = sugerirMeta(f, todasFilas);
                if (sugerido) grupoTd = `<br><small class="cell-muted" title="Mediana de ${sugerido.n} equipos comparables confiables: ${sugerido.base}">≈ ${nf(sugerido.valor, 2)} ${esc(unidadCorta)} <i class="fa-solid fa-people-group"></i> estimado por grupo</small>`;
            }
            consumoTd = `<td class="cell-num"><strong>${nf(f.metrics.consumo_real, 2)}</strong> <small>${esc(unidadCorta)}</small>${grupoTd}</td>`;
        }

        // Confiable / Cobertura, separados: el veredicto por un lado, la proporción exacta
        // por otro — así "de qué proporción hablamos" queda visible aunque el dato SÍ sea
        // confiable, no solo como advertencia cuando no lo es.
        const confiableTd = conf.confiable
            ? (seg ? `<span class="badge-ok" title="En seguimiento: ${esc(seg.motivo || seg.categoria)}">Confiable 🔎</span>` : '<span class="badge-ok">Confiable</span>')
            : (seg ? `<span class="badge-warn" title="En seguimiento: ${esc(seg.motivo || seg.categoria)} (anotado el ${esc((seg.fecha || '').slice(0, 10))})">🔎 En seguimiento</span>` : `<span class="badge-warn" title="${esc(conf.avisos.join(', '))}">⚠ ${esc(conf.avisos[0] || 'poca base')}</span>`);
        // La cadencia manda sobre el porcentaje de días hábiles cuando el ritmo es regular: un
        // equipo que carga una vez por mes TODOS los meses tiene 5% de cobertura de días y aun
        // así es un patrón estable. Decir "5%" ahí es técnicamente cierto y prácticamente
        // engañoso; el ritmo es la lectura correcta.
        const cad = conf.cadencia;
        const coberturaTd = (cad && cad.regular)
            ? `<span class="cmp-ok" title="Cargó en ${cad.mesesConCarga} de los ${cad.mesesPeriodo} meses del período: ritmo estable, no es un dato faltante. ${conf.cobertura ? `Sobre días hábiles serían ${conf.cobertura.diasConCarga}/${conf.cobertura.diasHabiles} (${conf.cobertura.pct}%), pero para un equipo de uso liviano esa no es la medida.` : ''}">${esc(cad.texto)} <i class="fa-solid fa-repeat"></i></span>`
            : (conf.cobertura
                ? `<span class="${conf.cobertura.pct < COBERTURA_MINIMA_PCT ? 'cmp-bajo' : 'cmp-ok'}"${cad ? ` title="Ritmo: ${esc(cad.texto)}"` : ''}>${nf(conf.cobertura.diasConCarga)}/${nf(conf.cobertura.diasHabiles)} días (${conf.cobertura.pct}%)</span>`
                : '<span class="cell-muted" title="No se pudo calcular: hace falta más de una fecha de carga en el período">—</span>');

        return `<tr data-interno="${esc(f.equipo.interno)}" class="${sel ? 'row-sel' : ''}">
            <td class="td-sel"><input type="checkbox" class="chk-fila" data-interno="${esc(f.equipo.interno)}" ${sel ? 'checked' : ''}></td>
            <td class="cell-key">${esc(f.equipo.interno)}</td>
            <td>${esc(f.equipo.dominio || '')}</td>
            <td>${esc(f.equipo.denominacion || '')}</td>
            ${consumoTd}
            <td class="cell-num">${nf(f.metrics.cantidad_cargas)}</td>
            <td>${confiableTd}</td>
            <td class="cell-num">${coberturaTd}</td>
            <td class="cell-num" ${f.confirmed?.source ? `title="${esc(f.confirmed.source)}"` : ''}>${f.confirmed && f.confirmed.valor ? nf(f.confirmed.valor, 2) : '<span class="cell-muted">sin meta</span>'}</td>
            <td class="cell-num">${vsMeta}</td>
            <td class="td-acciones-real">
                <button class="btn-xs btn-real-investigar" data-interno="${esc(f.equipo.interno)}" title="Investigar de dónde podría salir la meta"><i class="fa-solid fa-magnifying-glass-chart"></i></button>
                <button class="btn-xs btn-real-actividad${decl ? ' active' : ''}" data-interno="${esc(f.equipo.interno)}" title="${decl ? `Actividad declarada: ${esc(decl.base)}. Click para editarla.` : 'Declarar km u horas estimados: es lo que permite calcular el consumo cuando no hay GPS'}"><i class="fa-solid fa-gauge-high"></i></button>
                <button class="btn-xs btn-real-seguimiento" data-interno="${esc(f.equipo.interno)}" title="${seg ? 'Editar/quitar seguimiento' : 'Marcar para seguimiento (anotar el motivo de la poca base, sin excluirlo)'}"><i class="fa-solid fa-magnifying-glass-location"></i></button>
            </td>
        </tr>`;
    }).join('') || '<tr><td colspan="11">Ningún equipo con cargas coincide con el filtro. Si no procesaste ninguna planilla todavía, hacelo desde "Carga de Datos".</td></tr>';

    document.querySelectorAll('.btn-real-investigar').forEach(b => {
        b.addEventListener('click', () => {
            if (typeof window.abrirInvestigacionMeta === 'function') window.abrirInvestigacionMeta(b.dataset.interno);
        });
    });
    document.querySelectorAll('.btn-real-actividad').forEach(b => {
        b.addEventListener('click', () => {
            if (typeof window.abrirActividadEstimada === 'function') window.abrirActividadEstimada([b.dataset.interno]);
        });
    });
    document.querySelectorAll('.btn-real-seguimiento').forEach(b => {
        b.addEventListener('click', () => abrirMarcarSeguimiento(b.dataset.interno));
    });

    actualizarContador(filas.length, pagina.length,
        `${filas.filter(f => !confiabilidad(f, periodo).confiable).length} con poca base · ${filas.filter(f => !f.confirmed || !f.confirmed.valor).length} sin meta · ${filas.filter(f => seguimientoCache.has(f.equipo.interno)).length} en seguimiento`);
    actualizarSelCount();
    renderPaginacion(filas.length);
    conectarCheckboxes();
}

/**
 * Marcar/editar/quitar el seguimiento de un equipo puntual. No excluye nada del análisis
 * (para eso está "equipo apartado" en el Panel) — solo deja anotado el motivo de la poca
 * base para no tener que reinvestigarlo la próxima vez que aparece con el mismo problema.
 * Marcarlo NO lo vuelve confiable por sí solo: lo que sí ayuda es que, con más períodos
 * importados, se vea si la cadencia se mantiene estable (ej. 1 carga/mes todo el año) — eso
 * es un patrón real, no un dato roto, aunque nunca supere el umbral fijo de cobertura.
 */
async function abrirMarcarSeguimiento(interno) {
    const actuales = await getSeguimientoEquipos();
    const actual = actuales.find(s => s.interno === interno);
    const motivo = prompt(
        `Seguimiento de "${interno}": anotá por qué tiene poca base (ej. "fuera de servicio en marzo-abril", "cambio a San Juan en mayo", "baja de producción", "carga fuera de la empresa, se pierde el dato"). Dejalo vacío para quitar el seguimiento.`,
        actual?.motivo || ''
    );
    if (motivo == null) return; // canceló
    if (!motivo.trim()) {
        if (actual) await quitarSeguimientoEquipo(interno);
    } else {
        await setSeguimientoEquipo(interno, motivo.trim(), 'otro');
    }
    renderDataTable();
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
    ],
    entrega: [
        { k: 'fecha', label: 'Fecha' }, { k: 'remito', label: 'N° Remito' },
        { k: 'volumen', label: 'Volumen (m³)', num: 2 },
        { k: 'datos.Planta', label: 'Planta' }, { k: 'datos.Cliente', label: 'Cliente' },
        { k: 'fuentes', label: 'Fuente' }
    ]
};

async function renderMovimientos(tipo) {
    const todos = (await getAllRawRecords()).filter(r => r.type === tipo);
    const etiqueta = todos[0]?.type_label || tipo;
    const esCarga = tipo === 'carga';
    const esDuplicadoCargas = !esCarga && todos[0]?._posible_duplicado_cargas;
    const esResumenDerivable = !esCarga && todos[0]?._resumen_derivable;
    const esEntregas = tipo === 'entrega';
    const conConflicto = esEntregas ? todos.filter(r => r._conflicto_remito).length : 0;

    document.getElementById('table-title').textContent = etiqueta;
    document.getElementById('table-desc').innerHTML = esCarga
        ? 'Registro histórico de cargas. Las filas marcadas en naranja tienen un interno desconocido — hacé clic en <strong>Corregir</strong> para asignarlas a un equipo o eliminarlas. Cualquier otra celda (fecha, litros, importe, lugar, centro de costo, chofer…) se edita haciendo click directo encima. La corrección se guarda y se re-aplica automáticamente al reimportar el mismo archivo.'
        : esDuplicadoCargas
        ? '⚠ <strong>Esta planilla tiene forma de carga de combustible</strong> (litros + tipo de combustible) pero no es el formato oficial de "Cargas de Combustible" (le falta "Lugar de carga") — probablemente sea el mismo gasto exportado desde otro sistema (ej. el reporte propio de una estación de servicio). <strong>No se usa para calcular el consumo real</strong>, para no contar dos veces las mismas cargas. Si en realidad trae cargas que Cargas de Combustible NO tiene, avisá para sumarlas a mano en vez de dejarlas acá sin usar.'
        : esResumenDerivable
        ? 'ℹ️ Esto es un <strong>control de totales</strong>, no una fuente nueva: Loop lo calcula a partir de las mismas entregas que están en "Entregas (Loop)". Verificado contra datos reales: coincide exacto los meses que tienen el detalle completo, pero puede venir <strong>por encima</strong> del detalle en un mes donde el export de "Informe Entregas" quedó incompleto — cuando eso pase, la diferencia es la pista de que faltan entregas por cargar, no un error de la app. Comparalo con la suma de "Entregas (Loop)" del mismo período antes de descartar la diferencia.'
        : esEntregas
        ? `Entregas de Loop, cruzadas por N° de Remito entre "Informe Entregas" y "Exportado informe de Viajes": si dos filas del mismo remito y equipo coincidían en todo, quedaron fusionadas en una sola.${conConflicto ? ` <strong style="color:var(--accent-red,#ff453a)">⚠ ${conConflicto} filas marcadas en rojo tienen el mismo remito con datos que NO coinciden</strong> — se guardaron las dos, sin adivinar cuál es la correcta: hay que decidir contra el comprobante.` : ' No se encontraron remitos con datos contradictorios entre las dos fuentes.'}`
        : 'Registro histórico. Se muestra <strong>interno + dominio</strong> de cada fila: es la llave con la que se cruza contra el maestro. Cualquier celda se puede corregir haciendo click encima.';
    mostrarBotonesMaestro(false);
    mostrarBotonAjustarMetas(false);
    mostrarFiltrosFecha(true);
    mostrarFiltrosMaestro(false);
    mostrarFiltrosCarga(esCarga);
    mostrarBulkBar(esCarga);
    if (esCarga) prepararBulkBarCargas();
    poblarFiltrosFecha(todos);
    sincronizarFiltroCorrec();

    // Para cargas: armar el set de internos del maestro y el mapa de correcciones ya guardadas
    let equiposSet = new Set();
    let correccionesMap = new Map();
    if (esCarga) {
        const [eqs, corrs] = await Promise.all([getAllEquipos(), getCorreccionesCargas()]);
        eqs.forEach(e => equiposSet.add(e.interno_key || normalizeEquipoKey(e.interno)));
        corrs.forEach(c => correccionesMap.set(c.huella, c));
    }
    const esHuerfanaDe = (r) => {
        const ikey = r.interno_key || normalizeEquipoKey(r.interno || '');
        return !ikey || !equiposSet.has(ikey);
    };

    if (esCarga) poblarFiltrosCarga(todos);

    let filas = filtrarPorPeriodo(todos, { anio: estado.anio || null, mes: estado.mes || null });
    if (estado.buscar) filas = filas.filter(r => matchBusqueda(r, estado.buscar));
    if (esCarga && estado.filtroCC !== 'ALL') filas = filas.filter(r => (r.centro_costo || '—') === estado.filtroCC);
    if (esCarga && estado.filtroLugar !== 'ALL') filas = filas.filter(r => (r.lugar_carga || '—') === estado.filtroLugar);
    // Filtro por tipo de problema: es lo que permite ir directo desde un hallazgo del panel a
    // las filas que lo provocan, en vez de tener que buscarlas a mano una por una.
    if (esCarga && estado.filtroCorrec !== 'ALL') {
        const c = estado.filtroCorrec;
        if (c === 'sin_valorizar') {
            filas = filas.filter(r => (parseFloat(r.litros) || 0) > 0 &&
                ((parseFloat(r.importe) || 0) <= 0 || (parseFloat(r.precio_unitario) || 0) <= 0));
        } else if (c === 'repetidas') {
            const cuenta = new Map();
            todos.forEach(r => {
                const k = `${r.interno_key || r.interno}|${r.fecha}|${Math.round((parseFloat(r.litros) || 0) * 10)}`;
                cuenta.set(k, (cuenta.get(k) || 0) + 1);
            });
            filas = filas.filter(r => cuenta.get(`${r.interno_key || r.interno}|${r.fecha}|${Math.round((parseFloat(r.litros) || 0) * 10)}`) > 1);
        } else if (c === 'no_habil') {
            filas = filas.filter(r => r.fecha && !esDiaHabil(r.fecha));
        } else if (c === 'corregidas') {
            filas = filas.filter(r => r._corregido || correccionesMap.has(huellaCarga(r)));
        } else if (c === 'sin_asignar') {
            filas = filas.filter(r => esHuerfanaDe(r) && !correccionesMap.has(huellaCarga(r)));
        }
    }
    // Filtro "Solo sin asignar" (huérfanas)
    if (esCarga && estado.soloHuerfanas) {
        filas = filas.filter(r => esHuerfanaDe(r) && !correccionesMap.has(huellaCarga(r)));
    }
    if (esCarga && estado.orden === 'corregir') {
        // Las que todavía necesitan corrección primero; entre ellas y entre el resto, más reciente primero.
        filas.sort((a, b) => {
            const aPend = esHuerfanaDe(a) && !correccionesMap.has(huellaCarga(a)) ? 1 : 0;
            const bPend = esHuerfanaDe(b) && !correccionesMap.has(huellaCarga(b)) ? 1 : 0;
            if (aPend !== bPend) return bPend - aPend;
            return (b.fecha || '').localeCompare(a.fecha || '');
        });
    } else {
        filas.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    }
    filasActuales = filas;

    // Columnas: identidad siempre primero, después las propias del tipo. Las etiquetas
    // respetan los renombres guardados en colLabelsMov (botón de lápiz en el encabezado).
    const overrides = colLabelsMov[tipo] || {};
    let cols = COLS_MOV[tipo] ? COLS_MOV[tipo].map(c => ({ ...c })) : null;
    if (!cols) {
        const muestra = filas[0]?.datos || {};
        cols = Object.keys(muestra)
            .filter(c => !/INTERNO|DOMINIO|PATENTE|UNIDAD|MATRICULA/.test(c))
            .slice(0, 12)
            .map(c => ({ k: `datos.${c}`, label: c }));
    }
    cols.forEach(c => { if (overrides[c.k]) c.label = overrides[c.k]; });
    columnasVisibles = ['Equipo', ...cols.map(c => c.label)];

    // Solo fecha/fecha_hasta y las columnas derivadas del GPS (_ralenti/_movimiento/_total,
    // calculadas a partir de r.horas, no un campo propio) quedan afuera de la edición directa.
    const noEditable = new Set(['_ralenti', '_movimiento', '_total', 'fuentes']);

    const colspan = cols.length + 1 + (esCarga ? 2 : 0);
    document.getElementById('table-header').innerHTML =
        (esCarga ? '<th class="th-sel"><input type="checkbox" id="th-sel-mov-all" title="Seleccionar todos"></th>' : '') +
        '<th title="Común denominador entre planillas: interno+dominio cuando la fila trae los dos, o el que tenga">Equipo</th>' +
        cols.map(c => `<th>${esc(c.label)}${noEditable.has(c.k) ? '' : `
            <button class="th-rename-mov" data-tipo="${esc(tipo)}" data-col="${esc(c.k)}" data-label="${esc(c.label)}" title="Renombrar columna"><i class="fa-solid fa-pen"></i></button>`}</th>`).join('') +
        (esCarga ? '<th class="th-acciones"></th>' : '');

    const pagina = filas.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
    let nHuerfanas = 0;

    document.getElementById('table-body').innerHTML = pagina.map(r => {
        const h = (r.horas && typeof r.horas === 'object') ? r.horas : { ralenti: 0, movimiento: parseFloat(r.horas) || 0, total: parseFloat(r.horas) || 0 };

        let esHuerfana = false;
        let yaCorregida = false;
        if (esCarga) {
            esHuerfana = esHuerfanaDe(r);
            yaCorregida = correccionesMap.has(huellaCarga(r));
            if (esHuerfana && !yaCorregida) nHuerfanas++;
        }

        const rowClass = esHuerfana && !yaCorregida ? 'carga-huerfana' : (yaCorregida ? 'carga-corregida' : (r._conflicto_remito ? 'carga-huerfana' : ''));
        const dataAttrs = ` data-recid="${r.id}"`;
        const selTd = esCarga ? `<td class="td-sel"><input type="checkbox" class="chk-fila-mov" data-recid="${r.id}" ${seleccionMasivaMov.has(r.id) ? 'checked' : ''}></td>` : '';
        const accionTd = esCarga ? `<td class="td-correc">${
            esHuerfana && !yaCorregida
                ? `<button class="btn-corregir-carga btn-warn btn-sm"><i class="fa-solid fa-wand-magic-sparkles"></i> Corregir</button>`
                : (yaCorregida
                    ? `<button class="btn-editar-correc badge-corregida" title="Click para editar esta corrección (interno, dominio, centro de costo, etc.)"><i class="fa-solid fa-check"></i> Corregido <i class="fa-solid fa-pen correc-edit-icon"></i></button>`
                    : '')
        }</td>` : '';

        return `<tr${rowClass ? ` class="${rowClass}"` : ''}${dataAttrs}>
            ${selTd}
            <td class="cell-key">${
                r.interno && r.dominio ? `${esc(r.interno)} <span class="cell-dom">${esc(r.dominio)}</span>`
                : esc(r.interno || r.dominio || '—')
            }</td>
            ${cols.map(c => {
                let v;
                if (c.k === '_ralenti') v = nf(h.ralenti, 1);
                else if (c.k === '_movimiento') v = nf(h.movimiento, 1);
                else if (c.k === '_total') v = `<strong>${nf(h.total, 1)}</strong>`;
                else if (c.k === 'fecha' || c.k === 'fecha_hasta') v = esc(formatFechaAR(r[c.k]));
                else if (c.k.startsWith('datos.')) v = esc(r.datos?.[c.k.slice(6)] ?? '');
                else if (c.k === 'fuentes') v = esc(Array.isArray(r.fuentes) ? r.fuentes.join(' + ') : (r.formato || ''));
                else if (c.money) v = `$${nf(r[c.k], 2)}`;
                else if (c.num !== undefined) v = nf(r[c.k], c.num);
                else v = esc(r[c.k] ?? '');
                if (noEditable.has(c.k)) return `<td>${v}</td>`;
                if (c.k === 'fecha' || c.k === 'fecha_hasta') {
                    return `<td class="cell-edit-fecha"><input type="date" class="mov-fecha-input" data-recid="${r.id}" data-campo="${c.k}" value="${esc(r[c.k] || '')}"></td>`;
                }
                return `<td class="cell-edit" contenteditable="true" data-recid="${r.id}" data-campo="${esc(c.k)}" data-num="${c.num !== undefined ? 1 : 0}" data-label="${esc(c.label)}">${v}</td>`;
            }).join('')}
            ${accionTd}
        </tr>`;
    }).join('') || `<tr><td colspan="${colspan}">${
        estado.anio || estado.mes ? 'No hay registros en el período elegido.'
        : estado.buscar ? `Ningún registro coincide con "${esc(estado.buscar)}".`
        : 'No hay registros en esta tabla.'
    }</td></tr>`;

    // Botón "Sin asignar" en contador (solo cargas)
    let btnHuerfanasHtml = '';
    if (esCarga) {
        const nHuerfanasTotal = todos.filter(r => esHuerfanaDe(r) && !correccionesMap.has(huellaCarga(r))).length;
        if (nHuerfanasTotal > 0) {
            const activo = estado.soloHuerfanas ? ' btn-warn-active' : '';
            btnHuerfanasHtml = ` <button class="btn-sm btn-warn btn-filtro-huerfanas${activo}" style="margin-left:8px">` +
                `<i class="fa-solid fa-triangle-exclamation"></i> ${estado.soloHuerfanas ? 'Todos' : `Sin asignar (${nHuerfanasTotal})`}</button>`;
        }
    }
    const resExtra = esCarga && nHuerfanas > 0 && !estado.soloHuerfanas
        ? ` · <span style="color:#f5a623;font-weight:600">${nHuerfanas} sin asignar</span>` : '';
    // Para tipos genéricos (cubiertas, filtros, insumos…) que todavía no tienen un análisis
    // propio: un resumen básico igual — cantidad, costo si hay algo que parezca importe, y
    // los equipos con más registros — para que la planilla no quede "muda" hasta que se le
    // arme un análisis dedicado.
    const resGenerico = !esCarga && tipo !== 'gps' ? resumenGenerico(filas) : '';
    actualizarContador(filas.length, pagina.length, resumenNumerico(filas, tipo) + resGenerico + resExtra + btnHuerfanasHtml);
    renderPaginacion(filas.length);

    // Listener del botón filtro huérfanas
    document.querySelector('.btn-filtro-huerfanas')?.addEventListener('click', () => {
        estado.soloHuerfanas = !estado.soloHuerfanas;
        estado.pagina = 0;
        renderDataTable();
    });

    conectarEdicionMovimientos(tipo, todos);
    conectarRenombreColumnasMov();
    if (esCarga) conectarSeleccionMov();

    // Listener delegado para el panel de corrección (solo cargas). Sirve tanto para asignar
    // una carga huérfana por primera vez (.btn-corregir-carga) como para reabrir y EDITAR una
    // corrección ya aplicada (.btn-editar-correc) — antes esa segunda parte no existía: una vez
    // corregida, la fila quedaba con un cartel fijo sin forma de arreglar un dato mal tipeado
    // (ej. un interno cargado con guion) sin editar la base a mano.
    if (esCarga) {
        const tbody = document.getElementById('table-body');
        tbody.addEventListener('click', async (e) => {
            const btn = e.target.closest('.btn-corregir-carga, .btn-editar-correc');
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
            const correccionExistente = btn.classList.contains('btn-editar-correc')
                ? correccionesMap.get(huellaCarga(record)) : null;
            const panelTr = buildCorrecionRow(record, todos, equipos, colspan, correccionExistente);
            tr.insertAdjacentElement('afterend', panelTr);
            conectarPanelCorreccion(panelTr, record, todos, equipos);
        });
    }
}

/**
 * Edición directa de cualquier celda de una tabla de movimientos (no solo la asignación de
 * huérfanas): click, escribir, salir del campo y queda guardado, igual que en el Maestro.
 * Cada cambio queda anotado en el historial de ediciones (quién campo, valor anterior/nuevo).
 */
function conectarEdicionMovimientos(tipo, todos) {
    const tbody = document.getElementById('table-body');

    tbody.querySelectorAll('td.cell-edit[contenteditable]').forEach(td => {
        td.addEventListener('blur', async () => {
            const recid = parseInt(td.dataset.recid, 10);
            const campo = td.dataset.campo;
            const record = todos.find(r => r.id === recid);
            if (!record) return;
            const texto = td.innerText.trim();

            let valorAnterior, valorNuevo, cambios;
            if (campo.startsWith('datos.')) {
                const key = campo.slice(6);
                valorAnterior = record.datos?.[key] ?? '';
                valorNuevo = texto;
                cambios = { datos: { ...(record.datos || {}), [key]: texto } };
            } else {
                valorAnterior = record[campo] ?? '';
                valorNuevo = td.dataset.num === '1' ? (parseFloat(texto.replace(',', '.')) || 0) : texto;
                cambios = { [campo]: valorNuevo };
                if (campo === 'litros' || campo === 'importe') cambios[campo] = parseFloat(String(texto).replace(',', '.')) || 0;
            }
            if (String(valorAnterior) === String(valorNuevo)) return;

            try {
                await updateRawRecord(recid, cambios);
                await registrarEdicion({
                    tabla: tipo, registroId: recid,
                    etiqueta: `${record.interno || record.dominio || 'registro'} · ${formatFechaAR(record.fecha) || ''}`.trim(),
                    campo: td.dataset.label || campo, valorAnterior, valorNuevo
                });
                Object.assign(record, cambios);
                td.classList.add('cell-editado');
                flash(td);
                if (typeof window.renderPanel === 'function') window.renderPanel();
            } catch (e) { console.error(e); td.classList.add('cell-error'); }
        });
    });

    tbody.querySelectorAll('.mov-fecha-input').forEach(inp => {
        inp.addEventListener('change', async () => {
            const recid = parseInt(inp.dataset.recid, 10);
            const campo = inp.dataset.campo;
            const record = todos.find(r => r.id === recid);
            if (!record) return;
            const valorAnterior = record[campo] || '';
            const valorNuevo = inp.value;
            if (!valorNuevo || valorAnterior === valorNuevo) return;
            try {
                await updateRawRecord(recid, { [campo]: valorNuevo });
                await registrarEdicion({
                    tabla: tipo, registroId: recid,
                    etiqueta: `${record.interno || record.dominio || 'registro'}`.trim(),
                    campo: campo === 'fecha' ? 'Fecha' : 'Fecha hasta',
                    valorAnterior: formatFechaAR(valorAnterior), valorNuevo: formatFechaAR(valorNuevo)
                });
                record[campo] = valorNuevo;
                flash(inp.closest('td'));
                if (typeof window.renderPanel === 'function') window.renderPanel();
            } catch (e) { console.error(e); }
        });
    });
}

function conectarRenombreColumnasMov() {
    document.querySelectorAll('.th-rename-mov').forEach(b => {
        b.addEventListener('click', async () => {
            const nuevo = prompt('Nuevo nombre para la columna:', b.dataset.label);
            if (!nuevo || !nuevo.trim() || nuevo.trim() === b.dataset.label) return;
            await setColLabelMov(b.dataset.tipo, b.dataset.col, nuevo.trim().toUpperCase());
            renderDataTable();
        });
    });
}

function conectarSeleccionMov() {
    const tbody = document.getElementById('table-body');
    const thSel = document.getElementById('th-sel-mov-all');

    tbody.querySelectorAll('.chk-fila-mov').forEach(ch => {
        ch.addEventListener('change', () => {
            const id = parseInt(ch.dataset.recid, 10);
            if (ch.checked) seleccionMasivaMov.add(id); else seleccionMasivaMov.delete(id);
            ch.closest('tr').classList.toggle('row-sel', ch.checked);
            actualizarSelCountMov();
        });
    });
    if (thSel) {
        thSel.addEventListener('change', () => {
            const visibles = filasActuales.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
            if (thSel.checked) visibles.forEach(f => seleccionMasivaMov.add(f.id));
            else visibles.forEach(f => seleccionMasivaMov.delete(f.id));
            tbody.querySelectorAll('.chk-fila-mov').forEach(ch => {
                const id = parseInt(ch.dataset.recid, 10);
                ch.checked = seleccionMasivaMov.has(id);
                ch.closest('tr').classList.toggle('row-sel', ch.checked);
            });
            actualizarSelCountMov();
        });
    }
    actualizarSelCountMov();
}

function actualizarSelCountMov() {
    const el = document.getElementById('tabla-sel-count');
    if (el) el.textContent = seleccionMasivaMov.size ? `${seleccionMasivaMov.size} seleccionadas` : '';
    const chkTodos = document.getElementById('tabla-sel-todos');
    if (chkTodos) chkTodos.checked = seleccionMasivaMov.size > 0;
}

/** Resumen básico para tipos de movimiento genéricos (cubiertas, filtros, insumos…) que
 * todavía no tienen un análisis dedicado: cantidad, costo si hay algo que parezca importe
 * entre las columnas numéricas detectadas, y los equipos con más registros. */
function resumenGenerico(filas) {
    if (!filas.length) return '';
    const camposCosto = new Set();
    let costoTotal = 0;
    let tieneCosto = false;
    const porEquipo = new Map();
    filas.forEach(r => {
        const key = r.interno || r.dominio || '—';
        porEquipo.set(key, (porEquipo.get(key) || 0) + 1);
        Object.entries(r.numericos || {}).forEach(([k, v]) => {
            if (/costo|importe|precio|monto|valor/.test(k)) {
                tieneCosto = true;
                camposCosto.add(k);
                costoTotal += Number(v) || 0;
            }
        });
    });
    const top = [...porEquipo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([eq, n]) => `${esc(eq)} (${n})`).join(', ');
    return `${nf(porEquipo.size)} equipos` + (tieneCosto ? ` · $${nf(costoTotal)}` : '') + (top ? ` · más registros: ${top}` : '');
}

/**
 * Construye el <tr> con el panel de corrección inline. Sirve para dos casos: asignar una
 * carga huérfana por primera vez (`correccionExistente` null) o reabrir una corrección ya
 * aplicada para editarla (`correccionExistente` con lo que se guardó la vez anterior) — en
 * ese caso los campos manuales quedan precargados con esos valores en vez de vacíos.
 */
function buildCorrecionRow(record, todasCargas, equipos, colspan, correccionExistente = null) {
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

    // Otras cargas del MISMO dominio (patente) que todavía no tienen equipo asignado: pasa
    // seguido con un vehículo prestado/demo que aparece con el mismo dominio en decenas de
    // cargas — corregir una sola fila a mano y tener que repetir lo mismo fila por fila (o
    // armar la selección múltiple a mano) es innecesario si el dominio ya identifica al mismo
    // vehículo en todas ellas. Solo se cuentan las que siguen sin asignar (no se toca una carga
    // que ya tiene un equipo distinto asignado, aunque comparta dominio por coincidencia).
    const equipoKeysSet = new Set(equipos.map(e => e.interno_key || normalizeEquipoKey(e.interno)));
    const domNorm = (record.dominio || '').trim().toUpperCase();
    const hermanosMismoDominio = domNorm
        ? todasCargas.filter(r => r.id !== record.id && (r.dominio || '').trim().toUpperCase() === domNorm &&
            (!r.interno_key || !equipoKeysSet.has(r.interno_key)))
        : [];

    const editando = !!correccionExistente;
    const interno_original = record._interno_original ?? record.interno ?? '';
    const valInterno = editando ? (correccionExistente.interno_correcto || record.interno || '') : '';
    const valDominio = editando ? (correccionExistente.dominio_correcto || record.dominio || '') : (record.dominio || '');
    const valCC = editando ? (correccionExistente.centro_costo_correcto || record.centro_costo || '') : (record.centro_costo || '');
    const valLugar = editando ? (correccionExistente.lugar_carga_correcto || record.lugar_carga || '') : (record.lugar_carga || '');
    const valSector = editando ? (correccionExistente.sector_correcto || record.sector || '') : (record.sector || '');
    const valObs = editando ? (correccionExistente.observacion || '') : '';

    const tr = document.createElement('tr');
    tr.className = 'carga-correccion-row';
    tr.dataset.recid = record.id;
    tr.innerHTML = `<td colspan="${colspan}"><div class="correc-panel">
        <div class="correc-header">
            ${editando
                ? '<span class="badge-corregida"><i class="fa-solid fa-pen"></i> Editando corrección</span>'
                : '<span class="badge-huerfana"><i class="fa-solid fa-triangle-exclamation"></i> Sin asignar</span>'}
            <span class="correc-detalle">
                ${esc(formatFechaAR(record.fecha) || '—')} &nbsp;·&nbsp;
                ${nf(record.litros, 1)} L &nbsp;·&nbsp;
                $${nf(record.importe, 2)} &nbsp;·&nbsp;
                Lugar: ${esc(record.lugar_carga || '—')} &nbsp;·&nbsp;
                CC: ${esc(record.centro_costo || '—')} &nbsp;·&nbsp;
                Chofer / interno original: <strong>${esc(interno_original || '—')}</strong>
                ${editando ? ` &nbsp;·&nbsp; Asignado actualmente: <strong>${esc(record.interno || '—')}</strong>` : ''}
            </span>
            <button class="btn-cerrar-correc btn-icon" title="Cerrar"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="correc-cuerpo">
            <div class="correc-candidatos-wrap">
                <p class="correc-titulo">Equipos candidatos — actividad del período</p>
                <div class="candidato-list">${candidatosHtml}</div>
            </div>
            <div class="correc-manual-wrap">
                <p class="correc-titulo">${editando ? 'Editar asignación y datos extra' : 'Asignación manual y datos extra'}</p>
                <div class="correc-manual-row">
                    <datalist id="correc-sugg-${record.id}">${listaSugg}</datalist>
                    <label class="correc-field-label">Interno <small style="opacity:.6">(opcional)</small></label>
                    <input type="text" class="correc-interno-input"
                        placeholder="Ej: MX66" list="correc-sugg-${record.id}" autocomplete="off" value="${esc(valInterno)}">
                </div>
                <div class="correc-manual-row">
                    <label class="correc-field-label">Dominio</label>
                    <input type="text" class="correc-dominio-input"
                        placeholder="Ej: JNU923" value="${esc(valDominio)}">
                </div>
                <div class="correc-manual-row">
                    <label class="correc-field-label">Centro de costo</label>
                    <input type="text" class="correc-cc-input"
                        placeholder="Ej: HORMIGÓN" value="${esc(valCC)}">
                </div>
                <div class="correc-manual-row">
                    <label class="correc-field-label">Lugar de carga</label>
                    <input type="text" class="correc-lugar-input"
                        placeholder="Ej: GRIS" value="${esc(valLugar)}">
                </div>
                <div class="correc-manual-row">
                    <label class="correc-field-label">Sector</label>
                    <input type="text" class="correc-sector-input"
                        placeholder="Ej: BOMBAS" value="${esc(valSector)}">
                </div>
                <div class="correc-manual-row">
                    <label class="correc-field-label">Observación</label>
                    <input type="text" class="correc-obs-input"
                        placeholder="Nota libre" value="${esc(valObs)}">
                </div>
                ${hermanosMismoDominio.length ? `
                <div class="correc-manual-row correc-aplicar-todos-row">
                    <label class="correc-checkbox-label">
                        <input type="checkbox" class="correc-aplicar-todos" checked>
                        Aplicar esta asignación a las otras <strong>${hermanosMismoDominio.length}</strong> carga${hermanosMismoDominio.length === 1 ? '' : 's'} sin asignar del mismo dominio (<strong>${esc(record.dominio)}</strong>)
                    </label>
                </div>` : ''}
                <div class="correc-manual-row" style="margin-top:10px">
                    <button class="btn-asignar-manual btn-primary btn-sm"><i class="fa-solid fa-check"></i> ${editando ? 'Guardar cambios' : 'Guardar corrección'}</button>
                    ${editando ? '<button class="btn-deshacer-correc btn-secondary btn-sm" title="Sacarle la asignación de equipo y volver a dejarla como carga sin asignar"><i class="fa-solid fa-rotate-left"></i> Deshacer corrección</button>' : ''}
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
function conectarPanelCorreccion(panelTr, record, todasCargas, equipos = []) {
    const huella = huellaCarga(record);
    const equipoKeysSet = new Set(equipos.map(e => e.interno_key || normalizeEquipoKey(e.interno)));
    const domNorm = (record.dominio || '').trim().toUpperCase();

    function leerCamposExtra() {
        return {
            dominio_correcto:    (panelTr.querySelector('.correc-dominio-input')?.value || '').trim(),
            centro_costo_correcto: (panelTr.querySelector('.correc-cc-input')?.value || '').trim(),
            lugar_carga_correcto:  (panelTr.querySelector('.correc-lugar-input')?.value || '').trim(),
            sector_correcto:     (panelTr.querySelector('.correc-sector-input')?.value || '').trim(),
            observacion:         (panelTr.querySelector('.correc-obs-input')?.value || '').trim(),
        };
    }

    // Las cargas que se corrigen a mano casi nunca traen centro de costo, y el criterio real que
    // se usa es derivarlo del lugar de carga o del sector. Se propone solo, dejándolo editable:
    // completa el caso habitual sin decidir por el usuario.
    const ccInput = panelTr.querySelector('.correc-cc-input');
    ['.correc-lugar-input', '.correc-sector-input'].forEach(sel => {
        panelTr.querySelector(sel)?.addEventListener('blur', (e) => {
            const v = (e.target.value || '').trim();
            if (v && ccInput && !ccInput.value.trim()) {
                ccInput.value = v.toUpperCase();
                ccInput.classList.add('correc-cc-sugerido');
                ccInput.title = 'Propuesto a partir del lugar de carga o el sector. Editalo si corresponde otro.';
            }
        });
    });

    /** Corrección sin interno: solo enriquece el registro (centro de costo, lugar, sector, obs). */
    async function guardarSoloExtras(extra) {
        const internoOriginalReal = (record._interno_original ?? record.interno) || '';
        await saveCorreccionCarga({
            huella, accion: 'enriquecer',
            interno_correcto: '', dominio_correcto: extra.dominio_correcto,
            centro_costo_correcto: extra.centro_costo_correcto,
            lugar_carga_correcto: extra.lugar_carga_correcto,
            sector_correcto: extra.sector_correcto,
            observacion: extra.observacion,
            interno_original: internoOriginalReal,
            fecha: record.fecha, litros: record.litros, importe: record.importe
        });
        const cambios = { _corregido: true, _interno_original: internoOriginalReal };
        if (extra.dominio_correcto) { cambios.dominio = extra.dominio_correcto; cambios.dominio_key = normalizeEquipoKey(extra.dominio_correcto); }
        if (extra.centro_costo_correcto) cambios.centro_costo = extra.centro_costo_correcto;
        if (extra.lugar_carga_correcto) cambios.lugar_carga = extra.lugar_carga_correcto;
        if (extra.sector_correcto) cambios.sector = extra.sector_correcto;
        await updateRawRecord(record.id, cambios);
        await registrarEdicion({
            tabla: 'carga', registroId: record.id, etiqueta: `${formatFechaAR(record.fecha)} · datos corregidos sin interno`,
            campo: 'Centro de costo', valorAnterior: record.centro_costo || '', valorNuevo: extra.centro_costo_correcto || ''
        });
        await renderDataTable(estado.tipo);
    }

    async function asignarA(interno, dominioHint) {
        interno = (interno || '').toUpperCase().trim();
        const extraPrevio = leerCamposExtra();
        // El interno dejó de ser obligatorio: hay cargas que nunca van a tener un equipo del
        // padrón detrás (caldera, jardinería, una herramienta a combustión) y lo único que
        // necesitan es quedar imputadas a un centro de costo. Si no hay interno pero sí hay
        // algún dato para corregir, se guarda igual como enriquecimiento del registro.
        if (!interno) {
            const algo = extraPrevio.dominio_correcto || extraPrevio.centro_costo_correcto ||
                         extraPrevio.lugar_carga_correcto || extraPrevio.sector_correcto || extraPrevio.observacion;
            if (!algo) { alert('Completá al menos un dato: interno, dominio, centro de costo, lugar, sector u observación.'); return; }
            await guardarSoloExtras(extraPrevio);
            return;
        }
        // Interno nuevo, que no existe en el maestro: se ofrece darlo de alta ahí mismo como
        // equipo cargado a mano. Antes había que salir a la pestaña del maestro, crearlo y
        // volver — y en el medio se perdía el contexto de la carga que se estaba corrigiendo.
        if (!equipoKeysSet.has(normalizeEquipoKey(interno))) {
            const ccSugerido = extraPrevio.centro_costo_correcto || extraPrevio.sector_correcto || extraPrevio.lugar_carga_correcto || '';
            const ok = confirm(
                `"${interno}" no existe en el maestro de equipos.\n\n` +
                `ACEPTAR = darlo de alta ahora como equipo cargado a mano (fuera de la flota medida)` +
                (ccSugerido ? `, con centro de costo "${ccSugerido}"` : '') + `.\n` +
                `CANCELAR = guardar igual la corrección sin crear el equipo.`
            );
            if (ok) {
                await updateEquipo({
                    interno,
                    interno_key: normalizeEquipoKey(interno),
                    dominio: extraPrevio.dominio_correcto || dominioHint || '',
                    dominio_key: normalizeEquipoKey(extraPrevio.dominio_correcto || dominioHint || ''),
                    denominacion: extraPrevio.sector_correcto || 'CARGADO A MANO',
                    centro_costo: ccSugerido,
                    fuera_de_flota: true,
                    origen: 'alta manual desde corrección de cargas',
                    editado_manual: ['interno', 'denominacion', 'centro_costo', 'fuera_de_flota']
                });
                equipoKeysSet.add(normalizeEquipoKey(interno));
            }
        }
        // Misma normalización que se usa para cruzar Cargas/GPS/Equipos en todos lados
        // (normalizeEquipoKey saca ceros a la izquierda: BM07 y BM7 tienen que quedar con la
        // misma clave). Antes acá se armaba la clave a mano sin esa normalización, así que una
        // asignación manual podía terminar con una interno_key que no calzaba con el resto de
        // las planillas del mismo equipo — justo el tipo de desvío que puede afectar un análisis.
        const ikey = normalizeEquipoKey(interno);
        const extra = leerCamposExtra();
        const dominio = extra.dominio_correcto || dominioHint || '';
        // Si esta carga YA estaba corregida antes (se está editando, no asignando por primera
        // vez), `record.interno` ya es el valor corregido anterior, no el original del Excel.
        // El original real vive en `record._interno_original` desde la primera corrección —
        // hay que seguir arrastrando ESE valor, si no la huella de esta carga cambia en cada
        // edición y la corrección guardada deja de encontrarse la próxima vez (se "pierde" el
        // cartel de Corregido y la posibilidad de volver a editarla).
        const internoOriginalReal = (record._interno_original ?? record.interno) || '';
        await saveCorreccionCarga({
            huella,
            accion: 'asignar',
            interno_correcto: interno,
            dominio_correcto: dominio,
            centro_costo_correcto: extra.centro_costo_correcto,
            lugar_carga_correcto: extra.lugar_carga_correcto,
            sector_correcto: extra.sector_correcto,
            observacion: extra.observacion,
            interno_original: internoOriginalReal,
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
            _interno_original: internoOriginalReal
        };
        if (extra.centro_costo_correcto) cambiosRecord.centro_costo = extra.centro_costo_correcto;
        if (extra.lugar_carga_correcto) cambiosRecord.lugar_carga = extra.lugar_carga_correcto;
        if (extra.sector_correcto) cambiosRecord.sector = extra.sector_correcto;
        await updateRawRecord(record.id, cambiosRecord);
        await registrarEdicion({
            tabla: 'carga', registroId: record.id, etiqueta: `${formatFechaAR(record.fecha)} · corrección`,
            campo: 'Interno', valorAnterior: internoOriginalReal, valorNuevo: interno
        });

        // "Aplicar a las demás cargas del mismo dominio": mismo criterio que en el panel
        // (mismo dominio, todavía sin equipo asignado), recalculado acá por si el usuario tocó
        // el dominio a mano antes de guardar.
        const aplicarTodos = panelTr.querySelector('.correc-aplicar-todos');
        let nHermanos = 0;
        if (aplicarTodos && aplicarTodos.checked && domNorm) {
            const hermanos = todasCargas.filter(r => r.id !== record.id && (r.dominio || '').trim().toUpperCase() === domNorm &&
                (!r.interno_key || !equipoKeysSet.has(r.interno_key)));
            for (const hr of hermanos) {
                const hOriginal = (hr._interno_original ?? hr.interno) || '';
                await saveCorreccionCarga({
                    huella: huellaCarga(hr), accion: 'asignar', interno_correcto: interno, dominio_correcto: dominio,
                    centro_costo_correcto: extra.centro_costo_correcto, lugar_carga_correcto: extra.lugar_carga_correcto,
                    interno_original: hOriginal, fecha: hr.fecha, litros: hr.litros, importe: hr.importe
                });
                const cambiosHr = { interno, interno_key: ikey, dominio: dominio || hr.dominio || '', dominio_key: normalizeEquipoKey(dominio || hr.dominio || ''), _corregido: true, _interno_original: hOriginal };
                if (extra.centro_costo_correcto) cambiosHr.centro_costo = extra.centro_costo_correcto;
                if (extra.lugar_carga_correcto) cambiosHr.lugar_carga = extra.lugar_carga_correcto;
                await updateRawRecord(hr.id, cambiosHr);
                await registrarEdicion({
                    tabla: 'carga', registroId: hr.id, etiqueta: `${formatFechaAR(hr.fecha)} · corrección en lote por dominio`,
                    campo: 'Interno', valorAnterior: hOriginal, valorNuevo: interno
                });
                nHermanos++;
            }
        }

        panelTr.remove();
        renderDataTable();
        if (typeof window.renderPanel === 'function') window.renderPanel();
        if (nHermanos) alert(`Asignado ${interno}: esta carga y ${nHermanos} más del dominio ${dominio || record.dominio}.`);
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
        if (!confirm(`¿Eliminar este registro (${litros} L del ${formatFechaAR(record.fecha)})?\n\nSi reimportás el archivo, el registro se va a omitir automáticamente.`)) return;
        await saveCorreccionCarga({
            huella,
            accion: 'eliminar',
            interno_original: (record._interno_original ?? record.interno) || '',
            fecha: record.fecha,
            litros: record.litros,
            importe: record.importe
        });
        await deleteRawRecord(record.id);
        panelTr.remove();
        renderDataTable();
        if (typeof window.renderPanel === 'function') window.renderPanel();
    });

    // Deshacer corrección: borra la corrección guardada y devuelve la carga a "sin asignar"
    // (interno/dominio vacíos). Los datos extra (centro de costo, lugar, sector) que se hayan
    // pisado durante la corrección no se pueden reconstruir — no quedó guardado cuál era el
    // valor original de esos campos — así que quedan como estén; se pueden volver a editar a
    // mano si hace falta.
    panelTr.querySelector('.btn-deshacer-correc')?.addEventListener('click', async () => {
        if (!confirm(`¿Deshacer la corrección de esta carga?\n\nVuelve a quedar sin equipo asignado (interno "${record.interno || ''}" se borra). El centro de costo / lugar / sector que se hayan editado quedan como están; se pueden corregir a mano.`)) return;
        await deleteCorreccionCarga(huella);
        await updateRawRecord(record.id, {
            interno: '',
            interno_key: '',
            dominio: '',
            dominio_key: '',
            _corregido: false,
            _interno_original: null
        });
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

/** Botón "Ajustar metas": visible en Maestro, Consumos Estimados y Consumo Real — donde tiene
 * sentido tocar la meta de un equipo —, oculto en Movimientos. */
function mostrarBotonAjustarMetas(v) {
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
    if (!v) { seleccionMasiva.clear(); seleccionMasivaMov.clear(); }
}

/** Bulk bar reutilizada para Cargas: mismo contenedor, otras acciones (asignar equipo,
 * poner centro de costo/lugar, eliminar) porque acá se selecciona por registro, no por interno. */
function prepararBulkBarCargas() {
    const sel = document.getElementById('tabla-bulk-accion');
    if (!sel) return;
    sel.innerHTML = `
        <option value="">Acción masiva…</option>
        <option value="asignar_interno">Asignar interno a las seleccionadas</option>
        <option value="set_cc">Poner centro de costo</option>
        <option value="set_lugar">Poner lugar de carga</option>
        <option value="eliminar_masivo">Eliminar seleccionadas</option>`;
}

/** Bulk bar de Maestro/Estimados: las acciones "de siempre" sobre metas. Hace falta
 * restaurarla explícitamente al volver de Cargas o de Consumo Real, que pisan el mismo
 * <select> con sus propias opciones — si no, queda con las opciones de la última pestaña
 * visitada aunque ya no correspondan. */
function prepararBulkBarEstimados() {
    const sel = document.getElementById('tabla-bulk-accion');
    if (!sel) return;
    sel.innerHTML = `
        <option value="">Acción masiva…</option>
        <option value="adoptar_estimado">Adoptar estimado como meta</option>
        <option value="limpiar_meta">Limpiar meta</option>
        <option value="set_unidad_lh">Unidad → L/Hora</option>
        <option value="set_unidad_lkm">Unidad → L/100Km</option>
        <option value="set_no_aplica">Unidad → No Aplica</option>`;
}

/** Bulk bar de Consumo Real: acciones por grupo o por interno seleccionado — marcar/quitar
 * seguimiento en lote (para no repetir el motivo equipo por equipo), y adoptar el estimado
 * por grupo (mediana de pares comparables) como meta cuando el equipo no tiene una propia. */
function prepararBulkBarReal() {
    const sel = document.getElementById('tabla-bulk-accion');
    if (!sel) return;
    sel.innerHTML = `
        <option value="">Acción masiva…</option>
        <option value="marcar_seguimiento_masivo">Marcar seleccionados para seguimiento</option>
        <option value="quitar_seguimiento_masivo">Quitar seguimiento a seleccionados</option>
        <option value="declarar_actividad_grupo">Declarar km/horas estimados para los seleccionados</option>
        <option value="adoptar_estimado_grupo">Adoptar estimado por grupo como meta (si no tienen)</option>`;
}

/** Acciones masivas en Consumo Real: por selección directa, o por grupo completo si antes
 * se filtró por denominación y se tildó "Todos" — el mismo mecanismo que ya usan Maestro y
 * Estimados, reaprovechado acá para normalizar equipos con poca base sin ir uno por uno. */
async function ejecutarAccionMasivaReal(accion) {
    if (!seleccionMasiva.size) { alert('No hay equipos seleccionados.'); return; }
    const internos = [...seleccionMasiva];
    const analisis = window.ultimoAnalisis;
    const todasFilas = analisis?.filas || [];

    switch (accion) {
        case 'declarar_actividad_grupo': {
            // Un solo formulario para todo el grupo: la actividad típica de una camioneta o de un
            // grupo electrógeno se estima igual para todos los de esa clase, y cargarla equipo por
            // equipo es lo que hace que nunca se termine de completar.
            if (typeof window.abrirActividadEstimada !== 'function') { alert('Todavía no hay datos procesados.'); return; }
            window.abrirActividadEstimada(internos);
            seleccionMasiva.clear();
            return;
        }
        case 'marcar_seguimiento_masivo': {
            const motivo = prompt(`Motivo de seguimiento para ${internos.length} equipos (ej: "fuera de servicio parte del período", "cambio de sucursal", "carga fuera de la empresa"):`);
            if (motivo == null) return;
            for (const int of internos) await setSeguimientoEquipo(int, motivo.trim(), 'otro');
            alert(`${internos.length} equipos marcados para seguimiento.`);
            break;
        }
        case 'quitar_seguimiento_masivo': {
            for (const int of internos) await quitarSeguimientoEquipo(int);
            alert(`Seguimiento quitado a ${internos.length} equipos.`);
            break;
        }
        case 'adoptar_estimado_grupo': {
            const equipos = await getAllEquipos();
            let aplicados = 0, sinPares = 0;
            for (const int of internos) {
                const key = normalizeEquipoKey(int);
                const fila = todasFilas.find(f => (f.equipo.interno_key || normalizeEquipoKey(f.equipo.interno)) === key);
                if (!fila) continue;
                const eq = equipos.find(e => (e.interno_key || normalizeEquipoKey(e.interno)) === key);
                if (!eq || eq.meta_valor > 0) continue; // no pisa una meta que ya existe
                const sugerido = sugerirMeta(fila, todasFilas);
                if (!sugerido) { sinPares++; continue; }
                eq.meta_valor = sugerido.valor;
                eq.meta_unidad = sugerido.unidad;
                eq.meta_texto = `${sugerido.valor} ${sugerido.unidad === 'L/Hora' ? 'L/hora' : 'L/100km'}`;
                eq.meta_origen = `Estimado por grupo: ${sugerido.base}`;
                eq.editado_manual = [...new Set([...(eq.editado_manual || []), 'meta_valor', 'meta_unidad', 'meta_texto'])];
                await updateEquipo(eq);
                aplicados++;
            }
            alert(`Meta asignada por grupo en ${aplicados} equipos.${sinPares ? ` ${sinPares} sin pares comparables suficientes.` : ''}`);
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

function mostrarFiltrosCarga(v) {
    ['tabla-filtro-cc', 'tabla-filtro-lugar', 'tabla-orden', 'tabla-filtro-correc'].forEach(id => {
        const s = document.getElementById(id);
        if (s) s.style.display = v ? '' : 'none';
    });
}

function poblarFiltrosCarga(records) {
    const ccs = [...new Set(records.map(r => r.centro_costo || '—'))].sort();
    const lugares = [...new Set(records.map(r => r.lugar_carga || '—'))].sort();
    const selCC = document.getElementById('tabla-filtro-cc');
    if (selCC) {
        const actual = selCC.value || 'ALL';
        selCC.innerHTML = '<option value="ALL">Todos los centros de costo</option>' + ccs.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
        selCC.value = ccs.includes(actual) ? actual : 'ALL';
    }
    const selLugar = document.getElementById('tabla-filtro-lugar');
    if (selLugar) {
        const actual = selLugar.value || 'ALL';
        selLugar.innerHTML = '<option value="ALL">Todos los lugares</option>' + lugares.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
        selLugar.value = lugares.includes(actual) ? actual : 'ALL';
    }
}

/** Acciones masivas sobre cargas seleccionadas (por registro, no por interno): asignar
 * equipo, corregir centro de costo/lugar en lote, o eliminar. Reutiliza el mismo mecanismo
 * de corrección persistente (`saveCorreccionCarga`) que la corrección fila por fila, para
 * que se siga re-aplicando sola si se reimporta el archivo. */
async function ejecutarAccionMasivaCargas(accion) {
    if (!seleccionMasivaMov.size) { alert('No hay cargas seleccionadas.'); return; }
    const ids = [...seleccionMasivaMov];
    const todos = await getAllRawRecords();
    const registros = ids.map(id => todos.find(r => r.id === id)).filter(Boolean);
    if (!registros.length) { alert('No se encontraron las cargas seleccionadas.'); return; }

    switch (accion) {
        case 'asignar_interno': {
            const interno = (prompt(`Asignar interno a las ${registros.length} cargas seleccionadas:`) || '').toUpperCase().trim();
            if (!interno) return;
            const dominio = (prompt('Dominio (opcional, dejar vacío si no aplica):') || '').toUpperCase().trim();
            const ikey = normalizeEquipoKey(interno);
            let n = 0;
            for (const record of registros) {
                const internoOriginalReal = (record._interno_original ?? record.interno) || '';
                await saveCorreccionCarga({
                    huella: huellaCarga(record), accion: 'asignar', interno_correcto: interno, dominio_correcto: dominio,
                    interno_original: internoOriginalReal, fecha: record.fecha, litros: record.litros, importe: record.importe
                });
                await updateRawRecord(record.id, {
                    interno, interno_key: ikey,
                    dominio: dominio || record.dominio || '', dominio_key: normalizeEquipoKey(dominio || record.dominio || ''),
                    _corregido: true, _interno_original: internoOriginalReal
                });
                await registrarEdicion({
                    tabla: 'carga', registroId: record.id, etiqueta: `${formatFechaAR(record.fecha)} · edición masiva`,
                    campo: 'Interno', valorAnterior: internoOriginalReal, valorNuevo: interno
                });
                n++;
            }
            alert(`Asignadas ${n} cargas a ${interno}.`);
            break;
        }
        case 'set_cc':
        case 'set_lugar': {
            const campo = accion === 'set_cc' ? 'centro_costo' : 'lugar_carga';
            const etiquetaCampo = accion === 'set_cc' ? 'Centro de costo' : 'Lugar de carga';
            const valor = (prompt(`${etiquetaCampo} para las ${registros.length} cargas seleccionadas:`) || '').trim();
            if (!valor) return;
            let n = 0;
            for (const record of registros) {
                const anterior = record[campo] || '';
                await updateRawRecord(record.id, { [campo]: valor });
                await registrarEdicion({
                    tabla: 'carga', registroId: record.id, etiqueta: `${formatFechaAR(record.fecha)} · edición masiva`,
                    campo: etiquetaCampo, valorAnterior: anterior, valorNuevo: valor
                });
                n++;
            }
            alert(`${etiquetaCampo} actualizado en ${n} cargas.`);
            break;
        }
        case 'eliminar_masivo': {
            if (!confirm(`¿Eliminar ${registros.length} cargas seleccionadas?\n\nSi reimportás el archivo, se van a omitir automáticamente (queda guardado como corrección).`)) return;
            let n = 0;
            for (const record of registros) {
                await saveCorreccionCarga({
                    huella: huellaCarga(record), accion: 'eliminar',
                    interno_original: (record._interno_original ?? record.interno) || '',
                    fecha: record.fecha, litros: record.litros, importe: record.importe
                });
                await deleteRawRecord(record.id);
                n++;
            }
            alert(`${n} cargas eliminadas.`);
            break;
        }
        default:
            alert('Acción no reconocida.');
            return;
    }
    seleccionMasivaMov.clear();
    renderDataTable();
    if (typeof window.renderPanel === 'function') window.renderPanel();
}

/** Historial de ediciones manuales: qué campo, en qué registro, de qué valor a qué valor. */
async function abrirHistorialEdiciones() {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const log = (await getEdicionesLog()).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

    const modalId = 'modal-historial-ediciones';
    document.getElementById(modalId)?.remove();
    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Historial de ediciones manuales</h2>
                    <p class="modal-sub">${nf(log.length)} cambio${log.length === 1 ? '' : 's'} registrado${log.length === 1 ? '' : 's'} en total.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    ${log.length ? `
                    <table class="data-table">
                        <thead><tr><th>Fecha</th><th>Tabla</th><th>Registro</th><th>Campo</th><th>Valor anterior</th><th>Valor nuevo</th></tr></thead>
                        <tbody>
                            ${log.slice(0, 500).map(l => `<tr>
                                <td>${esc(new Date(l.fecha).toLocaleString('es-AR'))}</td>
                                <td>${esc(l.tabla)}</td>
                                <td>${esc(l.etiqueta || l.registroId)}</td>
                                <td>${esc(l.campo)}</td>
                                <td class="cell-muted">${esc(l.valorAnterior)}</td>
                                <td><strong>${esc(l.valorNuevo)}</strong></td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                    ${log.length > 500 ? `<p class="modal-note">Mostrando los 500 cambios más recientes de ${nf(log.length)}.</p>` : ''}`
                    : '<p class="modal-note">Todavía no hay ediciones manuales registradas. Cualquier corrección que hagas en las tablas de Base de Datos va a quedar anotada acá.</p>'}
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    modal.querySelector('[data-close]').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

function sincronizarFiltroCorrec() {
    const sel = document.getElementById('tabla-filtro-correc');
    if (sel && sel.value !== estado.filtroCorrec) sel.value = estado.filtroCorrec;
}

function poblarFiltrosFecha(records) {
    const { anios, meses } = periodosDisponibles(records);
    // Si el año/mes que quedó seleccionado en OTRA pestaña no existe en esta, se limpia. Si no,
    // la tabla muestra "0 de 0 filas" por un filtro que ni siquiera figura en el desplegable
    // (y por lo tanto no se puede sacar). Pasa siempre con las planillas genéricas, que muchas
    // veces no traen columna de fecha: sus registros no tienen año ni mes con qué comparar.
    if (estado.anio && !anios.includes(Number(estado.anio))) estado.anio = '';
    if (estado.mes && !meses.includes(Number(estado.mes))) estado.mes = '';
    const a = document.getElementById('tabla-anio');
    const m = document.getElementById('tabla-mes');
    if (a) { a.innerHTML = '<option value="">Todos los años</option>' + anios.map(x => `<option value="${x}">${x}</option>`).join(''); a.value = estado.anio; }
    if (m) { m.innerHTML = '<option value="">Todos los meses</option>' + meses.map(x => `<option value="${x}">${MESES[x - 1]}</option>`).join(''); m.value = estado.mes; }
}

function actualizarContador(total, mostradas, extra = '') {
    const el = document.getElementById('tabla-count');
    // `extra` puede traer HTML propio (badge + botón "sin asignar"), no solo texto —
    // con textContent esas etiquetas se veían literalmente en pantalla en vez de renderizarse.
    if (el) el.innerHTML = `${nf(mostradas)} de ${nf(total)} filas${extra ? ' · ' + extra : ''}`;
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
    document.getElementById('tabla-filtro-cc')?.addEventListener('change', e => { estado.filtroCC = e.target.value; estado.pagina = 0; renderDataTable(); });
    document.getElementById('tabla-filtro-correc')?.addEventListener('change', e => { estado.filtroCorrec = e.target.value; estado.pagina = 0; renderDataTable(); });
    document.getElementById('tabla-filtro-lugar')?.addEventListener('change', e => { estado.filtroLugar = e.target.value; estado.pagina = 0; renderDataTable(); });
    document.getElementById('tabla-orden')?.addEventListener('change', e => { estado.orden = e.target.value; estado.pagina = 0; renderDataTable(); });

    // Selección masiva global (por interno en Maestro/Estimados, por registro en Cargas)
    document.getElementById('tabla-sel-todos')?.addEventListener('change', e => {
        if (estado.tipo === 'carga') {
            if (e.target.checked) filasActuales.forEach(f => seleccionMasivaMov.add(f.id));
            else seleccionMasivaMov.clear();
        } else {
            if (e.target.checked) filasActuales.forEach(f => seleccionMasiva.add(f.interno));
            else seleccionMasiva.clear();
        }
        renderDataTable();
    });

    // Botón de acción masiva
    document.getElementById('tabla-bulk-aplicar')?.addEventListener('click', () => {
        const accion = document.getElementById('tabla-bulk-accion')?.value;
        if (!accion) { alert('Elegí una acción masiva del desplegable.'); return; }
        if (estado.tipo === 'carga') ejecutarAccionMasivaCargas(accion);
        else if (estado.tipo === 'real') ejecutarAccionMasivaReal(accion);
        else ejecutarAccionMasiva(accion);
    });

    document.getElementById('btn-historial-ediciones')?.addEventListener('click', () => abrirHistorialEdiciones());

    document.getElementById('btn-ajustar-metas-estimados')?.addEventListener('click', () => {
        if (typeof window.abrirAjusteMetasDesdeTabla !== 'function') {
            alert('Todavía no hay datos procesados: subí las planillas y volvé a esta pantalla.');
            return;
        }
        // En Estimados el foco natural es completar lo que falta; en Maestro y Consumo Real,
        // partir desde "todos" tiene más sentido (ahí es donde se ve el consumo real de cada uno).
        window.abrirAjusteMetasDesdeTabla(estado.tipo === 'estimados' ? 'sin_meta' : 'todos');
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
