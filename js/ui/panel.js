/**
 * Panel unificado: KPIs + diagnóstico + tarjetas, en una sola página.
 *
 * Todo número mostrado acá registra sus pasos de cálculo (ver calcpopover.js): al hacer
 * click en cualquier KPI o métrica de una tarjeta se abre el detalle de cómo se obtuvo.
 */
import { getAllEquipos, getAllRawRecords, getAllEstimados, updateEquipo, editarCampoEquipo } from '../data/database.js';
import { analizarFlota, periodosDisponibles, resumirMovimientosGenericos } from '../data/analyzer.js';
import { generarDiagnostico, sugerirMeta, evolucionMensual, categoriaRalenti, actividadImplicita } from '../data/diagnostico.js';
import { TIPO_POR_PREFIJO, MESES } from '../data/normalizer.js';
import { diasHabiles } from '../data/feriados.js';
import { openUnitModal } from './modals.js';
import { abrirAjusteMetas } from './metas.js';
import { abrirComparativa } from './comparativa.js';
import { registrarCalculo, limpiarCalculos } from './calcpopover.js';

const view = {
    busqueda: '', denominacion: 'ALL', estado: 'ALL', orden: 'litros',
    provincia: 'ALL', lugarCarga: 'ALL', centroCosto: 'ALL', combustible: 'ALL',
    anioEquipo: 'ALL', potencia: 'ALL', capacidad: 'ALL',
    anio: '', mes: '', editando: null
};

/** Interpretación del ralentí según el tipo de equipo (motor de diagnóstico, ver diagnostico.js). */
const RALENTI_INFO = {
    estacionario: { texto: 'es su trabajo', clase: 'ralenti-ok', icono: 'fa-plug-circle-check' },
    espera: { texto: 'espera operativa', clase: 'ralenti-warn', icono: 'fa-truck-ramp-box' },
    desperdicio: { texto: 'a revisar', clase: 'ralenti-alert', icono: 'fa-hourglass-half' }
};

let ultimoAnalisis = null;
let datosCrudos = null;

// Equipos marcados para comparar desde las tarjetas (checkbox en cada card + barra flotante),
// para no depender de buscar manualmente cada equipo dentro del modal de comparativa.
const comparSeleccion = new Set();

// Estado del diagnóstico entre renders: qué hallazgos había la vez anterior (para poder avisar
// cuáles se resolvieron) y qué tarjetas tenía el usuario abiertas (para no perder su lugar cada
// vez que se recalcula, por ejemplo después de ajustar una meta o sumar un archivo nuevo).
let diagHallazgosPrevios = null; // null = todavía no se calculó ningún diagnóstico
const diagAbiertos = new Map();

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Importes de la flota en pesos llegan a diez cifras y no entran en una tarjeta sin
 * romperse en dos líneas a mitad del número. Se muestran abreviados en millones y el
 * valor exacto queda a la vista debajo y en el detalle del cálculo.
 */
const money = (n) => Math.abs(n) >= 1e6 ? `$${nf(n / 1e6, 1)} M` : `$${nf(n)}`;

/** Unidad de consumo tal como se mide el equipo, para mostrarla siempre junto al número (nunca un valor "pelado" sin L/Hora o L/100Km). */
const unidadConsumoLabel = (tipoCalculo) => (tipoCalculo === 'L/Hora' || tipoCalculo === 'L/100Km') ? tipoCalculo : '';

export async function renderPanel() {
    const kpiEl = document.getElementById('panel-kpis');
    const cardsEl = document.getElementById('cards-container');
    if (!kpiEl || !cardsEl) return;

    kpiEl.innerHTML = '<p style="color:var(--text-muted)">Analizando datos...</p>';

    try {
        const [equipos, rawRecords, estimados] = await Promise.all([
            getAllEquipos(), getAllRawRecords(), getAllEstimados()
        ]);
        datosCrudos = { equipos, rawRecords, estimados };

        const fuentes = {
            equipos: equipos.length,
            cargas: rawRecords.filter(r => r.type === 'carga').length,
            gps: rawRecords.filter(r => r.type === 'gps').length,
            metas: equipos.filter(e => e.meta_valor > 0).length || estimados.length,
            otros: rawRecords.filter(r => r.type !== 'carga' && r.type !== 'gps').length
        };

        if (!equipos.length && !rawRecords.length) {
            kpiEl.innerHTML = '';
            document.getElementById('panel-diagnostico').innerHTML = '';
            cardsEl.innerHTML = `<div class="empty-state">
                <i class="fa-solid fa-cloud-arrow-up"></i>
                <h3>Todavía no hay datos cargados</h3>
                <p>Andá a "Carga de Datos" y subí las planillas. Empezá por Equipos y Consumos Estimados (forman la base maestra), después sumá Cargas, Resumen de Flota y lo que tengas.</p>
            </div>`;
            return;
        }

        poblarFiltrosPeriodo(rawRecords);

        limpiarCalculos();
        ultimoAnalisis = analizarFlota({
            equipos, rawRecords, estimados,
            filtro: { anio: view.anio || null, mes: view.mes || null }
        });

        renderKPIs(kpiEl, ultimoAnalisis.totales, fuentes);
        renderDiagnostico(ultimoAnalisis, rawRecords);
        poblarFiltroDenominacion(ultimoAnalisis.filas);
        renderCards(cardsEl, ultimoAnalisis);

        if (!equipos.length) {
            cardsEl.innerHTML = `<div class="empty-state">
                <i class="fa-solid fa-triangle-exclamation" style="color:var(--accent-amber)"></i>
                <h3>Falta la base maestra</h3>
                <p>Hay ${nf(fuentes.cargas)} cargas y ${nf(fuentes.gps)} registros GPS procesados, pero ningún equipo en el padrón, así que ese combustible no se le puede asignar a ninguna máquina.<br><br>
                Subí <strong>Equipos HSV*.xlsx</strong> y <strong>Consumos Estimados*.xlsx</strong>.</p>
            </div>`;
        }
    } catch (e) {
        console.error('Error renderizando el panel:', e);
        kpiEl.innerHTML = `<p style="color:var(--accent-red)">Error al analizar los datos: ${esc(e.message)}</p>`;
    }
}

// ---------------------------------------------------------------- filtros de período

function poblarFiltrosPeriodo(rawRecords) {
    const { anios, meses } = periodosDisponibles(rawRecords);
    const selA = document.getElementById('filter-anio');
    const selM = document.getElementById('filter-mes');
    if (selA && selA.options.length !== anios.length + 1) {
        selA.innerHTML = '<option value="">Todos los años</option>' + anios.map(a => `<option value="${a}">${a}</option>`).join('');
        selA.value = view.anio;
    }
    if (selM && selM.options.length !== meses.length + 1) {
        selM.innerHTML = '<option value="">Todos los meses</option>' + meses.map(m => `<option value="${m}">${MESES[m - 1]}</option>`).join('');
        selM.value = view.mes;
    }
}

