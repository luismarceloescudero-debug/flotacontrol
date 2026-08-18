/**
 * Panel unificado: KPIs + diagnóstico + tarjetas, en una sola página.
 *
 * Todo número mostrado acá registra sus pasos de cálculo (ver calcpopover.js): al hacer
 * click en cualquier KPI o métrica de una tarjeta se abre el detalle de cómo se obtuvo.
 */
import { getAllEquipos, getAllRawRecords, getAllEstimados, updateEquipo, editarCampoEquipo } from '../data/database.js';
import { analizarFlota, periodosDisponibles, resumirMovimientosGenericos } from '../data/analyzer.js';
import { generarDiagnostico, sugerirMeta, evolucionMensual, categoriaRalenti, actividadImplicita } from '../data/diagnostico.js';
import { TIPO_POR_PREFIJO, MESES, getBandera } from '../data/normalizer.js';
import { diasHabiles } from '../data/feriados.js';
import { openUnitModal } from './modals.js';
import { abrirAjusteMetas } from './metas.js';
import { abrirComparativa } from './comparativa.js';
import { registrarCalculo, limpiarCalculos } from './calcpopover.js';

const view = {
    busqueda: '', denominacion: 'ALL', estado: 'ALL', orden: 'litros',
    provincia: 'ALL', lugarCarga: 'ALL', centroCosto: 'ALL', combustible: 'ALL',
    anioEquipo: 'ALL', potencia: 'ALL', capacidad: 'ALL',
    anio: '', meses: new Set(), editando: null
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

// Estado de acciones del usuario sobre hallazgos individuales y equipos dentro de hallazgos.
// diagIgnorados: Set de ids de hallazgos completos ignorados ("ignorar" / "ignorar todos").
// diagSeguimiento: Map<hallazgoId, Set<interno>> — equipos marcados para seguimiento en cada hallazgo.
const diagIgnorados = new Set();
const diagSeguimiento = new Map();

const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
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

/**
 * Acciones propuestas por tipo de hallazgo: cada una genera un botón que al hacer click
 * ejecuta algo concreto (abrir la comparativa, navegar a una tarjeta, ajustar metas, etc.).
 * No son genéricas: cada hallazgo conoce su propio siguiente paso.
 */
const ACCIONES_PROPUESTAS = {
    sobreconsumo: [
        { texto: 'Comparar los excedidos entre sí', icono: 'fa-code-compare', accion: 'comparar_excedidos' },
        { texto: 'Revisar metas de estos equipos', icono: 'fa-bullseye', accion: 'ajustar_metas_excedidos' }
    ],
    ahorro: [
        { texto: 'Verificar que no falten cargas', icono: 'fa-magnifying-glass', accion: 'verificar_cargas' }
    ],
    metas: [
        { texto: 'Ajustar metas a consumo real', icono: 'fa-sliders', accion: 'ajustar_metas_raras' }
    ],
    sin_meta: [
        { texto: 'Cargar metas faltantes', icono: 'fa-sliders', accion: 'ajustar_sin_meta' }
    ],
    pares: [
        { texto: 'Comparar peores vs mejores', icono: 'fa-code-compare', accion: 'comparar_pares' }
    ],
    ralenti: [
        { texto: 'Ver detalle de ralentí por equipo', icono: 'fa-chart-simple', accion: 'detalle_ralenti' }
    ],
    ralenti_espera: [
        { texto: 'Comparar espera mes a mes', icono: 'fa-chart-line', accion: 'comparar_espera' }
    ],
    sin_medicion: [
        { texto: 'Cargar metas para estimar actividad', icono: 'fa-bullseye', accion: 'ajustar_sin_medicion' }
    ],
    nofl_vehiculo_sin_interno: [
        { texto: 'Dar de alta en maestro de equipos', icono: 'fa-plus', accion: 'alta_equipo' }
    ],
    nofl_otros: [
        { texto: 'Asignar centro de costo', icono: 'fa-building', accion: 'asignar_cc' }
    ],
    anomalas: [
        { texto: 'Revisar cargas en detalle', icono: 'fa-magnifying-glass-chart', accion: 'revisar_anomalas' }
    ]
};

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
            filtro: { anio: view.anio || null, periodos: [...view.meses] }
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
    const { anios, periodos } = periodosDisponibles(rawRecords);

    // Contar qué meses tienen cargas y cuáles GPS
    const mesesCargas = new Set();
    const mesesGps = new Set();
    rawRecords.forEach(r => {
        const p = r.periodo || (r.fecha ? r.fecha.slice(0, 7) : null);
        if (!p) return;
        if (r.type === 'carga') mesesCargas.add(p);
        else if (r.type === 'gps') mesesGps.add(p);
    });

    const selA = document.getElementById('filter-anio');
    if (selA && selA.options.length !== anios.length + 1) {
        selA.innerHTML = '<option value="">Todos los años</option>' + anios.map(a => `<option value="${a}">${a}</option>`).join('');
        selA.value = view.anio;
    }

    // Auto-seleccionar meses cruzados (cargas + GPS) si el usuario no eligió nada aún
    // y hay meses que se repiten en ambas fuentes.
    if (view.meses.size === 0) {
        const cruzados = periodos.filter(ym => mesesCargas.has(ym) && mesesGps.has(ym));
        if (cruzados.length > 0 && cruzados.length < periodos.length) {
            cruzados.forEach(ym => view.meses.add(ym));
        }
    }

    renderMesesGrid(periodos, mesesCargas, mesesGps);
}

