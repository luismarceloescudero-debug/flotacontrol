/**
 * Panel unificado: KPIs globales + tarjetas de equipos en una sola página.
 *
 * Antes el Dashboard y la vista de Equipos eran dos pantallas separadas que leían la base
 * y calculaban los totales por su cuenta, con lógica duplicada que había divergido (por eso
 * mostraban números distintos). Ahora ambos consumen un único análisis (`analizarFlota`)
 * hecho de una sola pasada sobre las 4 fuentes.
 */
import { getAllEquipos, getAllRawRecords, getAllEstimados, updateEquipo, updateEstimado } from '../data/database.js';
import { analizarFlota } from '../data/analyzer.js';
import { TIPO_POR_PREFIJO } from '../data/normalizer.js';
import { openUnitModal } from './modals.js';

// Estado de la vista (filtros y orden). Se conserva entre renders.
const view = {
    busqueda: '',
    denominacion: 'ALL',
    estado: 'ALL',
    orden: 'litros',
    editando: null // interno del equipo en modo edición
};

let ultimoAnalisis = null;

export async function renderPanel() {
    const kpiEl = document.getElementById('panel-kpis');
    const cardsEl = document.getElementById('cards-container');
    if (!kpiEl || !cardsEl) return;

    kpiEl.innerHTML = '<p style="color:var(--text-muted)">Analizando datos...</p>';

    try {
        const [equipos, rawRecords, estimados] = await Promise.all([
            getAllEquipos(), getAllRawRecords(), getAllEstimados()
        ]);

        if (equipos.length === 0 && rawRecords.length === 0) {
            kpiEl.innerHTML = '';
            cardsEl.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    <h3>Todavía no hay datos cargados</h3>
                    <p>Andá a "Carga de Datos", subí los Excel de Equipos, Cargas, Resumen de Flota y Consumos Estimados, y presioná "Procesar y Analizar".</p>
                </div>`;
            return;
        }

        ultimoAnalisis = analizarFlota({ equipos, rawRecords, estimados });
        renderKPIs(kpiEl, ultimoAnalisis.totales);
        poblarFiltroDenominacion(ultimoAnalisis.filas);
        renderCards(cardsEl, ultimoAnalisis);
    } catch (e) {
        console.error('Error renderizando el panel:', e);
        kpiEl.innerHTML = `<p style="color:var(--accent-red)">Error al analizar los datos: ${e.message}</p>`;
    }
}

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

function renderKPIs(el, t) {
    const rango = (t.periodo_desde && t.periodo_hasta)
        ? `${t.periodo_desde} → ${t.periodo_hasta}`
        : 'Sin período común entre Cargas y GPS';

    el.innerHTML = `
        <div class="periodo-bar">
            <div>
                <span class="periodo-label">Período analizado (auto-alineado)</span>
                <span class="periodo-valor">${rango}</span>
            </div>
            <div class="periodo-detalle">
                ${nf(t.cantidad_cargas)} cargas · ${nf(t.cantidad_gps)} registros GPS · ${t.equipos_con_datos}/${t.equipos} equipos con movimiento
            </div>
        </div>

        <div class="kpi-grid">
            <div class="kpi-card" onclick="window.showDataTable('carga')">
                <span class="kpi-label">Combustible</span>
                <span class="kpi-value">${nf(t.total_litros, 0)} <small>L</small></span>
                <span class="kpi-sub">${nf(t.cantidad_cargas)} cargas registradas</span>
            </div>
            <div class="kpi-card" onclick="window.showDataTable('carga')">
                <span class="kpi-label">Costo total</span>
                <span class="kpi-value">$${nf(t.total_costo, 0)}</span>
                <span class="kpi-sub">$${nf(t.costo_por_litro, 0)} por litro promedio</span>
            </div>
            <div class="kpi-card" onclick="window.showDataTable('gps')">
                <span class="kpi-label">Distancia</span>
                <span class="kpi-value">${nf(t.total_km, 0)} <small>km</small></span>
                <span class="kpi-sub">Según Resumen de Flota (GPS)</span>
            </div>
            <div class="kpi-card" onclick="window.showDataTable('gps')">
                <span class="kpi-label">Horas de uso</span>
                <span class="kpi-value">${nf(t.total_horas, 0)} <small>hs</small></span>
                <span class="kpi-sub">${nf(t.horas_movimiento, 0)} en movimiento · ${nf(t.horas_ralenti, 0)} en ralentí</span>
            </div>
            <div class="kpi-card ${t.sobre_meta > 0 ? 'kpi-alert' : ''}">
                <span class="kpi-label">Sobre la meta</span>
                <span class="kpi-value">${t.sobre_meta}</span>
                <span class="kpi-sub">equipos +15% sobre su consumo estimado</span>
            </div>
            <div class="kpi-card ${t.sin_calculo > 0 ? 'kpi-warn' : ''}">
                <span class="kpi-label">Sin consumo calculable</span>
                <span class="kpi-value">${t.sin_calculo}</span>
                <span class="kpi-sub">${t.con_meta} de ${t.equipos} equipos tienen meta cargada</span>
            </div>
        </div>

        ${t.horas_ralenti > 0 ? `
        <div class="insight-bar">
            <i class="fa-solid fa-circle-info"></i>
            El <strong>${nf(t.horas_ralenti / (t.horas_ralenti + t.horas_movimiento) * 100, 1)}%</strong> de las horas registradas fue en ralentí
            (${nf(t.horas_ralenti, 0)} hs). Es combustible quemado sin producción.
        </div>` : ''}

        ${t.huerfanos && t.huerfanos.length ? `
        <div class="insight-bar insight-warn">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <strong>${t.huerfanos.length}</strong> códigos aparecen en Cargas/GPS pero no están en la planilla de Equipos
            (${t.huerfanos.slice(0, 6).map(h => h.interno).join(', ')}${t.huerfanos.length > 6 ? '…' : ''}).
            Su combustible no se asigna a ningún equipo.
        </div>` : ''}
    `;
}

function poblarFiltroDenominacion(filas) {
    const sel = document.getElementById('filter-denominacion');
    if (!sel) return;
    const actual = sel.value || 'ALL';
    const denos = [...new Set(filas.map(f => f.equipo.denominacion).filter(Boolean))].sort();
    sel.innerHTML = '<option value="ALL">Todas las denominaciones</option>' +
        denos.map(d => `<option value="${d}">${d}</option>`).join('');
    sel.value = denos.includes(actual) || actual === 'ALL' ? actual : 'ALL';
}

function filtrarYOrdenar(filas) {
    let out = filas.slice();

    if (view.busqueda) {
        const q = view.busqueda.toUpperCase();
        out = out.filter(f =>
            (f.equipo.interno || '').includes(q) ||
            (f.equipo.dominio || '').includes(q) ||
            (f.equipo.denominacion || '').includes(q) ||
            (f.equipo.marca || '').includes(q) ||
            (f.equipo.modelo || '').includes(q)
        );
    }

    if (view.denominacion !== 'ALL') {
        out = out.filter(f => f.equipo.denominacion === view.denominacion);
    }

    if (view.estado === 'SOBRE') out = out.filter(f => f.metrics.desvio_pct !== null && f.metrics.desvio_pct > 15);
    else if (view.estado === 'OK') out = out.filter(f => f.metrics.desvio_pct !== null && f.metrics.desvio_pct <= 15);
    else if (view.estado === 'SIN_DATOS') out = out.filter(f => f.metrics.motivo_sin_calculo && f.metrics.tipo_calculo !== 'No Aplica');
    else if (view.estado === 'CON_CONSUMO') out = out.filter(f => f.metrics.consumo_real > 0);

    const ord = {
        litros: (a, b) => b.metrics.total_litros - a.metrics.total_litros,
        costo: (a, b) => b.metrics.total_costo - a.metrics.total_costo,
        desvio: (a, b) => (b.metrics.desvio_pct ?? -Infinity) - (a.metrics.desvio_pct ?? -Infinity),
        interno: (a, b) => (a.equipo.interno || '').localeCompare(b.equipo.interno || '')
    };
    out.sort(ord[view.orden] || ord.litros);
    return out;
}

function renderCards(container, analisis) {
    const filas = filtrarYOrdenar(analisis.filas);
    const contador = document.getElementById('cards-count');

    if (contador) {
        const litros = filas.reduce((s, f) => s + f.metrics.total_litros, 0);
        contador.textContent = `${filas.length} equipos · ${nf(litros, 0)} L`;
    }

    if (filas.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-magnifying-glass"></i><h3>Ningún equipo coincide con el filtro</h3></div>`;
        return;
    }

    // Máximo de litros del set filtrado, para la barra de participación de cada tarjeta.
    const maxLitros = Math.max(...filas.map(f => f.metrics.total_litros), 1);

    container.innerHTML = filas.map(f => cardHTML(f, maxLitros)).join('');
    container.querySelectorAll('.equip-card').forEach(card => {
        const interno = card.dataset.interno;
        card.querySelector('.btn-card-edit')?.addEventListener('click', (e) => {
            e.stopPropagation();
            view.editando = view.editando === interno ? null : interno;
            renderCards(container, analisis);
        });
        card.querySelector('.btn-card-save')?.addEventListener('click', (e) => {
            e.stopPropagation();
            guardarEdicion(interno, card);
        });
        card.querySelector('.btn-card-cancel')?.addEventListener('click', (e) => {
            e.stopPropagation();
            view.editando = null;
            renderCards(container, analisis);
        });
        card.querySelector('.btn-card-detail')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const fila = analisis.filas.find(x => x.equipo.interno === interno);
            if (fila) openUnitModal(fila.equipo, fila.metrics, fila.confirmed, fila.cargas, fila.gps);
        });
    });
}