// ---------------------------------------------------------------- fuentes

function fuentesHTML(f) {
    const items = [
        { label: 'Equipos', n: f.equipos, archivo: 'Equipos HSV*.xlsx', aporta: 'el padrón' },
        { label: 'Metas', n: f.metas, archivo: 'Consumos Estimados*.xlsx', aporta: 'las metas de consumo' },
        { label: 'Cargas', n: f.cargas, archivo: 'Cargas_Combustible_*.xlsx', aporta: 'litros y costos' },
        { label: 'GPS', n: f.gps, archivo: 'Resumen de Flota*.xlsx', aporta: 'km y horas' }
    ];
    if (f.otros > 0) items.push({ label: 'Otras planillas', n: f.otros, archivo: '', aporta: 'cubiertas, insumos, filtros…' });
    const faltan = items.filter(i => i.n === 0 && i.archivo);

    return `
        <div class="fuentes-bar">
            ${items.map(i => `
                <div class="fuente ${i.n > 0 ? 'ok' : 'falta'}" title="${esc(i.archivo)} — aporta ${esc(i.aporta)}">
                    <i class="fa-solid ${i.n > 0 ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i>
                    <span class="fuente-label">${i.label}</span>
                    <span class="fuente-n">${i.n > 0 ? nf(i.n) : 'falta'}</span>
                </div>`).join('')}
        </div>
        ${faltan.length ? `
        <div class="insight-bar insight-warn">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <div><strong>Falta procesar:</strong> ${faltan.map(i => `<code>${esc(i.archivo)}</code>`).join(' · ')}. Sin eso, los cálculos quedan incompletos.</div>
        </div>` : ''}`;
}

// ---------------------------------------------------------------- KPIs

function kpi({ id, label, valor, sub, clase, titulo, pasos, fuentes, nota }) {
    const attrs = registrarCalculo(id, { titulo: titulo || label, valor, pasos, fuentes, nota });
    return `
        <div class="kpi-card ${clase || ''}" ${attrs} role="button" tabindex="0">
            <span class="kpi-label">${label}</span>
            <span class="kpi-value">${valor}</span>
            <span class="kpi-sub">${sub}</span>
            <span class="kpi-calc"><i class="fa-solid fa-calculator"></i> ver cálculo</span>
        </div>`;
}

/** Etiqueta corta del período elegido ("junio 2026", "período seleccionado"...), reutilizada en los KPIs y en cada tarjeta para que "22 cargas" diga contra qué período se cuenta. */
function rangoCorto() {
    if (view.mes && view.anio) return `${MESES[view.mes - 1]} ${view.anio}`;
    if (view.mes) return MESES[view.mes - 1];
    if (view.anio) return `año ${view.anio}`;
    return 'período seleccionado';
}

function renderKPIs(el, t, fuentes) {
    let rango;
    if (t.periodo_desde && t.periodo_hasta) rango = `${t.periodo_desde} → ${t.periodo_hasta}`;
    else if (view.mes && view.anio) rango = `${MESES[view.mes - 1]} ${view.anio}`;
    else if (view.mes) rango = `${MESES[view.mes - 1]} (todos los años)`;
    else if (view.anio) rango = `Año ${view.anio}`;
    else rango = 'Sin período común entre Cargas y GPS';

    const periodoAttrs = registrarCalculo('kpi-periodo', {
        titulo: 'Período analizado', valor: rango, pasos: t.pasos.periodo,
        nota: 'Cuando no hay filtro manual, la app usa solo el tramo donde existen Cargas y GPS a la vez.'
    });

    const dh = (t.periodo_desde && t.periodo_hasta) ? diasHabiles(t.periodo_desde, t.periodo_hasta) : null;
    const dhTxt = dh && dh.totalCorridos
        ? ` · ${dh.dias} día${dh.dias === 1 ? '' : 's'} hábil${dh.dias === 1 ? '' : 'es'} de ${dh.totalCorridos} corridos${dh.completo ? '' : ' (sin feriados móviles confirmados para ese año)'}`
        : '';

    el.innerHTML = `
        ${fuentesHTML(fuentes)}

        <div class="periodo-bar" ${periodoAttrs} role="button" tabindex="0">
            <div class="periodo-info">
                <span class="periodo-label">Período analizado (${esc(t.criterio_periodo)})</span>
                <span class="periodo-valor">${esc(rango)}</span>
            </div>
            <div class="periodo-detalle">
                ${nf(t.cantidad_cargas)} cargas · ${nf(t.cantidad_gps)} GPS${t.cantidad_otros ? ` · ${nf(t.cantidad_otros)} otros` : ''} · ${t.equipos_con_datos}/${t.equipos} equipos con actividad${dhTxt}
                <span class="kpi-calc"><i class="fa-solid fa-calculator"></i> ver cálculo</span>
            </div>
        </div>

        <div class="kpi-grid">
            ${kpi({ id: 'kpi-litros', label: 'Combustible', valor: `${nf(t.total_litros)} <small>L</small>`, sub: `${nf(t.cantidad_cargas)} cargas registradas`, titulo: 'Combustible total del período', pasos: t.pasos.litros })}
            ${kpi({ id: 'kpi-costo', label: 'Costo total', valor: money(t.total_costo), sub: `$${nf(t.total_costo)} · $${nf(t.costo_por_litro)}/litro`, titulo: 'Costo total del combustible', pasos: t.pasos.costo })}
            ${kpi({ id: 'kpi-km', label: 'Distancia', valor: `${nf(t.total_km)} <small>km</small>`, sub: 'Según Resumen de Flota', titulo: 'Kilómetros recorridos', pasos: t.pasos.km })}
            ${kpi({ id: 'kpi-horas', label: 'Horas de uso', valor: `${nf(t.total_horas)} <small>hs</small>`, sub: `${nf(t.horas_movimiento)} movimiento · ${nf(t.horas_ralenti)} ralentí`, titulo: 'Horas de uso', pasos: t.pasos.horas })}
            ${kpi({ id: 'kpi-sobre', label: 'Sobre la meta', valor: String(t.sobre_meta), sub: `de ${t.con_meta} equipos con meta`, clase: t.sobre_meta > 0 ? 'kpi-alert' : '', titulo: 'Equipos sobre la meta', pasos: t.pasos.sobre_meta })}
            ${kpi({ id: 'kpi-equipos', label: 'Equipos', valor: String(t.equipos), sub: `${t.equipos_con_datos} con actividad · ${t.huerfanos.length} códigos sin padrón`, clase: t.huerfanos.length ? 'kpi-warn' : '', titulo: 'Equipos del maestro', pasos: t.pasos.equipos })}
        </div>`;
}