/** Grilla interactiva de meses: cada botón muestra disponibilidad de cargas/GPS y se puede tildar. */
function renderMesesGrid(todosLosPeriodos, mesesCargas, mesesGps) {
    const grid = document.getElementById('periodo-meses-grid');
    if (!grid) return;

    // Si hay un año seleccionado, mostrar solo los 12 meses de ese año. Si no, los periodos disponibles.
    let mesesMostrar;
    if (view.anio) {
        mesesMostrar = [];
        for (let m = 1; m <= 12; m++) {
            const ym = `${view.anio}-${String(m).padStart(2, '0')}`;
            mesesMostrar.push(ym);
        }
    } else {
        mesesMostrar = [...new Set(todosLosPeriodos)].sort();
    }

    if (!mesesMostrar.length) { grid.innerHTML = ''; return; }

    const haySeleccion = view.meses.size > 0;
    const ambos = mesesMostrar.filter(ym => mesesCargas.has(ym) && mesesGps.has(ym));

    let html = '<div class="meses-grid-row">';
    mesesMostrar.forEach(ym => {
        const [a, m] = ym.split('-');
        const mc = parseInt(m, 10);
        const label = view.anio ? MESES_CORTO[mc - 1] : `${MESES_CORTO[mc - 1]} ${a.slice(2)}`;
        const tieneC = mesesCargas.has(ym);
        const tieneG = mesesGps.has(ym);
        const seleccionado = view.meses.has(ym);
        const sinDatos = !tieneC && !tieneG;
        const clases = [
            'mes-toggle',
            seleccionado ? 'mes-activo' : '',
            sinDatos ? 'mes-sin-datos' : '',
            tieneC && tieneG ? 'mes-completo' : '',
            tieneC && !tieneG ? 'mes-solo-cargas' : '',
            !tieneC && tieneG ? 'mes-solo-gps' : ''
        ].filter(Boolean).join(' ');

        const dots = `<span class="mes-dots">${tieneC ? '<i class="dot-c" title="Cargas"></i>' : '<i class="dot-empty"></i>'}${tieneG ? '<i class="dot-g" title="GPS"></i>' : '<i class="dot-empty"></i>'}</span>`;

        html += `<button class="${clases}" data-ym="${ym}" title="${MESES[mc - 1]} ${a}${tieneC ? ' · tiene cargas' : ''}${tieneG ? ' · tiene GPS' : ''}${sinDatos ? ' · sin datos' : ''}">${esc(label)}${dots}</button>`;
    });
    html += '</div>';

    // Acciones rápidas
    html += `<div class="meses-grid-actions">`;
    html += `<button class="btn-meses-action" id="meses-solo-cruzados" title="Seleccionar solo los meses que tienen cargas Y GPS a la vez">${ambos.length} meses cruzados</button>`;
    if (haySeleccion) html += `<button class="btn-meses-action" id="meses-limpiar">Limpiar</button>`;
    html += `</div>`;

    grid.innerHTML = html;

    // Event listeners
    grid.querySelectorAll('.mes-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const ym = btn.dataset.ym;
            if (view.meses.has(ym)) view.meses.delete(ym);
            else view.meses.add(ym);
            renderPanel();
        });
    });
    grid.querySelector('#meses-solo-cruzados')?.addEventListener('click', () => {
        view.meses.clear();
        ambos.forEach(ym => view.meses.add(ym));
        renderPanel();
    });
    grid.querySelector('#meses-limpiar')?.addEventListener('click', () => {
        view.meses.clear();
        renderPanel();
    });
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

