/**
 * Vista "Seguimiento": junta en una sola pantalla, filtrable, todo lo que quedó marcado para
 * revisar — antes esos datos vivían repartidos entre la franja de cobertura de cada tarjeta
 * (que solo se ve una por una, scrolleando el panel) y las tarjetas del diagnóstico automático.
 * Acá se pueden filtrar y analizar juntos, en vez de tener que revisar equipo por equipo.
 *
 * A propósito NO duplica acciones mutables (aceptar ralentí, generar reclamo GPS): esas ya
 * viven — y funcionan bien — en el diagnóstico del Panel. Esta vista es el índice: agrupa,
 * filtra y lleva directo a la tabla de cargas o al equipo en cuestión.
 */
import { datosParaSeguimiento } from './panel.js';
import { coberturaEquipo } from '../data/diagnostico.js';

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { tipo: 'ALL', buscar: '' };

const TIPOS = {
    cargas_exceso: { etiqueta: 'Cargas > días hábiles', icono: 'fa-triangle-exclamation', clase: 'seg-alta' },
    estimacion_inverosimil: { etiqueta: 'Estimación no creíble', icono: 'fa-circle-question', clase: 'seg-alta' },
    meta_rara: { etiqueta: 'Meta que no cierra', icono: 'fa-bullseye', clase: 'seg-media' },
    datos_parciales: { etiqueta: 'Datos de parte del período', icono: 'fa-calendar-day', clase: 'seg-media' },
    cobertura_baja: { etiqueta: 'Cobertura baja (<40%)', icono: 'fa-chart-simple', clase: 'seg-media' },
    ralenti: { etiqueta: 'Ralentí a revisar', icono: 'fa-hourglass-half', clase: 'seg-media' },
    ralenti_camioneta: { etiqueta: 'Ralentí camionetas', icono: 'fa-truck-pickup', clase: 'seg-media' },
    ralenti_inverosimil: { etiqueta: 'Ralentí inverosímil', icono: 'fa-circle-exclamation', clase: 'seg-alta' }
};

/** Arma la lista plana de "para revisar" a partir del diagnóstico ya calculado + una pasada
 * propia de cobertura por equipo (que el diagnóstico no expone hallazgo por hallazgo). */
function armarItems() {
    const datos = datosParaSeguimiento();
    if (!datos) return [];
    const { analisis, hallazgos } = datos;
    const items = [];

    const HALLAZGOS_A_TIPO = {
        ralenti: 'ralenti', ralenti_camionetas: 'ralenti_camioneta', ralenti_inverosimil: 'ralenti_inverosimil',
        estimacion_inverosimil: 'estimacion_inverosimil', metas: 'meta_rara', datos_parciales: 'datos_parciales'
    };
    hallazgos.forEach(h => {
        if (h.id === 'cargas_exceden_dias_habiles') {
            (h.equipos || []).forEach(e => items.push({
                interno: e.interno, denominacion: e.denominacion, tipo: 'cargas_exceso',
                detalle: `${e.texto} — ${e.sub}`,
                accion: { texto: 'Ver cargas de ese mes', anio: e.anio, mes: e.mes }
            }));
        } else if (HALLAZGOS_A_TIPO[h.id]) {
            const tipo = HALLAZGOS_A_TIPO[h.id];
            (h.equipos || []).forEach(e => items.push({
                interno: e.interno, denominacion: e.denominacion, tipo,
                detalle: `${e.texto} — ${e.sub}`,
                accion: { texto: 'Ver equipo' }
            }));
        }
    });

    // Cobertura baja: no viene como hallazgo propio (confiabilidad() la usa como uno de varios
    // avisos posibles, mezclada con otros motivos), así que se recorre acá directamente con la
    // misma coberturaEquipo() que ya usa la tarjeta — mismo número en los dos lados.
    (analisis.filas || []).forEach(f => {
        if (!f.metrics || f.metrics.cantidad_cargas <= 0) return;
        const cob = coberturaEquipo(f);
        if (cob && !cob.exceso && cob.pct < 40) {
            items.push({
                interno: f.equipo.interno, denominacion: f.equipo.denominacion, tipo: 'cobertura_baja',
                detalle: `${cob.cargas} cargas de ${cob.diasHabiles} días hábiles del período (${cob.pct}%)`,
                accion: { texto: 'Ver equipo' }
            });
        }
    });

    return items;
}