// ---------------------------------------------------------------- diagnóstico

function renderDiagnostico(analisis, rawRecords = []) {
    const el = document.getElementById('panel-diagnostico');
    if (!el) return;
    const hallazgos = generarDiagnostico(analisis.filas, analisis.totales, rawRecords);

    // Qué categorías de hallazgo había la vez anterior y ya no están: es la señal de que un
    // ajuste de metas o un archivo nuevo realmente cambió algo, no solo un texto que dice
    // "actualizado" sin mostrar qué se limpió.
    const esPrimerCalculo = diagHallazgosPrevios === null;
    const idsNuevos = new Set(hallazgos.map(h => h.id));
    const resueltos = esPrimerCalculo ? [] : [...diagHallazgosPrevios.entries()].filter(([id]) => !idsNuevos.has(id));
    diagAbiertos.forEach((_, id) => { if (!idsNuevos.has(id)) diagAbiertos.delete(id); }); // no arrastrar estado de categorías que ya no existen
    diagHallazgosPrevios = new Map(hallazgos.map(h => [h.id, h.titulo]));

    const bannerResueltos = resueltos.length ? `
        <div class="diag-resuelto">
            <i class="fa-solid fa-broom"></i>
            <div><strong>${resueltos.length === 1 ? 'Se resolvió' : `Se resolvieron ${resueltos.length}`}</strong> desde el último cambio:
                ${resueltos.map(([, titulo]) => `<span class="diag-resuelto-item">${esc(titulo)}</span>`).join('')}
            </div>
        </div>` : '';

    if (!hallazgos.length) {
        el.innerHTML = bannerResueltos || (esPrimerCalculo ? '' : `
            <div class="diag-resuelto">
                <i class="fa-solid fa-circle-check"></i>
                <div>Sin hallazgos: no hay nada para revisar con los datos y metas actuales.</div>
            </div>`);
        return;
    }

    const sev = { alta: 'sev-alta', media: 'sev-media', baja: 'sev-baja', ok: 'sev-ok' };
    const txt = { alta: 'Prioridad alta', media: 'Revisar', baja: 'Menor', ok: 'Positivo' };

    el.innerHTML = `
        ${bannerResueltos}
        <div class="diag-head">
            <h2><i class="fa-solid fa-clipboard-check"></i> Diagnóstico automático</h2>
            <span class="diag-sub">${hallazgos.length} hallazgos calculados sobre los datos del período</span>
        </div>
        <div class="diag-grid">
            ${hallazgos.map((h, i) => {
                // Se respeta lo que el usuario tenía abierto/cerrado entre un render y otro; un
                // hallazgo que aparece por primera vez arranca cerrado, salvo el primero en el
                // primerísimo cálculo (antes de que el usuario haya tocado nada todavía).
                const abierto = diagAbiertos.has(h.id) ? diagAbiertos.get(h.id) : (esPrimerCalculo && i === 0);
                return `
                <details class="diag-card ${sev[h.severidad]}" data-id="${esc(h.id)}" ${abierto ? 'open' : ''}>
                    <summary>
                        <i class="fa-solid ${h.icono} diag-icon"></i>
                        <div class="diag-titulo">
                            <span class="diag-badge">${txt[h.severidad]}</span>
                            <h3>${esc(h.titulo)}</h3>
                        </div>
                        <i class="fa-solid fa-chevron-down diag-chevron"></i>
                    </summary>
                    <div class="diag-body">
                        <p>${h.detalle}</p>
                        ${h.accion ? `<button class="btn-primary btn-sm btn-diag-accion" data-filtro="${esc(h.accion.filtro)}"><i class="fa-solid fa-sliders"></i> ${esc(h.accion.texto)}</button>` : ''}
                        ${h.comparaciones ? h.comparaciones.map(c => `
                            <div class="comparativa">
                                <div class="comparativa-head">
                                    <strong>${esc(c.interno)}</strong> consume <strong>${nf(c.valor, 2)}</strong> ${esc(c.unidad)},
                                    un ${nf(c.exceso_pct)}% sobre la mediana (${nf(c.mediana, 2)}) de ${c.pares.length} ${esc(c.denominacion.toLowerCase())}s:
                                </div>
                                <div class="comparativa-barras">
                                    ${c.pares.map(p => `
                                        <div class="cmp-fila ${p.esEste ? 'cmp-este' : ''}">
                                            <span class="cmp-eq">${esc(p.interno)}</span>
                                            <span class="cmp-barra"><i style="width:${Math.min(p.valor / Math.max(...c.pares.map(x => x.valor)) * 100, 100)}%"></i></span>
                                            <span class="cmp-val">${nf(p.valor, 2)}</span>
                                        </div>`).join('')}
                                </div>
                            </div>`).join('') : ''}
                        ${h.equipos && h.equipos.length ? `
                        <ul class="diag-lista">
                            ${h.equipos.map(e => `
                                <li data-interno="${esc(e.interno)}">
                                    <span class="diag-eq">${esc(e.interno)}<small>${esc(e.denominacion || '')}</small></span>
                                    <span class="diag-val">${esc(e.texto)}<small>${esc(e.sub || '')}</small></span>
                                </li>`).join('')}
                        </ul>` : ''}
                    </div>
                </details>`;
            }).join('')}
        </div>`;

    el.querySelectorAll('.diag-lista li[data-interno]').forEach(li => {
        li.addEventListener('click', () => buscarEquipo(li.dataset.interno));
    });
    el.querySelectorAll('.btn-diag-accion').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); abrirAjusteMetas(ultimoAnalisis, b.dataset.filtro); });
    });
    el.querySelectorAll('details.diag-card[data-id]').forEach(det => {
        det.addEventListener('toggle', () => diagAbiertos.set(det.dataset.id, det.open));
    });
}