/** Etiqueta corta del período elegido ("junio 2026", "Abr–Jun 2026"...), reutilizada en los KPIs y en cada tarjeta. */
function rangoCorto() {
    if (view.meses.size > 0) {
        const sorted = [...view.meses].sort();
        return rangoMeses(sorted);
    }
    if (view.anio) return `año ${view.anio}`;
    return 'período seleccionado';
}

/** Sub-texto del KPI de costo: desglose por tipo de combustible en vez de un promedio global. */
function costoSubPorCombustible(t) {
    const desg = t.combustible_desglose || [];
    if (!desg.length) return `$${nf(t.total_costo)}`;
    if (desg.length === 1) {
        const d = desg[0];
        return `${esc(d.bandera)} ${esc(cap(d.tipo))} · $${nf(d.precio_litro)}/L · ${nf(d.litros)} L`;
    }
    // Múltiples tipos: mostrar cada uno con su precio
    return desg.map(d =>
        `${esc(d.bandera)} $${nf(d.precio_litro)}/L <small>(${nf(d.litros)} L)</small>`
    ).join(' · ');
}

function renderKPIs(el, t, fuentes) {
    let rango;
    if (t.periodo_desde && t.periodo_hasta) rango = `${t.periodo_desde} → ${t.periodo_hasta}`;
    else if (view.meses.size > 0) rango = rangoCorto();
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
            ${kpi({ id: 'kpi-costo', label: 'Costo total', valor: money(t.total_costo), sub: costoSubPorCombustible(t), titulo: 'Costo total del combustible', pasos: t.pasos.costo })}
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

    // Limpiar seguimientos de hallazgos que ya no existen
    diagSeguimiento.forEach((_, id) => { if (!idsNuevos.has(id)) diagSeguimiento.delete(id); });

    const bannerResueltos = resueltos.length ? `
        <div class="diag-resuelto">
            <i class="fa-solid fa-broom"></i>
            <div><strong>${resueltos.length === 1 ? 'Se resolvió' : `Se resolvieron ${resueltos.length}`}</strong> desde el último cambio:
                ${resueltos.map(([, titulo]) => `<span class="diag-resuelto-item">${esc(titulo)}</span>`).join('')}
            </div>
        </div>` : '';

    // Separar: visibles vs ignorados
    const visibles = hallazgos.filter(h => !diagIgnorados.has(h.id));
    const ignorados = hallazgos.filter(h => diagIgnorados.has(h.id));

    if (!visibles.length && !ignorados.length) {
        el.innerHTML = bannerResueltos || (esPrimerCalculo ? '' : `
            <div class="diag-resuelto">
                <i class="fa-solid fa-circle-check"></i>
                <div>Sin hallazgos: no hay nada para revisar con los datos y metas actuales.</div>
            </div>`);
        return;
    }

    const sev = { alta: 'sev-alta', media: 'sev-media', baja: 'sev-baja', ok: 'sev-ok' };
    const txt = { alta: 'Prioridad alta', media: 'Revisar', baja: 'Menor', ok: 'Positivo' };

    const renderHallazgoCard = (h, i, esIgnorado) => {
        const abierto = diagAbiertos.has(h.id) ? diagAbiertos.get(h.id) : (esPrimerCalculo && i === 0 && !esIgnorado);
        const seguidos = diagSeguimiento.get(h.id) || new Set();
        const acciones = ACCIONES_PROPUESTAS[h.id] || [];
        return `
        <details class="diag-card ${sev[h.severidad]} ${esIgnorado ? 'diag-ignorado' : ''}" data-id="${esc(h.id)}" ${abierto ? 'open' : ''}>
            <summary>
                <i class="fa-solid ${h.icono} diag-icon"></i>
                <div class="diag-titulo">
                    <span class="diag-badge">${txt[h.severidad]}</span>
                    <h3>${esc(h.titulo)}</h3>
                    ${esIgnorado ? '<span class="diag-badge-ignorado">Ignorado</span>' : ''}
                    ${seguidos.size ? `<span class="diag-badge-seguimiento"><i class="fa-solid fa-eye"></i> ${seguidos.size} en seguimiento</span>` : ''}
                </div>
                <i class="fa-solid fa-chevron-down diag-chevron"></i>
            </summary>
            <div class="diag-body">
                <p>${h.detalle}</p>
                <div class="diag-acciones-bar">
                    ${h.accion ? `<button class="btn-primary btn-sm btn-diag-accion" data-filtro="${esc(h.accion.filtro)}"><i class="fa-solid fa-sliders"></i> ${esc(h.accion.texto)}</button>` : ''}
                    ${acciones.map(a => `<button class="btn-sm btn-diag-propuesta" data-accion="${esc(a.accion)}" data-hallazgo="${esc(h.id)}"><i class="fa-solid ${a.icono}"></i> ${esc(a.texto)}</button>`).join('')}
                    <span class="diag-acciones-sep"></span>
                    ${esIgnorado
                        ? `<button class="btn-sm btn-diag-restaurar" data-hallazgo="${esc(h.id)}" title="Volver a mostrar este hallazgo"><i class="fa-solid fa-eye"></i> Restaurar</button>`
                        : `<button class="btn-sm btn-diag-ignorar" data-hallazgo="${esc(h.id)}" title="Ocultar este hallazgo hasta que cambien los datos"><i class="fa-solid fa-eye-slash"></i> Ignorar</button>`
                    }
                    ${!esIgnorado && visibles.length > 1 ? `<button class="btn-sm btn-diag-ignorar-todos" title="Ocultar todos los hallazgos"><i class="fa-solid fa-eye-slash"></i> Ignorar todos</button>` : ''}
                </div>
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
                    ${h.equipos.map(e => {
                        const enSeg = seguidos.has(e.interno);
                        return `
                        <li data-interno="${esc(e.interno)}" class="${enSeg ? 'diag-li-seguimiento' : ''}">
                            <span class="diag-eq">${esc(e.interno)}<small>${esc(e.denominacion || '')}</small></span>
                            <span class="diag-val">${esc(e.texto)}<small>${esc(e.sub || '')}</small></span>
                            <button class="btn-xs btn-diag-seguir ${enSeg ? 'active' : ''}" data-hallazgo="${esc(h.id)}" data-interno="${esc(e.interno)}" title="${enSeg ? 'Quitar seguimiento' : 'Marcar para seguimiento'}">
                                <i class="fa-solid ${enSeg ? 'fa-eye-slash' : 'fa-eye'}"></i>
                            </button>
                        </li>`;
                    }).join('')}
                </ul>` : ''}
            </div>
        </details>`;
    };

    el.innerHTML = `
        ${bannerResueltos}
        <div class="diag-head">
            <h2><i class="fa-solid fa-clipboard-check"></i> Diagnóstico automático</h2>
            <span class="diag-sub">${hallazgos.length} hallazgo${hallazgos.length === 1 ? '' : 's'} calculado${hallazgos.length === 1 ? '' : 's'} sobre los datos del período${ignorados.length ? ` · ${ignorados.length} ignorado${ignorados.length === 1 ? '' : 's'}` : ''}</span>
        </div>
        <div class="diag-grid">
            ${visibles.map((h, i) => renderHallazgoCard(h, i, false)).join('')}
        </div>
        ${ignorados.length ? `
        <details class="diag-ignorados-section">
            <summary class="diag-ignorados-toggle">
                <i class="fa-solid fa-eye-slash"></i> ${ignorados.length} hallazgo${ignorados.length === 1 ? '' : 's'} ignorado${ignorados.length === 1 ? '' : 's'}
                <button class="btn-xs btn-diag-restaurar-todos" title="Restaurar todos"><i class="fa-solid fa-eye"></i> Restaurar todos</button>
            </summary>
            <div class="diag-grid">
                ${ignorados.map((h, i) => renderHallazgoCard(h, i, true)).join('')}
            </div>
        </details>` : ''}`;

    // --- Event listeners ---
    el.querySelectorAll('.diag-lista li[data-interno]').forEach(li => {
        li.addEventListener('click', (e) => {
            if (e.target.closest('.btn-diag-seguir')) return; // no navegar si clickeó el botón de seguimiento
            buscarEquipo(li.dataset.interno);
        });
    });
    el.querySelectorAll('.btn-diag-accion').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); abrirAjusteMetas(ultimoAnalisis, b.dataset.filtro); });
    });
    el.querySelectorAll('details.diag-card[data-id]').forEach(det => {
        det.addEventListener('toggle', () => diagAbiertos.set(det.dataset.id, det.open));
    });

    // Botón "Ignorar" individual
    el.querySelectorAll('.btn-diag-ignorar').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            diagIgnorados.add(b.dataset.hallazgo);
            renderDiagnostico(analisis, rawRecords);
        });
    });

    // Botón "Ignorar todos"
    el.querySelectorAll('.btn-diag-ignorar-todos').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            visibles.forEach(h => diagIgnorados.add(h.id));
            renderDiagnostico(analisis, rawRecords);
        });
    });

    // Botón "Restaurar" individual
    el.querySelectorAll('.btn-diag-restaurar').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            diagIgnorados.delete(b.dataset.hallazgo);
            renderDiagnostico(analisis, rawRecords);
        });
    });

    // Botón "Restaurar todos"
    el.querySelectorAll('.btn-diag-restaurar-todos').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            diagIgnorados.clear();
            renderDiagnostico(analisis, rawRecords);
        });
    });

    // Botón "Marcar para seguimiento" por equipo
    el.querySelectorAll('.btn-diag-seguir').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const hid = b.dataset.hallazgo;
            const int = b.dataset.interno;
            if (!diagSeguimiento.has(hid)) diagSeguimiento.set(hid, new Set());
            const s = diagSeguimiento.get(hid);
            if (s.has(int)) s.delete(int); else s.add(int);
            renderDiagnostico(analisis, rawRecords);
        });
    });

    // Acciones propuestas — cada una ejecuta algo concreto
    el.querySelectorAll('.btn-diag-propuesta').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            ejecutarAccionPropuesta(b.dataset.accion, b.dataset.hallazgo, analisis);
        });
    });
}

/** Ejecuta la acción propuesta para un hallazgo: abrir comparativa, ajustar metas, etc. */
function ejecutarAccionPropuesta(accion, hallazgoId, analisis) {
    const h = generarDiagnostico(analisis.filas, analisis.totales, []).find(x => x.id === hallazgoId);
    const internos = h && h.equipos ? h.equipos.map(e => e.interno) : [];

    switch (accion) {
        case 'comparar_excedidos':
        case 'comparar_pares':
        case 'comparar_espera':
            if (internos.length >= 2) abrirComparativa(analisis, internos.slice(0, 8));
            break;
        case 'ajustar_metas_excedidos':
        case 'ajustar_metas_raras':
            abrirAjusteMetas(ultimoAnalisis, hallazgoId === 'sobreconsumo' ? 'excedidos' : 'metas_raras');
            break;
        case 'ajustar_sin_meta':
        case 'ajustar_sin_medicion':
            abrirAjusteMetas(ultimoAnalisis, 'sin_meta');
            break;
        case 'verificar_cargas':
        case 'revisar_anomalas':
        case 'detalle_ralenti':
            if (internos.length) buscarEquipo(internos[0]);
            break;
        case 'alta_equipo':
        case 'asignar_cc':
            // Futuro: abrir modal de alta de equipo o asignación de centro de costo
            if (internos.length) buscarEquipo(internos[0]);
            break;
        default:
            if (internos.length) buscarEquipo(internos[0]);
    }
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

/** Capitaliza cada palabra, pero preserva siglas de marca conocidas (YPF, GNC, EE SS, GLP, CNG). */
const BRAND_KEEP = ['YPF', 'GNC', 'GLP', 'CNG'];
const cap = (s) => {
    let r = String(s || '').toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
    BRAND_KEEP.forEach(b => { r = r.replace(new RegExp(`\\b${b}\\b`, 'gi'), b); });
    // "Ee Ss" → "EE SS"
    r = r.replace(/\bEe\s+Ss\b/g, 'EE SS');
    return r;
};

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
    // Mapa de precio por tipo de combustible para comparar el equipo contra su mismo tipo
    const preciosPorTipo = new Map();
    (analisis.totales.combustible_desglose || []).forEach(d => { if (d.precio_litro > 0) preciosPorTipo.set(d.tipo, d.precio_litro); });
    const periodo = rangoCorto();
    container.innerHTML = filas.map(f => {
        try {
            return cardHTML(f, maxLitros, precioPromedio, periodo, preciosPorTipo);
        } catch (e) {
            console.error(`Error renderizando tarjeta de ${f.equipo?.interno}:`, e);
            return `<div class="equip-card card-error" data-interno="${esc(f.equipo?.interno || '?')}">
                <div class="card-top"><div class="card-ident"><h3>${esc(f.equipo?.interno || '?')}</h3>
                <p style="color:var(--accent-red)"><i class="fa-solid fa-triangle-exclamation"></i> Error al renderizar: ${esc(e.message)}</p></div></div></div>`;
        }
    }).join('');

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

/** Rango de meses compacto: "Abr–Jun 2026" o "Abr 2026" si es uno solo. */
function rangoMeses(meses) {
    if (!meses.length) return '';
    const fmt = (ym) => {
        const [a, m] = ym.split('-');
        return MESES_CORTO[parseInt(m, 10) - 1] + ' ' + a;
    };
    const fmtCorto = (ym) => MESES_CORTO[parseInt(ym.split('-')[1], 10) - 1];
    if (meses.length === 1) return fmt(meses[0]);
    const mismoAnio = meses[0].slice(0, 4) === meses[meses.length - 1].slice(0, 4);
    return mismoAnio
        ? fmtCorto(meses[0]) + '–' + fmt(meses[meses.length - 1])
        : fmt(meses[0]) + '–' + fmt(meses[meses.length - 1]);
}

/** Meta-line de la tarjeta: cargas, GPS, períodos, días hábiles, combustible. */
function cardPeriodoInfo(f, m, ubi, ralentiTag) {
    const fechasC = f.cargas.map(c => c.fecha).filter(Boolean).sort();
    const fechasG = f.gps.map(g => g.fecha).filter(Boolean).sort();
    const mesesC = [...new Set(fechasC.map(x => x.slice(0, 7)))].sort();
    const mesesG = [...new Set(fechasG.map(x => x.slice(0, 7)))].sort();
    const rangoC = rangoMeses(mesesC);
    const rangoG = rangoMeses(mesesG);

    // Días hábiles del período de este equipo (unión de cargas + GPS)
    const todasFechas = [...fechasC, ...fechasG].sort();
    let dhTag = '';
    if (todasFechas.length >= 2) {
        const dh = diasHabiles(todasFechas[0], todasFechas[todasFechas.length - 1]);
        if (dh && dh.totalCorridos > 0) {
            dhTag = `<span title="${dh.dias} hábiles de ${dh.totalCorridos} corridos${dh.completo ? '' : ' (sin feriados móviles confirmados)'}"><i class="fa-solid fa-calendar-days"></i> ${dh.dias} días hábiles</span>`;
        }
    }

    // Alerta si cargas y GPS cubren meses distintos
    const mesesSoloC = mesesC.filter(m => !mesesG.includes(m));
    const mesesSoloG = mesesG.filter(m => !mesesC.includes(m));
    let desalineado = '';
    if (mesesC.length && mesesG.length && (mesesSoloC.length || mesesSoloG.length)) {
        const partes = [];
        if (mesesSoloC.length) partes.push(`cargas sin GPS: ${mesesSoloC.map(m => MESES_CORTO[parseInt(m.slice(5), 10) - 1]).join(', ')}`);
        if (mesesSoloG.length) partes.push(`GPS sin cargas: ${mesesSoloG.map(m => MESES_CORTO[parseInt(m.slice(5), 10) - 1]).join(', ')}`);
        desalineado = `<span class="meta-periodo-warn" title="Los períodos de cargas y GPS no coinciden al 100%: ${esc(partes.join('; '))}"><i class="fa-solid fa-triangle-exclamation"></i> períodos desalineados</span>`;
    }

    // Tooltip detallado para cargas
    const tooltipC = mesesC.length ? `${m.cantidad_cargas} cargas en ${mesesC.length} mes${mesesC.length > 1 ? 'es' : ''}: ${mesesC.map(m => MESES_CORTO[parseInt(m.slice(5), 10) - 1] + ' ' + m.slice(0, 4)).join(', ')}` : '';
    // Tooltip detallado para GPS
    const tooltipG = mesesG.length ? `${m.cantidad_gps} reportes de Resumen de Flota en ${mesesG.length} mes${mesesG.length > 1 ? 'es' : ''}: ${mesesG.map(m => MESES_CORTO[parseInt(m.slice(5), 10) - 1] + ' ' + m.slice(0, 4)).join(', ')}` : '';

    return `
        <div class="card-meta-line">
            <span title="${esc(tooltipC)}"><i class="fa-solid fa-gas-pump"></i> ${m.cantidad_cargas} carga${m.cantidad_cargas === 1 ? '' : 's'}${rangoC ? ` · ${esc(rangoC)}` : ''}</span>
            <span title="${esc(tooltipG)}"><i class="fa-solid fa-satellite-dish"></i> ${m.cantidad_gps} reporte${m.cantidad_gps === 1 ? '' : 's'} GPS${rangoG ? ` · ${esc(rangoG)}` : ''}</span>
            ${dhTag}
            ${desalineado}
            ${ralentiTag}
        </div>`;
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

function cardHTML(f, maxLitros, precioPromedio = 0, periodo = 'período seleccionado', preciosPorTipo = new Map()) {
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

    // --- Litros + precio: compara contra el precio de la flota para el MISMO tipo de combustible ---
    const precioEquipo = m.total_litros > 0 ? m.total_costo / m.total_litros : 0;
    const ubi = f.ubicacion || {};
    const precioRef = (ubi.combustible && preciosPorTipo.get(ubi.combustible)) || precioPromedio;
    let precioTag = '';
    if (precioEquipo > 0 && precioRef > 0) {
        const diffPct = ((precioEquipo / precioRef) - 1) * 100;
        const cls = diffPct > 8 ? 'precio-alto' : (diffPct < -8 ? 'precio-bajo' : 'precio-normal');
        const icon = diffPct > 8 ? 'fa-arrow-trend-up' : (diffPct < -8 ? 'fa-arrow-trend-down' : 'fa-minus');
        const refLabel = (ubi.combustible && preciosPorTipo.has(ubi.combustible))
            ? `Promedio ${ubi.combustible}: $${nf(precioRef)}/L`
            : `Promedio general: $${nf(precioRef)}/L`;
        precioTag = `<span class="stat-precio ${cls}" title="${esc(refLabel)}"><i class="fa-solid ${icon}"></i> $${nf(precioEquipo)}/L</span>`;
    }

    // --- Combustible hero: desglose por tipo cuando hay más de uno ---
    const combBreak = ubi.combustibleBreakdown || [];
    let combustibleHero = '';
    if (combBreak.length > 1) {
        // Calcular litros y precio por cada tipo de combustible del equipo
        const porTipo = new Map();
        f.cargas.forEach(c => {
            const t = c.combustible || 'Sin dato';
            if (!porTipo.has(t)) porTipo.set(t, { litros: 0, costo: 0 });
            const b = porTipo.get(t);
            b.litros += parseFloat(c.litros) || 0;
            b.costo += parseFloat(c.importe) || 0;
        });
        combustibleHero = `<div class="card-combustible-hero card-combustible-multi">${
            combBreak.map(cb => {
                const d = porTipo.get(cb.valor) || { litros: 0, costo: 0 };
                const pl = d.litros > 0 ? d.costo / d.litros : 0;
                const ban = getBandera(cb.valor) || '';
                return `<div class="combustible-row">
                    ${ban ? `<span class="combustible-bandera">${esc(ban)}</span>` : ''}
                    <span class="combustible-tipo">${esc(cap(cb.valor))}</span>
                    <span class="combustible-litros">${nf(d.litros, 0)} L</span>
                    ${pl > 0 ? `<span class="combustible-precio">$${nf(pl)}/L</span>` : ''}
                </div>`;
            }).join('')
        }</div>`;
    } else if (ubi.combustible) {
        combustibleHero = `<div class="card-combustible-hero">
            <span class="combustible-bandera">${ubi.bandera ? esc(ubi.bandera) : ''}</span>
            <span class="combustible-tipo">${esc(cap(ubi.combustible))}</span>
            ${precioEquipo > 0 ? `<span class="combustible-precio">$${nf(precioEquipo)}/L</span>` : ''}
            ${precioTag}
        </div>`;
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

    // --- Provincia / centro de costo: si hay más de uno, mostrar cada uno en su propia línea ---
    const ccBreak = ubi.centroCostoBreakdown || [];
    const ccTotal = ccBreak.reduce((s, c) => s + c.n, 0);
    const ccLines = ccBreak.length > 1
        ? ccBreak.map(c => `<span class="badge-ubic badge-ubic-split" title="${c.n} de ${ccTotal} cargas"><i class="fa-solid fa-building"></i> ${esc(c.valor)} <small>(${c.n})</small></span>`).join('')
        : (ubi.centroCosto ? `<span class="badge-ubic"><i class="fa-solid fa-building"></i> ${esc(ubi.centroCosto)}</span>` : '');
    // Lugares de carga: si hay más de uno, mostrar cada uno
    const lcBreak = ubi.lugarCargaBreakdown || [];
    const lcLines = lcBreak.length > 1
        ? lcBreak.map(l => `<span class="badge-ubic badge-ubic-lc" title="${l.n} cargas"><i class="fa-solid ${ubi.tipoLugarCarga === 'Estación de servicio' ? 'fa-charging-station' : 'fa-warehouse'}"></i> ${esc(cap(l.valor))} <small>(${l.n})</small></span>`).join('')
        : '';
    const ubicacionRow = (ubi.provincia && ubi.provincia !== 'SIN DATO') || ccLines ? `
        <div class="card-ubicacion">
            ${ubi.provincia && ubi.provincia !== 'SIN DATO' ? `<span class="badge-ubic"><i class="fa-solid fa-location-dot"></i> ${esc(cap(ubi.provincia))}</span>` : ''}
            ${ccLines}
            ${lcLines}
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
        ${combustibleHero}
        <div class="card-stats">
            <div class="stat stat-litros stat-emphasis">
                <span class="stat-label"><i class="fa-solid fa-gas-pump"></i> Litros</span>
                <span class="stat-value">${nf(m.total_litros, 1)} <small class="stat-unit">L</small></span>
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
        ${m.cross_check ? `<div class="card-cross-check" title="El GPS reporta horas y km para este equipo. Verificá que el tipo de cálculo sea el correcto.">
            <i class="fa-solid fa-arrows-left-right"></i>
            <span>También se podría medir como <strong>${nf(m.cross_check.consumo_alt, 2)} ${esc(m.cross_check.tipo_alt)}</strong></span>
            <small>(tiene ${nf(m.total_horas, 1)} hs y ${nf(m.total_km)} km)</small>
        </div>` : ''}
        ${confirmed ? `<div class="card-meta-hero">
            <span class="meta-label"><i class="fa-solid fa-bullseye"></i> Meta ${confirmed.source === 'Maestro' ? '(ajustada)' : '(estimada)'}</span>
            <span class="meta-valor">${nf(confirmed.valor, 2)} <small>${esc(unidadConsumoLabel(confirmed.unidad || m.tipo_calculo))}</small></span>
            ${m.desvio_pct !== null ? `<span class="meta-desvio ${m.desvio_pct > 15 ? 'desvio-alto' : (m.desvio_pct < -15 ? 'desvio-bajo' : 'desvio-ok')}">${m.desvio_pct >= 0 ? '+' : ''}${nf(m.desvio_pct)}%</span>` : ''}
        </div>` : (m.consumo_real > 0 ? `<div class="card-meta-hero card-meta-falta"><span class="meta-label"><i class="fa-solid fa-circle-question"></i> Sin meta cargada</span></div>` : '')}
        ${barra}
        ${ubicacionRow}
        ${cardPeriodoInfo(f, m, ubi, ralentiTag)}
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
    document.getElementById('filter-anio')?.addEventListener('change', e => { view.anio = e.target.value; view.meses.clear(); renderPanel(); });
    document.getElementById('btn-ajustar-metas')?.addEventListener('click', () => abrirAjusteMetas(ultimoAnalisis, 'todos'));
    document.getElementById('btn-comparar')?.addEventListener('click', () => abrirComparativa(ultimoAnalisis, [...comparSeleccion]));
    document.getElementById('btn-limpiar-periodo')?.addEventListener('click', () => {
        view.anio = ''; view.meses.clear();
        const a = document.getElementById('filter-anio');
        if (a) a.value = '';
        renderPanel();
    });

    if (!document.getElementById('denominaciones-list')) {
        const dl = document.createElement('datalist');
        dl.id = 'denominaciones-list';
        dl.innerHTML = Object.values(TIPO_POR_PREFIJO).map(v => `<option value="${v}">`).join('');
        document.body.appendChild(dl);
    }
}