export function renderSeguimiento() {
    const cont = document.getElementById('view-seguimiento');
    if (!cont) return;
    const filtroEl = document.getElementById('seg-filtro-tipo');
    const buscarEl = document.getElementById('seg-buscar');
    const listaEl = document.getElementById('seg-lista');
    const countEl = document.getElementById('seg-count');
    if (!listaEl) return;

    const items = armarItems();

    if (filtroEl && !filtroEl.dataset.poblado) {
        const conteoPorTipo = new Map();
        items.forEach(it => conteoPorTipo.set(it.tipo, (conteoPorTipo.get(it.tipo) || 0) + 1));
        filtroEl.innerHTML = '<option value="ALL">Todas las alertas</option>' +
            Object.keys(TIPOS).filter(t => conteoPorTipo.has(t)).map(t =>
                `<option value="${t}">${esc(TIPOS[t].etiqueta)} (${conteoPorTipo.get(t)})</option>`).join('');
        filtroEl.dataset.poblado = '1';
        filtroEl.value = state.tipo;
        filtroEl.addEventListener('change', () => { state.tipo = filtroEl.value; renderSeguimiento(); });
    }
    if (buscarEl && !buscarEl.dataset.wired) {
        buscarEl.dataset.wired = '1';
        buscarEl.value = state.buscar;
        buscarEl.addEventListener('input', () => { state.buscar = buscarEl.value; renderSeguimiento(); });
    }

    if (!items.length) {
        listaEl.innerHTML = `<div class="empty-state">
            <i class="fa-solid fa-circle-check" style="color:var(--accent-green)"></i>
            <h3>Nada para revisar</h3>
            <p>No hay ralentí sin marcar, cobertura floja ni cargas que excedan los días hábiles con los datos y filtros actuales del Panel.</p>
        </div>`;
        if (countEl) countEl.textContent = '';
        return;
    }

    const q = state.buscar.trim().toUpperCase();
    const filtrados = items.filter(it =>
        (state.tipo === 'ALL' || it.tipo === state.tipo) &&
        (!q || it.interno.toUpperCase().includes(q) || (it.denominacion || '').toUpperCase().includes(q))
    );
    filtrados.sort((a, b) => a.interno.localeCompare(b.interno));

    if (countEl) countEl.textContent = `${filtrados.length} de ${items.length}`;

    if (!filtrados.length) {
        listaEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-filter"></i><h3>Ningún resultado con este filtro</h3><p>Probá con otro tipo de alerta o limpiá la búsqueda.</p></div>`;
        return;
    }

    listaEl.innerHTML = `
        <div class="table-responsive">
            <table class="data-table">
                <thead><tr><th>Equipo</th><th>Alerta</th><th>Detalle</th><th></th></tr></thead>
                <tbody>
                    ${filtrados.map(it => {
                        const t = TIPOS[it.tipo] || { etiqueta: it.tipo, icono: 'fa-circle', clase: 'sev-baja' };
                        return `<tr data-interno="${esc(it.interno)}">
                            <td><strong style="color:var(--accent-cyan)">${esc(it.interno)}</strong><br><small style="color:var(--text-muted)">${esc(it.denominacion || '')}</small></td>
                            <td><span class="seg-badge ${t.clase}"><i class="fa-solid ${t.icono}"></i> ${esc(t.etiqueta)}</span></td>
                            <td>${esc(it.detalle)}</td>
                            <td>
                                ${it.accion.anio ? `<button class="btn-xs btn-seg-ver-mes" data-interno="${esc(it.interno)}" data-anio="${esc(it.accion.anio)}" data-mes="${esc(it.accion.mes)}"><i class="fa-solid fa-table-list"></i> ${esc(it.accion.texto)}</button>`
                                    : `<button class="btn-xs btn-seg-ver-equipo" data-interno="${esc(it.interno)}"><i class="fa-solid fa-magnifying-glass"></i> ${esc(it.accion.texto)}</button>`}
                            </td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>`;

    listaEl.querySelectorAll('.btn-seg-ver-mes').forEach(b => {
        b.addEventListener('click', () => {
            const { interno, anio, mes } = b.dataset;
            if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', interno, 'id', { anio, mes });
        });
    });
    listaEl.querySelectorAll('.btn-seg-ver-equipo').forEach(b => {
        b.addEventListener('click', () => {
            if (typeof window.irAPanelConBusqueda === 'function') window.irAPanelConBusqueda(b.dataset.interno);
        });
    });
}