function buscarEquipo(interno) {
    const input = document.getElementById('search-equip');
    if (!input) return;
    input.value = interno;
    view.busqueda = interno;
    view.denominacion = 'ALL'; view.estado = 'ALL';
    const fd = document.getElementById('filter-denominacion');
    const fe = document.getElementById('filter-estado');
    if (fd) fd.value = 'ALL';
    if (fe) fe.value = 'ALL';
    const cont = document.getElementById('cards-container');
    if (cont && ultimoAnalisis) renderCards(cont, ultimoAnalisis);
    cont?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- tarjetas

function poblarFiltroDenominacion(filas) {
    const sel = document.getElementById('filter-denominacion');
    if (!sel) return;
    const actual = sel.value || 'ALL';
    const denos = [...new Set(filas.map(f => f.equipo.denominacion).filter(Boolean))].sort();
    sel.innerHTML = '<option value="ALL">Todas las denominaciones</option>' + denos.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    sel.value = (denos.includes(actual) || actual === 'ALL') ? actual : 'ALL';
    poblarSugerenciasBusqueda(filas, denos);
    poblarFiltroProvincia(filas);
    poblarFiltroCombustible(filas);
    poblarFiltrosSpecs(filas);
}

/**
 * Provincia → lugar de carga → centro de costo: tres filtros geográficos/administrativos,
 * cada uno armado con los valores reales del período (no una lista fija), así que solo
 * aparecen las opciones que de verdad tienen equipos o cargas.
 *
 * Lugar de carga y centro de costo son dos ejes distintos y no deben confundirse: el lugar de
 * carga es el sitio FÍSICO donde se cargó (depósito propio o estación de terceros), el centro
 * de costo es la unidad ADMINISTRATIVA que paga esa carga. Un mismo equipo puede repartirse
 * entre varios centros de costo en el mismo período (ej: TR32 carga tanto para CEMENTO como
 * para ÁRIDOS): por eso el filtro no reemplaza el desglose que se ve en cada tarjeta, solo
 * agrupa por el que más se repite.
 */
function poblarFiltroProvincia(filas) {
    const sel = document.getElementById('filter-provincia');
    if (!sel) return;
    const actual = sel.value || 'ALL';
    const provs = [...new Set(filas.map(f => f.ubicacion?.provincia).filter(v => v && v !== 'SIN DATO'))].sort();
    sel.innerHTML = '<option value="ALL">Mendoza y San Juan</option>' + provs.map(p => `<option value="${esc(p)}">${esc(cap(p))}</option>`).join('');
    sel.value = (provs.includes(actual) || actual === 'ALL') ? actual : 'ALL';
    poblarFiltroLugarCarga(filas);
    poblarFiltroCentroCosto(filas);
}

/** Lugar de carga, agrupado en dos optgroups (sede propia / estación de servicio de terceros) para que se note de un vistazo qué tipo de sitio es cada uno. */
function poblarFiltroLugarCarga(filas) {
    const sel = document.getElementById('filter-lugarcarga');
    if (!sel) return;
    const actual = sel.value || 'ALL';
    const base = view.provincia !== 'ALL' ? filas.filter(f => f.ubicacion?.provincia === view.provincia) : filas;
    const porTipo = new Map(); // 'Sede' | 'Estación de servicio' -> Set(lugares)
    base.forEach(f => {
        const l = f.ubicacion?.lugarCarga;
        if (!l) return;
        const t = f.ubicacion.tipoLugarCarga || 'Sede';
        if (!porTipo.has(t)) porTipo.set(t, new Set());
        porTipo.get(t).add(l);
    });
    const grupos = [...porTipo.keys()].sort((a, b) => a === 'Sede' ? -1 : (b === 'Sede' ? 1 : a.localeCompare(b)));

    sel.innerHTML = '<option value="ALL">Todos los lugares de carga</option>' +
        grupos.map(g => `<optgroup label="${esc(g)}">${[...porTipo.get(g)].sort().map(l => `<option value="${esc(l)}">${esc(cap(l))}</option>`).join('')}</optgroup>`).join('');
    const todos = grupos.flatMap(g => [...porTipo.get(g)]);
    sel.value = (todos.includes(actual) || actual === 'ALL') ? actual : 'ALL';
}

/** Centro de costo: la unidad administrativa que paga la carga (PMZA, AMZA, PTY...), mostrada con su nombre legible. */
function poblarFiltroCentroCosto(filas) {
    const sel = document.getElementById('filter-centrocosto');
    if (!sel) return;
    const actual = sel.value || 'ALL';
    const base = view.provincia !== 'ALL' ? filas.filter(f => f.ubicacion?.provincia === view.provincia) : filas;
    const centros = [...new Set(base.map(f => f.ubicacion?.centroCosto).filter(Boolean))].sort();
    sel.innerHTML = '<option value="ALL">Todos los centros de costo</option>' + centros.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    sel.value = (centros.includes(actual) || actual === 'ALL') ? actual : 'ALL';
}

/**
 * Tipo de combustible más cargado por cada equipo (INFINIA DIESEL, X10, QUANTIUM NAFTA...),
 * dato agregado igual que el resto de "de dónde cargó": no es un atributo fijo del equipo.
 * Se agrupa por bandera (YPF / Axion) porque son dos circuitos de compra distintos: YPF es
 * la carga a granel en las sedes propias, Axion son las estaciones de servicio de terceros.
 */
function poblarFiltroCombustible(filas) {
    const sel = document.getElementById('filter-combustible');
    if (!sel) return;
    const actual = sel.value || 'ALL';
    const porBandera = new Map(); // 'YPF' | 'Axion' | 'Sin marca definida' -> Set(combustibles)
    filas.forEach(f => {
        const v = f.ubicacion?.combustible;
        if (!v) return;
        const b = f.ubicacion.bandera || 'Sin marca definida';
        if (!porBandera.has(b)) porBandera.set(b, new Set());
        porBandera.get(b).add(v);
    });
    const orden = { YPF: 0, Axion: 1, 'Sin marca definida': 2 };
    const grupos = [...porBandera.keys()].sort((a, b) => (orden[a] ?? 9) - (orden[b] ?? 9));

    sel.innerHTML = '<option value="ALL">Todos los combustibles</option>' +
        grupos.map(g => `<optgroup label="${esc(g)}">${[...porBandera.get(g)].sort().map(v => `<option value="${esc(v)}">${esc(cap(v))}</option>`).join('')}</optgroup>`).join('');
    const todos = grupos.flatMap(g => [...porBandera.get(g)]);
    sel.value = (todos.includes(actual) || actual === 'ALL') ? actual : 'ALL';
}

/** Año, potencia y capacidad: atributos fijos del padrón (Equipos.xlsx), a diferencia de ubicación/combustible que dependen del período. */
function poblarFiltrosSpecs(filas) {
    const specs = [
        { id: 'filter-anio-equipo', label: 'Todos los años', key: 'anio', ordenNum: true },
        { id: 'filter-potencia', label: 'Todas las potencias', key: 'potencia' },
        { id: 'filter-capacidad', label: 'Todas las capacidades', key: 'capacidad' }
    ];
    specs.forEach(({ id, label, key, ordenNum }) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const actual = sel.value || 'ALL';
        let valores = [...new Set(filas.map(f => f.equipo[key]).filter(v => v !== null && v !== undefined && v !== ''))];
        valores.sort(ordenNum ? (a, b) => b - a : (a, b) => String(a).localeCompare(String(b)));
        sel.innerHTML = `<option value="ALL">${label}</option>` + valores.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
        sel.value = (valores.map(String).includes(actual) || actual === 'ALL') ? actual : 'ALL';
    });
}