function estadoDe(m, confirmed) {
    if (m.tipo_calculo === 'No Aplica') return { cls: 'neutral', txt: 'Sin motor propio', icon: 'fa-ban' };
    if (m.motivo_sin_calculo) return { cls: 'warn', txt: m.motivo_sin_calculo, icon: 'fa-circle-info' };
    if (!confirmed || !confirmed.valor) return { cls: 'neutral', txt: 'Consumo calculado, falta meta', icon: 'fa-circle-question' };
    const d = m.desvio_pct;
    if (d === null) return { cls: 'neutral', txt: 'Sin comparación', icon: 'fa-circle-question' };
    if (d > 15) return { cls: 'alert', txt: `${nf(d, 0)}% sobre la meta`, icon: 'fa-triangle-exclamation' };
    if (d < -15) return { cls: 'ok', txt: `${nf(Math.abs(d), 0)}% bajo la meta`, icon: 'fa-arrow-down' };
    return { cls: 'ok', txt: 'Dentro de la meta', icon: 'fa-check' };
}

function cardHTML(f, maxLitros) {
    const { equipo: eq, metrics: m, confirmed } = f;
    const editando = view.editando === eq.interno;
    const est = estadoDe(m, confirmed);
    const esHora = m.tipo_calculo === 'L/Hora';
    const unidadFactor = esHora ? 'hs' : 'km';
    const factor = esHora ? m.total_horas : m.total_km;
    const pctLitros = (m.total_litros / maxLitros) * 100;

    // Barra comparativa real vs meta: la meta es el 100% de referencia.
    let barra = '';
    if (m.consumo_real > 0 && confirmed && confirmed.valor > 0) {
        const pct = Math.min((m.consumo_real / confirmed.valor) * 100, 200);
        const color = m.desvio_pct > 15 ? 'var(--accent-red)' : (m.desvio_pct < -15 ? 'var(--accent-cyan)' : 'var(--accent-green)');
        barra = `
            <div class="meta-bar">
                <div class="meta-bar-track">
                    <div class="meta-bar-fill" style="width:${Math.min(pct, 100)}%; background:${color}"></div>
                    <div class="meta-bar-target" title="Meta: ${confirmed.value}"></div>
                </div>
                <div class="meta-bar-legend">
                    <span>Real <strong style="color:${color}">${nf(m.consumo_real, 2)}</strong></span>
                    <span>Meta <strong>${nf(confirmed.valor, 2)}</strong> ${m.tipo_calculo}</span>
                </div>
            </div>`;
    }

    const cuerpoEdicion = `
        <div class="card-edit">
            <label>Denominación
                <input type="text" class="edit-denominacion" value="${eq.denominacion || ''}" list="denominaciones-list">
            </label>
            <div class="edit-row">
                <label>Meta de consumo
                    <input type="number" step="0.1" min="0" class="edit-meta" value="${confirmed ? confirmed.valor : ''}" placeholder="ej: 8">
                </label>
                <label>Se mide por
                    <select class="edit-unidad">
                        <option value="">(sin definir)</option>
                        <option value="L/Hora" ${m.tipo_calculo === 'L/Hora' ? 'selected' : ''}>L/Hora</option>
                        <option value="L/100Km" ${m.tipo_calculo === 'L/100Km' ? 'selected' : ''}>L/100Km</option>
                        <option value="No Aplica" ${m.tipo_calculo === 'No Aplica' ? 'selected' : ''}>No aplica</option>
                    </select>
                </label>
            </div>
            <div class="edit-actions">
                <button class="btn-primary btn-card-save"><i class="fa-solid fa-check"></i> Guardar</button>
                <button class="btn-secondary btn-card-cancel">Cancelar</button>
            </div>
        </div>`;

    const cuerpoNormal = `
        <div class="card-stats">
            <div class="stat">
                <span class="stat-label">Combustible</span>
                <span class="stat-value">${nf(m.total_litros, 1)} <small>L</small></span>
            </div>
            <div class="stat">
                <span class="stat-label">Costo</span>
                <span class="stat-value">$${nf(m.total_costo, 0)}</span>
            </div>
            <div class="stat">
                <span class="stat-label">${esHora ? 'Horas' : 'Distancia'}</span>
                <span class="stat-value">${nf(factor, esHora ? 1 : 0)} <small>${unidadFactor}</small></span>
            </div>
            <div class="stat">
                <span class="stat-label">Consumo real</span>
                <span class="stat-value ${m.consumo_real > 0 ? 'stat-highlight' : 'stat-muted'}">
                    ${m.consumo_real > 0 ? nf(m.consumo_real, 2) : '—'}
                </span>
            </div>
        </div>

        ${barra}

        <div class="card-meta-line">
            <span><i class="fa-solid fa-gas-pump"></i> ${m.cantidad_cargas} cargas</span>
            <span><i class="fa-solid fa-satellite-dish"></i> ${m.cantidad_gps} GPS</span>
            ${m.horas_ralenti > 0 ? `<span><i class="fa-solid fa-hourglass-half"></i> ${nf(m.horas_ralenti, 0)} hs ralentí</span>` : ''}
        </div>

        <div class="litros-bar" title="Participación en el consumo total">
            <div class="litros-bar-fill" style="width:${pctLitros}%"></div>
        </div>
    `;

    return `
        <div class="equip-card ${editando ? 'editing' : ''}" data-interno="${eq.interno}">
            <div class="card-top">
                <div>
                    <h3>${eq.interno} ${eq.dominio ? `<small>${eq.dominio}</small>` : ''}</h3>
                    <p class="card-deno">${eq.denominacion || 'SIN CLASIFICAR'}</p>
                    <p class="card-modelo">${[eq.marca, eq.modelo].filter(Boolean).join(' ')}</p>
                </div>
                <div class="card-actions">
                    <button class="btn-icon btn-card-detail" title="Ver detalle y cálculo"><i class="fa-solid fa-chart-simple"></i></button>
                    <button class="btn-icon btn-card-edit" title="Editar equipo"><i class="fa-solid ${editando ? 'fa-xmark' : 'fa-pen'}"></i></button>
                </div>
            </div>

            ${editando ? cuerpoEdicion : cuerpoNormal}

            <div class="card-status status-${est.cls}">
                <i class="fa-solid ${est.icon}"></i> ${est.txt}
            </div>
        </div>`;
}

