/**
 * Vista "Base de Datos".
 *
 * Dos clases de tabla:
 *  - MAESTRO: el padrón (Equipos + Consumos Estimados fusionados). Totalmente editable:
 *    se puede corregir cualquier celda, agregar columnas propias y dar de alta equipos.
 *    Lo que se edita a mano queda marcado para que una reimportación no lo pise.
 *  - MOVIMIENTOS: cargas, GPS y cualquier planilla genérica (cubiertas, insumos, filtros…).
 *    Se muestran en solo lectura, con INTERNO + DOMINIO siempre visibles y filtros de
 *    año/mes, porque son el registro histórico de lo que pasó.
 */
import {
    getAllEquipos, getAllRawRecords, updateEquipo, deleteEquipo, editarCampoEquipo,
    getColumnasExtra, setColumnasExtra, getTiposDeMovimiento
} from '../data/database.js';
import { periodosDisponibles, filtrarPorPeriodo } from '../data/analyzer.js';
import { MESES, getDenominacion, normalizeEquipoKey, slugCampo } from '../data/normalizer.js';

const PAGINA = 300; // filas por página: renderizar 3.800 <tr> de una traba el navegador

const estado = { tipo: 'maestro', buscar: '', anio: '', mes: '', pagina: 0 };
let filasActuales = [];
let columnasExtra = [];
let columnasVisibles = [];

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function renderDataTable(tipo) {
    if (tipo) { estado.tipo = tipo; estado.pagina = 0; }
    const tbody = document.getElementById('table-body');
    const header = document.getElementById('table-header');
    if (!tbody || !header) return;

    tbody.innerHTML = '<tr><td colspan="10">Cargando...</td></tr>';

    try {
        await renderTabs();
        columnasExtra = await getColumnasExtra();

        if (estado.tipo === 'maestro') await renderMaestro();
        else await renderMovimientos(estado.tipo);
    } catch (e) {
        console.error('Error al renderizar la tabla:', e);
        tbody.innerHTML = `<tr><td colspan="10" style="color:var(--accent-red)">Error: ${esc(e.message)}</td></tr>`;
    }
}

async function renderTabs() {
    const cont = document.getElementById('tabla-tabs');
    if (!cont) return;
    const tipos = await getTiposDeMovimiento();
    const equipos = await getAllEquipos();

    const tabs = [{ tipo: 'maestro', etiqueta: 'Maestro de Equipos', n: equipos.length }, ...tipos];
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
    { k: 'ubicacion', label: 'Ubicación', editable: true }
];

async function renderMaestro() {
    const equipos = await getAllEquipos();
    document.getElementById('table-title').textContent = 'Maestro de Equipos';
    document.getElementById('table-desc').innerHTML =
        'Padrón + metas de consumo en una sola tabla. <strong>Todas las celdas son editables</strong> y lo que corrijas a mano queda protegido: si volvés a importar la planilla, no se pisa. La llave es <strong>interno + dominio</strong>.';
    mostrarBotonesMaestro(true);
    mostrarFiltrosFecha(false);

    let filas = equipos.slice().sort((a, b) => (a.interno || '').localeCompare(b.interno || ''));
    if (estado.buscar) {
        const q = estado.buscar.toUpperCase();
        filas = filas.filter(e => JSON.stringify(e).toUpperCase().includes(q));
    }
    filasActuales = filas;
    columnasVisibles = [...CAMPOS_MAESTRO.map(c => c.label), ...columnasExtra.map(c => c.label)];

    document.getElementById('table-header').innerHTML =
        CAMPOS_MAESTRO.map(c => `<th>${esc(c.label)}</th>`).join('') +
        columnasExtra.map(c => `<th class="th-extra">${esc(c.label)}
            <button class="th-del" data-col="${esc(c.id)}" title="Eliminar columna"><i class="fa-solid fa-xmark"></i></button></th>`).join('') +
        '<th class="th-acciones"></th>';

    const pagina = filas.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
    document.getElementById('table-body').innerHTML = pagina.map(e => {
        const editados = e.editado_manual || [];
        return `<tr data-interno="${esc(e.interno)}">
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
    }).join('') || '<tr><td colspan="12">No hay equipos en el maestro. Subí la planilla de Equipos o agregá uno con el botón "Equipo".</td></tr>';

    actualizarContador(filas.length, pagina.length);
    renderPaginacion(filas.length);
    conectarEdicionMaestro();
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
                    // Si se edita la meta hay que mantener el texto coherente para el panel.
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
    document.getElementById('table-desc').innerHTML =
        'Registro histórico, en solo lectura. Se muestra <strong>interno + dominio</strong> de cada fila: es la llave con la que se cruza contra el maestro.';
    mostrarBotonesMaestro(false);
    mostrarFiltrosFecha(true);
    poblarFiltrosFecha(todos);

    let filas = filtrarPorPeriodo(todos, { anio: estado.anio || null, mes: estado.mes || null });
    if (estado.buscar) {
        const q = estado.buscar.toUpperCase();
        filas = filas.filter(r => JSON.stringify(r).toUpperCase().includes(q));
    }
    filas.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    filasActuales = filas;

    // Columnas: identidad siempre primero, después las propias del tipo.
    let cols = COLS_MOV[tipo];
    if (!cols) {
        // Planilla genérica: se usan sus columnas originales, sin las de identidad ya mostradas.
        const muestra = filas[0]?.datos || {};
        cols = Object.keys(muestra)
            .filter(c => !/INTERNO|DOMINIO|PATENTE|UNIDAD|MATRICULA/.test(c))
            .slice(0, 12)
            .map(c => ({ k: `datos.${c}`, label: c }));
    }
    columnasVisibles = ['Interno', 'Dominio', ...cols.map(c => c.label)];

    document.getElementById('table-header').innerHTML =
        '<th>Interno</th><th>Dominio</th>' + cols.map(c => `<th>${esc(c.label)}</th>`).join('');

    const pagina = filas.slice(estado.pagina * PAGINA, (estado.pagina + 1) * PAGINA);
    document.getElementById('table-body').innerHTML = pagina.map(r => {
        const h = (r.horas && typeof r.horas === 'object') ? r.horas : { ralenti: 0, movimiento: parseFloat(r.horas) || 0, total: parseFloat(r.horas) || 0 };
        return `<tr>
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
        </tr>`;
    }).join('') || `<tr><td colspan="10">No hay registros${estado.anio || estado.mes ? ' en el período elegido' : ''}.</td></tr>`;

    actualizarContador(filas.length, pagina.length, resumenNumerico(filas, tipo));
    renderPaginacion(filas.length);
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

// ============================================================ UI compartida

function mostrarBotonesMaestro(v) {
    ['btn-add-col', 'btn-add-row'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.style.display = v ? '' : 'none';
    });
}

function mostrarFiltrosFecha(v) {
    ['tabla-anio', 'tabla-mes'].forEach(id => {
        const s = document.getElementById(id);
        if (s) s.style.display = v ? '' : 'none';
    });
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
    document.getElementById('tabla-anio')?.addEventListener('change', e => { estado.anio = e.target.value; estado.pagina = 0; renderDataTable(); });
    document.getElementById('tabla-mes')?.addEventListener('change', e => { estado.mes = e.target.value; estado.pagina = 0; renderDataTable(); });

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