const cap = (s) => String(s || '').toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());

/**
 * Sugerencias del buscador (search-equip): se arman con los valores REALES de la flota ya
 * cargada (denominación, interno, dominio, marca) en vez de una lista fija, para que escribir
 * "Mix" sugiera "MIXER" y también los internos de mixer concretos (MX97, MX101...), y lo mismo
 * para cualquier otra denominación, dominio o marca presente en los datos.
 */
function poblarSugerenciasBusqueda(filas, denos) {
    let dl = document.getElementById('equip-suggestions');
    if (!dl) {
        dl = document.createElement('datalist');
        dl.id = 'equip-suggestions';
        document.body.appendChild(dl);
        document.getElementById('search-equip')?.setAttribute('list', 'equip-suggestions');
    }
    const valores = new Set(denos);
    filas.forEach(f => {
        if (f.equipo.interno) valores.add(f.equipo.interno);
        if (f.equipo.dominio) valores.add(f.equipo.dominio);
        if (f.equipo.marca) valores.add(f.equipo.marca);
    });
    dl.innerHTML = [...valores].sort().map(v => `<option value="${esc(v)}">`).join('');
}

function filtrarYOrdenar(filas) {
    let out = filas.slice();
    if (view.busqueda) {
        const q = view.busqueda.toUpperCase();
        out = out.filter(f => [f.equipo.interno, f.equipo.dominio, f.equipo.denominacion, f.equipo.marca, f.equipo.modelo]
            .some(v => (v || '').toUpperCase().includes(q)));
    }
    if (view.denominacion !== 'ALL') out = out.filter(f => f.equipo.denominacion === view.denominacion);
    if (view.provincia !== 'ALL') out = out.filter(f => f.ubicacion?.provincia === view.provincia);
    if (view.lugarCarga !== 'ALL') out = out.filter(f => f.ubicacion?.lugarCarga === view.lugarCarga);
    if (view.centroCosto !== 'ALL') out = out.filter(f => f.ubicacion?.centroCosto === view.centroCosto);
    if (view.combustible !== 'ALL') out = out.filter(f => f.ubicacion?.combustible === view.combustible);
    if (view.anioEquipo !== 'ALL') out = out.filter(f => String(f.equipo.anio ?? '') === view.anioEquipo);
    if (view.potencia !== 'ALL') out = out.filter(f => f.equipo.potencia === view.potencia);
    if (view.capacidad !== 'ALL') out = out.filter(f => f.equipo.capacidad === view.capacidad);
    if (view.estado === 'SOBRE') out = out.filter(f => f.metrics.desvio_pct !== null && f.metrics.desvio_pct > 15);
    else if (view.estado === 'OK') out = out.filter(f => f.metrics.desvio_pct !== null && f.metrics.desvio_pct <= 15);
    else if (view.estado === 'SIN_DATOS') out = out.filter(f => f.metrics.motivo_sin_calculo && f.metrics.tipo_calculo !== 'No Aplica');
    else if (view.estado === 'CON_CONSUMO') out = out.filter(f => f.metrics.consumo_real > 0);
    else if (view.estado === 'SIN_META') out = out.filter(f => !f.confirmed);

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
    if (contador) contador.textContent = `${filas.length} equipos · ${nf(filas.reduce((s, f) => s + f.metrics.total_litros, 0))} L`;

    if (!filas.length) {
        container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-magnifying-glass"></i><h3>Ningún equipo coincide con el filtro</h3></div>`;
        return;
    }

    // Las tarjetas marcadas para comparar pueden salir del filtro actual (ej: se tildó, después
    // se buscó otro equipo); se dejan seleccionadas igual, solo se limpian las que ya no existen
    // en el análisis (equipo eliminado/reimportado).
    const internosValidos = new Set(analisis.filas.map(f => f.equipo.interno));
    [...comparSeleccion].forEach(i => { if (!internosValidos.has(i)) comparSeleccion.delete(i); });

    const maxLitros = Math.max(...filas.map(f => f.metrics.total_litros), 1);
    const precioPromedio = analisis.totales.costo_por_litro || 0;
    const periodo = rangoCorto();
    container.innerHTML = filas.map(f => cardHTML(f, maxLitros, precioPromedio, periodo)).join('');

    container.querySelectorAll('.equip-card').forEach(card => {
        const interno = card.dataset.interno;
        const fila = analisis.filas.find(x => x.equipo.interno === interno);

        card.querySelector('.btn-card-edit')?.addEventListener('click', (e) => {
            e.stopPropagation();
            view.editando = view.editando === interno ? null : interno;
            renderCards(container, analisis);
        });
        card.querySelector('.btn-card-cancel')?.addEventListener('click', (e) => {
            e.stopPropagation(); view.editando = null; renderCards(container, analisis);
        });
        card.querySelector('.btn-card-save')?.addEventListener('click', (e) => {
            e.stopPropagation(); guardarEdicion(interno, card);
        });
        card.querySelector('.btn-sugerir')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const b = e.currentTarget;
            card.querySelector('.edit-meta').value = b.dataset.valor;
            card.querySelector('.edit-unidad').value = b.dataset.unidad;
            b.classList.add('aplicada');
        });
        card.querySelector('.btn-card-detail')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (fila) openUnitModal(fila.equipo, fila.metrics, fila.confirmed, fila.cargas, fila.gps, fila.ubicacion);
        });
        card.querySelector('.btn-card-compare')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (comparSeleccion.has(interno)) comparSeleccion.delete(interno);
            else comparSeleccion.add(interno);
            renderCards(container, analisis);
        });
    });

    renderCompararBar(container, analisis);
}

/**
 * Barra flotante que aparece al marcar equipos para comparar desde las tarjetas (checkbox
 * "Agregar a comparativa" en cada card). Evita tener que abrir el modal y buscar manualmente
 * cada equipo: se tildan 2 o más tarjetas y se abre la comparativa ya armada con esa selección.
 */