/**
 * Guarda los cambios hechos a mano en la tarjeta: denominación, meta y unidad de medición.
 * La unidad elegida se guarda como `tipo_calculo_manual` en el equipo, que tiene prioridad
 * sobre la unidad del Excel de metas (permite corregir a mano un equipo mal clasificado sin
 * tener que editar la planilla).
 */
async function guardarEdicion(interno, cardEl) {
    const fila = ultimoAnalisis?.filas.find(f => f.equipo.interno === interno);
    if (!fila) return;

    const denominacion = (cardEl.querySelector('.edit-denominacion')?.value || '').toUpperCase().trim();
    const metaValor = parseFloat(cardEl.querySelector('.edit-meta')?.value);
    const unidad = cardEl.querySelector('.edit-unidad')?.value || '';

    try {
        await updateEquipo({
            ...fila.equipo,
            denominacion: denominacion || fila.equipo.denominacion,
            tipo_calculo_manual: unidad || null
        });

        if (!isNaN(metaValor) && metaValor > 0 && unidad && unidad !== 'No Aplica') {
            const sufijo = unidad === 'L/Hora' ? 'L/hora' : 'L/100km';
            await updateEstimado({
                interno: fila.equipo.interno,
                interno_key: fila.equipo.interno_key || fila.equipo.interno,
                consumo_estimado: `${metaValor} ${sufijo}`,
                consumo_estimado_valor: metaValor,
                consumo_estimado_unidad: unidad,
                source_file: 'Editado manualmente'
            });
        }

        view.editando = null;
        await renderPanel();
    } catch (e) {
        console.error('No se pudo guardar el equipo:', e);
        alert('No se pudieron guardar los cambios: ' + e.message);
    }
}