function renderCompararBar(container, analisis) {
    let bar = document.getElementById('compare-float-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'compare-float-bar';
        bar.className = 'compare-float-bar';
        document.body.appendChild(bar);
    }
    if (comparSeleccion.size === 0) {
        bar.classList.remove('visible');
        bar.innerHTML = '';
        return;
    }
    const nombres = [...comparSeleccion].join(' · ');
    const listo = comparSeleccion.size >= 2;
    bar.classList.add('visible');
    bar.innerHTML = `
        <span class="compare-bar-info"><i class="fa-solid fa-code-compare"></i> ${comparSeleccion.size} equipo${comparSeleccion.size === 1 ? '' : 's'} para comparar <small>${esc(nombres)}</small></span>
        <div class="compare-bar-actions">
            <button class="btn-secondary btn-sm" id="compare-bar-clear">Limpiar</button>
            <button class="btn-primary btn-sm" id="compare-bar-go" ${listo ? '' : 'disabled'} title="${listo ? '' : 'Marcá al menos 2 equipos'}"><i class="fa-solid fa-magnifying-glass-chart"></i> Ver comparativa</button>
        </div>`;
    bar.querySelector('#compare-bar-clear')?.addEventListener('click', () => {
        comparSeleccion.clear();
        renderCards(container, analisis);
    });
    bar.querySelector('#compare-bar-go')?.addEventListener('click', () => {
        if (!listo) return;
        abrirComparativa(analisis, [...comparSeleccion]);
    });
}

function estadoDe(m, confirmed) {
    if (m.tipo_calculo === 'No Aplica') return { cls: 'neutral', txt: 'Sin motor propio', icon: 'fa-ban' };
    if (m.motivo_sin_calculo) return { cls: 'warn', txt: m.motivo_sin_calculo, icon: 'fa-circle-info' };
    if (!confirmed || !confirmed.valor) return { cls: 'neutral', txt: 'Consumo calculado, falta meta', icon: 'fa-circle-question' };
    const d = m.desvio_pct;
    if (d === null) return { cls: 'neutral', txt: 'Sin comparación', icon: 'fa-circle-question' };
    if (d > 15) return { cls: 'alert', txt: `${nf(d)}% sobre la meta`, icon: 'fa-triangle-exclamation' };
    if (d < -15) return { cls: 'ok', txt: `${nf(Math.abs(d))}% bajo la meta`, icon: 'fa-arrow-down' };
    return { cls: 'ok', txt: 'Dentro de la meta', icon: 'fa-check' };
}

function cardHTML(f, maxLitros, precioPromedio = 0, periodo = 'período seleccionado') {
    const { equipo: eq, metrics: m, confirmed } = f;
    const editando = view.editando === eq.interno;
    const est = estadoDe(m, confirmed);
    const esHora = m.tipo_calculo === 'L/Hora';
    const factor = esHora ? m.total_horas : m.total_km;
    const uf = esHora ? 'hs' : 'km';
    const pctLitros = (m.total_litros / maxLitros) * 100;
    const idc = eq.interno.replace(/[^A-Za-z0-9]/g, '');

    const attrsConsumo = registrarCalculo(`c-${idc}`, {
        titulo: `Consumo de ${eq.interno}${eq.dominio ? ' (' + eq.dominio + ')' : ''}`,
        valor: m.consumo_real > 0 ? `${nf(m.consumo_real, 2)} ${m.tipo_calculo}` : 'No calculable',
        pasos: m.pasos, fuentes: m.fuentes
    });

    // --- Litros + precio, con color/símbolo según cómo se compara contra el precio promedio de la flota en el período ---
    const precioEquipo = m.total_litros > 0 ? m.total_costo / m.total_litros : 0;
    let precioTag = '';
    if (precioEquipo > 0 && precioPromedio > 0) {
        const diffPct = ((precioEquipo / precioPromedio) - 1) * 100;
        const cls = diffPct > 8 ? 'precio-alto' : (diffPct < -8 ? 'precio-bajo' : 'precio-normal');
        const icon = diffPct > 8 ? 'fa-arrow-trend-up' : (diffPct < -8 ? 'fa-arrow-trend-down' : 'fa-minus');
        precioTag = `<span class="stat-precio ${cls}" title="Promedio de la flota: $${nf(precioPromedio)}/L"><i class="fa-solid ${icon}"></i> $${nf(precioEquipo)}/L</span>`;
    }

    // --- Sin GPS pero con litros: cálculo inverso (litros ÷ meta) como actividad estimada ---
    const sinActividad = factor <= 0 && m.total_litros > 0;
    const implicita = sinActividad ? actividadImplicita(f) : null;

    // --- Ralentí, interpretado según el tipo de equipo (un GE quieto está trabajando; un TR quieto, no) ---
    let ralentiTag = '';
    if (m.horas_ralenti > 0) {
        const cat = categoriaRalenti(eq.interno);
        const info = RALENTI_INFO[cat] || RALENTI_INFO.desperdicio;
        const pct = m.total_horas > 0 ? (m.horas_ralenti / m.total_horas * 100) : 0;
        ralentiTag = `<span class="ralenti-tag ${info.clase}" title="${nf(pct)}% del tiempo total · ${info.texto}"><i class="fa-solid ${info.icono}"></i> ${nf(m.horas_ralenti)} hs ralentí · ${info.texto}</span>`;
    }

    // --- De dónde salió cada número: se ve de un vistazo, sin tener que abrir el detalle ---
    const fuenteBadges = [];
    if (m.cantidad_cargas > 0) fuenteBadges.push({ t: 'Cargas de Combustible', corto: 'Cargas', i: 'fa-gas-pump', c: 'fuente-cargas' });
    if (m.cantidad_gps > 0) fuenteBadges.push({ t: 'Resumen de Flota (GPS)', corto: 'GPS', i: 'fa-satellite-dish', c: 'fuente-gps' });
    if (confirmed) fuenteBadges.push({ t: 'Consumos Estimados / meta cargada', corto: 'Meta', i: 'fa-bullseye', c: 'fuente-meta' });
    if (implicita) fuenteBadges.push({ t: 'Cálculo inverso: litros ÷ meta, sin GPS', corto: 'Estimado', i: 'fa-calculator', c: 'fuente-estimado' });
    const fuentesRow = fuenteBadges.length ? `
        <div class="card-fuentes">
            ${fuenteBadges.map(b => `<span class="fuente-tag ${b.c}" title="${esc(b.t)}"><i class="fa-solid ${b.i}"></i> ${esc(b.corto)}</span>`).join('')}
        </div>` : '';

    // --- Provincia / centro de costo, si hay dato. Cuando el equipo reparte entre más de un
    // centro de costo en el período (ej: TR32 entre CEMENTO y ÁRIDOS), se muestra la fracción
    // y el desglose completo en el tooltip en vez de esconder que hay más de uno. ---
    const ubi = f.ubicacion || {};
    const ccBreak = ubi.centroCostoBreakdown || [];
    const ccTotal = ccBreak.reduce((s, c) => s + c.n, 0);
    const ccTooltip = ccBreak.length > 1 ? `Se reparte entre ${ccBreak.length} centros de costo: ${ccBreak.map(c => `${c.valor} (${c.n})`).join(', ')}` : '';
    const ubicacionRow = (ubi.provincia && ubi.provincia !== 'SIN DATO') || ubi.centroCosto ? `
        <div class="card-ubicacion">
            ${ubi.provincia && ubi.provincia !== 'SIN DATO' ? `<span class="badge-ubic"><i class="fa-solid fa-location-dot"></i> ${esc(cap(ubi.provincia))}</span>` : ''}
            ${ubi.centroCosto ? `<span class="badge-ubic ${ccBreak.length > 1 ? 'badge-ubic-split' : ''}" ${ccTooltip ? `title="${esc(ccTooltip)}"` : ''}><i class="fa-solid fa-building"></i> ${esc(ubi.centroCosto)}${ccBreak.length > 1 ? ` (${ccBreak[0].n}/${ccTotal})` : ''}</span>` : ''}
        </div>` : '';

    let barra = '';
    if (m.consumo_real > 0 && confirmed && confirmed.valor > 0) {
        const pct = Math.min((m.consumo_real / confirmed.valor) * 100, 100);
        const color = m.desvio_pct > 15 ? 'var(--accent-red)' : (m.desvio_pct < -15 ? 'var(--accent-cyan)' : 'var(--accent-green)');
        const pasoCalculo = m.pasos.find(p => p.texto.startsWith('Dividir'));
        barra = `
            <div class="meta-bar">
                <div class="meta-bar-track"><div class="meta-bar-fill" style="width:${pct}%; background:${color}"></div></div>
                <div class="meta-bar-legend">
                    <span>Real <strong style="color:${color}">${nf(m.consumo_real, 2)}</strong></span>
                    <span>Meta <strong>${nf(confirmed.valor, 2)}</strong></span>
                </div>
                ${pasoCalculo ? `<div class="calc-inline" ${attrsConsumo}><i class="fa-solid fa-equals"></i> ${esc(pasoCalculo.calculo)} = ${esc(pasoCalculo.resultado)}</div>` : ''}
            </div>`;
    }

    const sug = editando && ultimoAnalisis ? sugerirMeta(f, ultimoAnalisis.filas) : null;

    const cuerpo = editando ? `
        <div class="card-edit">
            <label>Denominación
                <input type="text" class="edit-denominacion" value="${esc(eq.denominacion || '')}" list="denominaciones-list">
            </label>
            <label>Dominio (patente)
                <input type="text" class="edit-dominio" value="${esc(eq.dominio || '')}" placeholder="ej: AF809IC">
            </label>
            <div class="edit-row">
                <label>Meta<input type="number" step="0.01" min="0" class="edit-meta" value="${confirmed ? confirmed.valor : ''}" placeholder="8"></label>
                <label>Se mide por
                    <select class="edit-unidad">
                        <option value="">(sin definir)</option>
                        <option value="L/Hora" ${m.tipo_calculo === 'L/Hora' ? 'selected' : ''}>L/Hora</option>
                        <option value="L/100Km" ${m.tipo_calculo === 'L/100Km' ? 'selected' : ''}>L/100Km</option>
                        <option value="No Aplica" ${m.tipo_calculo === 'No Aplica' ? 'selected' : ''}>No aplica</option>
                    </select>
                </label>
            </div>
            ${sug ? `<button class="btn-sugerir" data-valor="${sug.valor}" data-unidad="${sug.unidad}">
                <span><i class="fa-solid fa-wand-magic-sparkles"></i> Usar sugerencia: <strong>${nf(sug.valor, 2)} ${sug.unidad}</strong></span>
                <small>${esc(sug.base)} · rango real ${nf(sug.minimo, 1)}–${nf(sug.maximo, 1)}</small>
            </button>` : ''}
            <div class="edit-actions">
                <button class="btn-primary btn-card-save"><i class="fa-solid fa-check"></i> Guardar</button>
                <button class="btn-secondary btn-card-cancel">Cancelar</button>
            </div>
        </div>` : `
        <div class="card-periodo"><i class="fa-solid fa-calendar-days"></i> ${esc(periodo)}</div>
        <div class="card-stats">
            <div class="stat stat-litros stat-emphasis">
                <span class="stat-label"><i class="fa-solid fa-gas-pump"></i> Combustible</span>
                <span class="stat-value">${nf(m.total_litros, 1)} <small class="stat-unit">L</small></span>
                ${precioTag}
            </div>
            <div class="stat stat-costo stat-emphasis">
                <span class="stat-label"><i class="fa-solid fa-sack-dollar"></i> Costo</span>
                <span class="stat-value">${money(m.total_costo)}</span>
            </div>
            <div class="stat ${implicita ? 'stat-implicita' : ''}">
                <span class="stat-label">${esHora ? 'Horas' : 'Distancia'}${implicita ? ' <i class="fa-solid fa-calculator" title="Sin GPS: estimado por cálculo inverso"></i>' : ''}</span>
                <span class="stat-value ${implicita ? 'stat-muted' : ''}">${implicita ? '≈ ' + nf(implicita.valor, esHora ? 1 : 0) : nf(factor, esHora ? 1 : 0)} <small class="stat-unit">${uf}</small></span>
                ${implicita ? `<span class="stat-nota">estimado: ${esc(implicita.formula)}</span>` : ''}
            </div>
            <div class="stat stat-clickable" ${attrsConsumo} role="button" tabindex="0">
                <span class="stat-label">Consumo real <i class="fa-solid fa-calculator"></i></span>
                <span class="stat-value ${m.consumo_real > 0 ? 'stat-highlight' : 'stat-muted'}">${m.consumo_real > 0 ? `${nf(m.consumo_real, 2)} <small class="stat-unit">${esc(unidadConsumoLabel(m.tipo_calculo))}</small>` : '—'}</span>
            </div>
        </div>
        ${barra}
        ${ubicacionRow}
        <div class="card-meta-line">
            <span><i class="fa-solid fa-gas-pump"></i> ${m.cantidad_cargas} carga${m.cantidad_cargas === 1 ? '' : 's'}</span>
            ${ubi.lugarCarga ? `<span title="${ubi.tipoLugarCarga ? esc(ubi.tipoLugarCarga) : ''}"><i class="fa-solid ${ubi.tipoLugarCarga === 'Estación de servicio' ? 'fa-charging-station' : 'fa-warehouse'}"></i> ${esc(cap(ubi.lugarCarga))}${ubi.lugarCargaBreakdown && ubi.lugarCargaBreakdown.length > 1 ? ` (${ubi.lugarCargaBreakdown[0].n}/${m.cantidad_cargas})` : ''}</span>` : ''}
            ${ubi.combustible ? `<span title="Combustible más cargado${ubi.bandera ? ` · bandera ${ubi.bandera}` : ''}"><i class="fa-solid fa-droplet"></i> ${ubi.bandera ? `${esc(ubi.bandera)} ` : ''}${esc(cap(ubi.combustible))}</span>` : ''}
            <span><i class="fa-solid fa-satellite-dish"></i> ${m.cantidad_gps} GPS</span>
            ${ralentiTag}
        </div>
        ${fuentesRow}
        <div class="litros-bar"><div class="litros-bar-fill" style="width:${pctLitros}%"></div></div>`;

    const enComparacion = comparSeleccion.has(eq.interno);

    return `
        <div class="equip-card ${editando ? 'editing' : ''} ${enComparacion ? 'card-seleccionada' : ''}" data-interno="${esc(eq.interno)}">
            <div class="card-top">
                <div class="card-ident">
                    <h3>${esc(eq.interno)}</h3>
                    <span class="card-dominio">${eq.dominio ? esc(eq.dominio) : '<em>sin dominio</em>'}</span>
                    <p class="card-deno">${esc(eq.denominacion || 'SIN CLASIFICAR')}</p>
                    <p class="card-modelo">${esc([eq.marca, eq.modelo].filter(Boolean).join(' '))}</p>
                    ${(eq.anio || eq.potencia || eq.capacidad) ? `<p class="card-specs">${[eq.anio, eq.potencia, eq.capacidad].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
                </div>
                <div class="card-actions">
                    <button class="btn-icon btn-card-compare ${enComparacion ? 'active' : ''}" title="${enComparacion ? 'Quitar de la comparativa' : 'Agregar a comparativa'}" aria-pressed="${enComparacion}"><i class="fa-solid ${enComparacion ? 'fa-square-check' : 'fa-code-compare'}"></i></button>
                    <button class="btn-icon btn-card-detail" title="Ver detalle"><i class="fa-solid fa-chart-simple"></i></button>
                    <button class="btn-icon btn-card-edit" title="Editar"><i class="fa-solid ${editando ? 'fa-xmark' : 'fa-pen'}"></i></button>
                </div>
            </div>
            ${cuerpo}
            <div class="card-status status-${est.cls}"><i class="fa-solid ${est.icon}"></i> <span>${esc(est.txt)}</span></div>
        </div>`;
}

async function guardarEdicion(interno, cardEl) {
    const fila = ultimoAnalisis?.filas.find(f => f.equipo.interno === interno);
    if (!fila) return;

    const denominacion = (cardEl.querySelector('.edit-denominacion')?.value || '').toUpperCase().trim();
    const dominio = (cardEl.querySelector('.edit-dominio')?.value || '').toUpperCase().replace(/[\s-]/g, '').trim();
    const metaValor = parseFloat(cardEl.querySelector('.edit-meta')?.value);
    const unidad = cardEl.querySelector('.edit-unidad')?.value || '';

    try {
        const eq = { ...fila.equipo };
        eq.denominacion = denominacion || eq.denominacion;
        eq.dominio = dominio;
        eq.dominio_key = dominio;
        eq.tipo_calculo_manual = unidad || null;
        if (!isNaN(metaValor) && metaValor > 0 && unidad && unidad !== 'No Aplica') {
            eq.meta_valor = metaValor;
            eq.meta_unidad = unidad;
            eq.meta_texto = `${metaValor} ${unidad === 'L/Hora' ? 'L/hora' : 'L/100km'}`;
        }
        // Marcar como corregido a mano para que una reimportación no lo pise.
        eq.editado_manual = [...new Set([...(eq.editado_manual || []), 'denominacion', 'dominio', 'meta_valor', 'meta_unidad', 'meta_texto', 'tipo_calculo_manual'])];
        await updateEquipo(eq);
        view.editando = null;
        await renderPanel();
    } catch (e) {
        console.error('No se pudo guardar el equipo:', e);
        alert('No se pudieron guardar los cambios: ' + e.message);
    }
}

// ---------------------------------------------------------------- controles

export function initPanelControls() {
    const rerender = () => { const c = document.getElementById('cards-container'); if (ultimoAnalisis && c) renderCards(c, ultimoAnalisis); };

    let deb;
    document.getElementById('search-equip')?.addEventListener('input', (e) => {
        clearTimeout(deb);
        deb = setTimeout(() => { view.busqueda = e.target.value.trim(); rerender(); }, 200);
    });
    document.getElementById('filter-denominacion')?.addEventListener('change', e => { view.denominacion = e.target.value; rerender(); });
    document.getElementById('filter-estado')?.addEventListener('change', e => { view.estado = e.target.value; rerender(); });
    document.getElementById('sort-by')?.addEventListener('change', e => { view.orden = e.target.value; rerender(); });
    document.getElementById('filter-provincia')?.addEventListener('change', e => {
        view.provincia = e.target.value; view.lugarCarga = 'ALL'; view.centroCosto = 'ALL';
        if (ultimoAnalisis) { poblarFiltroLugarCarga(ultimoAnalisis.filas); poblarFiltroCentroCosto(ultimoAnalisis.filas); }
        rerender();
    });
    document.getElementById('filter-lugarcarga')?.addEventListener('change', e => { view.lugarCarga = e.target.value; rerender(); });
    document.getElementById('filter-centrocosto')?.addEventListener('change', e => { view.centroCosto = e.target.value; rerender(); });
    document.getElementById('filter-combustible')?.addEventListener('change', e => { view.combustible = e.target.value; rerender(); });
    document.getElementById('filter-anio-equipo')?.addEventListener('change', e => { view.anioEquipo = e.target.value; rerender(); });
    document.getElementById('filter-potencia')?.addEventListener('change', e => { view.potencia = e.target.value; rerender(); });
    document.getElementById('filter-capacidad')?.addEventListener('change', e => { view.capacidad = e.target.value; rerender(); });

    // Los filtros de período cambian el conjunto de datos: hay que recalcular todo.
    document.getElementById('filter-anio')?.addEventListener('change', e => { view.anio = e.target.value; renderPanel(); });
    document.getElementById('filter-mes')?.addEventListener('change', e => { view.mes = e.target.value; renderPanel(); });
    document.getElementById('btn-ajustar-metas')?.addEventListener('click', () => abrirAjusteMetas(ultimoAnalisis, 'todos'));
    document.getElementById('btn-comparar')?.addEventListener('click', () => abrirComparativa(ultimoAnalisis, [...comparSeleccion]));
    document.getElementById('btn-limpiar-periodo')?.addEventListener('click', () => {
        view.anio = ''; view.mes = '';
        const a = document.getElementById('filter-anio'); const m = document.getElementById('filter-mes');
        if (a) a.value = ''; if (m) m.value = '';
        renderPanel();
    });

    if (!document.getElementById('denominaciones-list')) {
        const dl = document.createElement('datalist');
        dl.id = 'denominaciones-list';
        dl.innerHTML = Object.values(TIPO_POR_PREFIJO).map(v => `<option value="${v}">`).join('');
        document.body.appendChild(dl);
    }
}