/** Conecta los controles de filtro/orden del panel. Se llama una sola vez al iniciar. */
export function initPanelControls() {
    const search = document.getElementById('search-equip');
    const fDeno = document.getElementById('filter-denominacion');
    const fEstado = document.getElementById('filter-estado');
    const fOrden = document.getElementById('sort-by');
    const container = document.getElementById('cards-container');

    const rerender = () => { if (ultimoAnalisis && container) renderCards(container, ultimoAnalisis); };

    let debounce;
    search?.addEventListener('input', (e) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { view.busqueda = e.target.value.trim(); rerender(); }, 200);
    });
    fDeno?.addEventListener('change', (e) => { view.denominacion = e.target.value; rerender(); });
    fEstado?.addEventListener('change', (e) => { view.estado = e.target.value; rerender(); });
    fOrden?.addEventListener('change', (e) => { view.orden = e.target.value; rerender(); });

    // Datalist con las denominaciones canónicas, para que editar una tarjeta sugiera
    // los valores válidos en vez de dejar escribir cualquier cosa.
    if (!document.getElementById('denominaciones-list')) {
        const dl = document.createElement('datalist');
        dl.id = 'denominaciones-list';
        dl.innerHTML = Object.values(TIPO_POR_PREFIJO).map(v => `<option value="${v}">`).join('');
        document.body.appendChild(dl);
    }
}
