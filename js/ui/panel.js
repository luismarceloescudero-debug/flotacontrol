/**
 * Panel unificado: KPIs + diagnóstico + tarjetas, en una sola página.
 *
 * Todo número mostrado acá registra sus pasos de cálculo (ver calcpopover.js): al hacer
 * click en cualquier KPI o métrica de una tarjeta se abre el detalle de cómo se obtuvo.
 */
import { getAllEquipos, getAllRawRecords, getAllEstimados, updateEquipo, editarCampoEquipo, getRalentiEstados, setRalentiEstado, quitarRalentiEstado, crearReclamoGPS, getReclamosGPS, actualizarReclamoGPS, getNoFlotaAceptados, setNoFlotaAceptado, quitarNoFlotaAceptado } from '../data/database.js';
import { analizarFlota, periodosDisponibles, resumirMovimientosGenericos } from '../data/analyzer.js';
import { generarDiagnostico, sugerirMeta, evolucionMensual, categoriaRalenti, actividadImplicita, coberturaEquipo, completitudDatos, mesesFueraDeServicio, causaMetaRara, estimacionCreible, NIVELES_COMPLETITUD } from '../data/diagnostico.js';
import { TIPO_POR_PREFIJO, MESES, getBandera, tipoLugarCarga, formatFechaAR } from '../data/normalizer.js';
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
// Estados persistentes de ralentí (aceptable/seguimiento) por interno — se recargan al abrir
// el panel y cada vez que se marca/desmarca uno, para que generarDiagnostico() los use.
let ralentiEstadosCache = [];
// Códigos de "consumo fuera de la flota" (vehículo con patente sin interno, planta, otros)
// marcados como "así está bien" — mismo patrón que ralentiEstadosCache.
let noFlotaAceptadosCache = [];

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

/** Rango de fechas efectivamente analizado (el mismo que ya se muestra en el KPI de período). */
const periodoDeAnalisis = (analisis) => ({ desde: analisis?.totales?.periodo_desde, hasta: analisis?.totales?.periodo_hasta });

/**
 * Punto de entrada para la vista "Seguimiento" (js/ui/seguimiento.js): expone el último
 * análisis + diagnóstico ya calculado para que esa vista arme su propia lista de "para
 * revisar" sin volver a analizar la flota desde cero ni duplicar las reglas de negocio que
 * ya viven en generarDiagnostico(). Devuelve null si todavía no se procesó ningún dato.
 */
export function datosParaSeguimiento() {
    if (!ultimoAnalisis) return null;
    const rawRecords = datosCrudos?.rawRecords || [];
    const hallazgos = generarDiagnostico(ultimoAnalisis.filas, ultimoAnalisis.totales, rawRecords, ralentiEstadosCache, noFlotaAceptadosCache);
    return { analisis: ultimoAnalisis, rawRecords, hallazgos };
}

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
        { texto: 'Ajustar metas a consumo real', icono: 'fa-sliders', accion: 'ajustar_metas_raras' },
        { texto: 'Chequear período fuera de servicio', icono: 'fa-calendar-xmark', accion: 'chequear_fuera_servicio' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    sin_meta: [
        { texto: 'Cargar metas faltantes', icono: 'fa-sliders', accion: 'ajustar_sin_meta' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    estimacion_inverosimil: [
        { texto: 'Investigar estas estimaciones', icono: 'fa-magnifying-glass-chart', accion: 'revisar_estimaciones' },
        { texto: 'Chequear período fuera de servicio', icono: 'fa-calendar-xmark', accion: 'chequear_fuera_servicio' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    sin_gps_estimado: [
        { texto: 'Revisar las estimaciones', icono: 'fa-magnifying-glass-chart', accion: 'revisar_estimaciones' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    cargas_exceden_dias_habiles: [
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    pares: [
        { texto: 'Comparar peores vs mejores', icono: 'fa-code-compare', accion: 'comparar_pares' }
    ],
    ralenti: [
        { texto: 'Ver detalle de ralentí por equipo', icono: 'fa-chart-simple', accion: 'detalle_ralenti' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    ralenti_camionetas: [
        { texto: 'Ver detalle de ralentí por equipo', icono: 'fa-chart-simple', accion: 'detalle_ralenti' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    ralenti_espera: [
        { texto: 'Comparar espera mes a mes', icono: 'fa-chart-line', accion: 'comparar_espera' }
    ],
    sin_medicion: [
        { texto: 'Cargar metas para estimar actividad', icono: 'fa-bullseye', accion: 'ajustar_sin_medicion' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    nofl_vehiculo_sin_interno: [
        { texto: 'Dar de alta en maestro de equipos', icono: 'fa-plus', accion: 'alta_equipo' }
    ],
    nofl_otros: [
        { texto: 'Asignar centro de costo', icono: 'fa-building', accion: 'asignar_cc' }
    ],
    anomalas: [
        { texto: 'Revisar cargas en detalle', icono: 'fa-magnifying-glass-chart', accion: 'revisar_anomalas' }
    ],
    sin_cc: [
        { texto: 'Asignar centro de costo', icono: 'fa-building', accion: 'asignar_cc' },
        { texto: 'Ver en tabla de cargas', icono: 'fa-table-list', accion: 'ver_cargas' }
    ],
    huerfanos_gps: [
        { texto: 'Dar de alta en maestro', icono: 'fa-plus', accion: 'alta_equipo' },
        { texto: 'Ver registros GPS huérfanos', icono: 'fa-satellite-dish', accion: 'ver_gps' }
    ],
    cargas_error: [
        { texto: 'Revisar cargas con errores', icono: 'fa-triangle-exclamation', accion: 'revisar_anomalas' },
        { texto: 'Ver en tabla de cargas', icono: 'fa-table-list', accion: 'ver_cargas' }
    ]
};

export async function renderPanel() {
    const kpiEl = document.getElementById('panel-kpis');
    const cardsEl = document.getElementById('cards-container');
    if (!kpiEl || !cardsEl) return;

    kpiEl.innerHTML = '<p style="color:var(--text-muted)">Analizando datos...</p>';

    try {
        const [equipos, rawRecords, estimados, ralentiEstados, noFlotaAceptados] = await Promise.all([
            getAllEquipos(), getAllRawRecords(), getAllEstimados(), getRalentiEstados(), getNoFlotaAceptados()
        ]);
        datosCrudos = { equipos, rawRecords, estimados };
        ralentiEstadosCache = ralentiEstados;
        noFlotaAceptadosCache = noFlotaAceptados;

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
        // Exponer para que datatable.js pueda abrir el modal de metas sin importar directamente
        window.ultimoAnalisis = ultimoAnalisis;
        window.abrirAjusteMetasDesdeTabla = (filtro) => abrirAjusteMetas(ultimoAnalisis, filtro);

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

    // Acciones rápidas. "Últimos N meses" tiene que dar meses REALMENTE completos y
    // comparables: no alcanza con que el mes tenga algún dato (una sola carga del 1° de
    // agosto ya lo metía en la lista), hacen falta las DOS fuentes (cargas Y GPS) — que es
    // justamente la señal de que el mes ya se cerró y se terminó de cargar todo. Por eso la
    // base ya no es "todos los períodos que aparecen en algún lado" sino los mismos
    // "cruzados" que usa el botón de al lado, sin importar el filtro de año activo. Además se
    // excluye el mes calendario en curso (hoy), que por definición todavía no puede estar
    // completo aunque ya tenga alguna carga cargada.
    const periodosReales = [...new Set(todosLosPeriodos)].sort();
    const hoyYM = new Date().toISOString().slice(0, 7);
    const cruzadosReales = periodosReales.filter(ym => mesesCargas.has(ym) && mesesGps.has(ym) && ym !== hoyYM);
    html += `<div class="meses-grid-actions">`;
    html += `<button class="btn-meses-action" id="meses-solo-cruzados" title="Seleccionar solo los meses que tienen cargas Y GPS a la vez">${ambos.length} meses cruzados</button>`;
    [3, 6, 12].filter(n => cruzadosReales.length > n).forEach(n => {
        html += `<button class="btn-meses-action" data-ultimos="${n}" title="Seleccionar los últimos ${n} meses ya cerrados y con cargas Y GPS a la vez (meses completos y comparables entre sí)">Últimos ${n} meses</button>`;
    });
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
    grid.querySelectorAll('[data-ultimos]').forEach(btn => {
        btn.addEventListener('click', () => {
            const n = parseInt(btn.dataset.ultimos, 10);
            view.meses.clear();
            cruzadosReales.slice(-n).forEach(ym => view.meses.add(ym));
            renderPanel();
        });
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

/**
 * Registra el detalle de una sugerencia de meta (sugerirMeta, ver diagnostico.js) para que se
 * pueda abrir con el mismo mecanismo de "ver cálculo" del resto de la app: qué equipos entraron
 * en la mediana y cuánto midió cada uno, no solo el número final. Devuelve los atributos HTML
 * para el botón que abre ese detalle (separado del botón "Usar sugerencia": ese aplica el
 * valor, este solo lo explica — no pueden ser el mismo elemento o un click en uno dispara el
 * otro por el listener por delegación de calcpopover.js).
 */
function registrarSugerenciaCalculo(interno, sug) {
    return registrarCalculo(`sugerencia-${interno}`, {
        titulo: `De dónde sale la sugerencia para ${interno}`,
        valor: `${nf(sug.valor, 2)} ${sug.unidad}`,
        nota: sug.base,
        pasos: sug.pares.map(p => ({
            texto: `${p.interno}`,
            calculo: `${p.cargas} carga${p.cargas === 1 ? '' : 's'}`,
            resultado: `${nf(p.valor, 2)} ${sug.unidad}`
        }))
    });
}

// ---------------------------------------------------------------- KPIs

function kpi({ id, label, valor, sub, clase, titulo, pasos, fuentes, nota, acciones }) {
    const attrs = registrarCalculo(id, { titulo: titulo || label, valor, pasos, fuentes, nota, acciones });
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

/**
 * Zoom multi-nivel de los KPIs agregados (litros, costo, km, horas): del total de la flota se
 * baja a "cuánto aportó cada equipo" y de ahí a "qué movimientos concretos de ESE equipo forman
 * ese número" — cargas de combustible o registros GPS, según qué campo se está mirando. Cada
 * nivel usa `ultimoAnalisis.filas`, el mismo array ya calculado que alimenta las tarjetas.
 */
function nivelPorEquipo({ campo, tituloBase, etiquetaValor, formatear, fuenteTipo }) {
    const filas = (ultimoAnalisis?.filas || [])
        .filter(f => (f.metrics[campo] || 0) > 0)
        .sort((a, b) => (b.metrics[campo] || 0) - (a.metrics[campo] || 0));
    const total = filas.reduce((s, f) => s + (f.metrics[campo] || 0), 0);
    return {
        titulo: `${tituloBase} por equipo`,
        valor: `${filas.length} equipo${filas.length === 1 ? '' : 's'}`,
        nota: `Ordenados de mayor a menor aporte a ${etiquetaValor}. Hacé clic en un equipo para ver el detalle de sus ${fuenteTipo === 'carga' ? 'cargas de combustible' : 'registros GPS'} en este período.`,
        pasos: filas.map(f => ({
            texto: `${f.equipo.interno} — ${f.equipo.denominacion || 'sin denominación'}`,
            resultado: `${formatear(f.metrics[campo])}${total > 0 ? ` · ${nf((f.metrics[campo] / total) * 100, 1)}%` : ''}`,
            zoom: () => fuenteTipo === 'carga' ? nivelCargasEquipo(f.equipo.interno) : nivelGpsEquipo(f.equipo.interno)
        }))
    };
}

/** Nivel terminal: las cargas de combustible concretas de un equipo (fecha, litros, importe, lugar, CC). */
function nivelCargasEquipo(interno) {
    const fila = (ultimoAnalisis?.filas || []).find(f => f.equipo.interno === interno);
    const cargas = (fila?.cargas || []).slice().sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    const totalLitros = cargas.reduce((s, c) => s + (parseFloat(c.litros) || 0), 0);
    const totalImporte = cargas.reduce((s, c) => s + (parseFloat(c.importe) || 0), 0);
    const MOSTRAR = 30;
    return {
        titulo: `Cargas de ${interno}`,
        valor: `${nf(totalLitros, 2)} L · ${money(totalImporte)}`,
        nota: cargas.length > MOSTRAR ? `Mostrando las ${MOSTRAR} más recientes de ${cargas.length} cargas del período.` : `${cargas.length} carga${cargas.length === 1 ? '' : 's'} en el período analizado.`,
        pasos: cargas.slice(0, MOSTRAR).map(c => ({
            texto: `${formatFechaAR(c.fecha)} · ${c.lugar_carga || 'sin lugar'} · ${c.centro_costo || 'sin CC'}`,
            resultado: `${nf(parseFloat(c.litros) || 0, 2)} L · $${nf(parseFloat(c.importe) || 0)}`
        })),
        acciones: [
            { texto: 'Ver todas las cargas de este equipo en la tabla', icono: 'fa-table-list', primaria: true, onClick: () => window.abrirTablaConBusqueda?.('carga', interno) }
        ]
    };
}

/** Nivel terminal: los registros GPS concretos de un equipo (fecha, km, horas de movimiento/ralentí). */
function nivelGpsEquipo(interno) {
    const fila = (ultimoAnalisis?.filas || []).find(f => f.equipo.interno === interno);
    const gps = (fila?.gps || []).slice().sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    const totalKm = gps.reduce((s, g) => s + (parseFloat(g.distancia) || 0), 0);
    const totalHoras = gps.reduce((s, g) => s + ((g.horas && typeof g.horas === 'object' ? g.horas.total : parseFloat(g.horas)) || 0), 0);
    const MOSTRAR = 30;
    return {
        titulo: `Registros GPS de ${interno}`,
        valor: `${nf(totalKm)} km · ${nf(totalHoras, 1)} hs`,
        nota: gps.length > MOSTRAR ? `Mostrando los ${MOSTRAR} más recientes de ${gps.length} registros del período.` : `${gps.length} registro${gps.length === 1 ? '' : 's'} en el período analizado.`,
        pasos: gps.slice(0, MOSTRAR).map(g => {
            const h = (g.horas && typeof g.horas === 'object') ? g.horas : { ralenti: 0, movimiento: parseFloat(g.horas) || 0, total: parseFloat(g.horas) || 0 };
            return {
                texto: `${formatFechaAR(g.fecha)} → ${formatFechaAR(g.fecha_hasta)}`,
                resultado: `${nf(parseFloat(g.distancia) || 0)} km · ${nf(h.total, 1)} hs (${nf(h.ralenti, 1)} ralentí)`
            };
        }),
        acciones: [
            { texto: 'Ver todos los registros GPS de este equipo en la tabla', icono: 'fa-table-list', primaria: true, onClick: () => window.abrirTablaConBusqueda?.('gps', interno) }
        ]
    };
}

/** Zoom del KPI "Sobre la meta": lista de equipos excedidos → detalle de meta vs. consumo real de cada uno (terminal). */
function nivelEquiposSobreMeta() {
    const filas = (ultimoAnalisis?.filas || [])
        .filter(f => f.metrics.desvio_pct !== null && f.metrics.desvio_pct > 15)
        .sort((a, b) => (b.metrics.desvio_pct || 0) - (a.metrics.desvio_pct || 0));
    return {
        titulo: 'Equipos sobre la meta',
        valor: `${filas.length} equipo${filas.length === 1 ? '' : 's'}`,
        nota: 'Ordenados de mayor a menor desvío. Hacé clic en un equipo para ver meta vs. consumo real.',
        pasos: filas.map(f => ({
            texto: `${f.equipo.interno} — ${f.equipo.denominacion || 'sin denominación'}`,
            resultado: f.metrics.desvio_pct !== null ? `+${nf(f.metrics.desvio_pct, 1)}%` : 'sin dato',
            zoom: () => nivelDetalleMetaEquipo(f.equipo.interno)
        }))
    };
}

function nivelDetalleMetaEquipo(interno) {
    const fila = (ultimoAnalisis?.filas || []).find(f => f.equipo.interno === interno);
    if (!fila) return null;
    const m = fila.metrics;
    const unidad = unidadConsumoLabel(m.tipo_calculo);
    return {
        titulo: `Meta vs. consumo de ${interno}`,
        valor: m.desvio_pct !== null ? `+${nf(m.desvio_pct, 1)}%` : 'sin desvío calculable',
        pasos: [
            { texto: 'Meta cargada para este equipo', resultado: `${nf(fila.equipo.meta_valor, 2)} ${fila.equipo.meta_unidad || unidad || ''}` },
            { texto: 'Consumo real calculado en el período', resultado: `${nf(m.consumo_real, 2)} ${unidad}` },
            { texto: 'Desvío contra la meta', resultado: m.desvio_pct !== null ? `+${nf(m.desvio_pct, 1)}%` : 'sin datos suficientes' }
        ],
        acciones: [
            { texto: 'Ver la tarjeta de este equipo', icono: 'fa-id-card', primaria: true, onClick: () => buscarEquipo(interno) },
            { texto: 'Ajustar su meta', icono: 'fa-sliders', onClick: () => abrirAjusteMetas(ultimoAnalisis, 'excedidos') }
        ]
    };
}

function renderKPIs(el, t, fuentes) {
    let rango;
    if (t.periodo_desde && t.periodo_hasta) rango = `${t.periodo_desde} → ${t.periodo_hasta}`;
    else if (view.meses.size > 0) rango = rangoCorto();
    else if (view.anio) rango = `Año ${view.anio}`;
    else rango = 'Sin período común entre Cargas y GPS';

    const periodoAttrs = registrarCalculo('kpi-periodo', {
        titulo: 'Período analizado', valor: rango, pasos: t.pasos.periodo,
        nota: 'Cuando no hay filtro manual, la app usa solo el tramo donde existen Cargas y GPS a la vez.',
        acciones: [
            { texto: 'Ajustar período', icono: 'fa-calendar-days', primaria: true, onClick: () => document.querySelector('.toolbar-periodo')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) },
            { texto: 'Ver cargas de este período', icono: 'fa-gas-pump', onClick: () => window.abrirTablaConBusqueda?.('carga', '') }
        ]
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
            ${kpi({ id: 'kpi-litros', label: 'Combustible', valor: `${nf(t.total_litros)} <small>L</small>`, sub: `${nf(t.cantidad_cargas)} cargas registradas`, titulo: 'Combustible total del período', pasos: t.pasos.litros,
                acciones: [
                    { texto: 'Ver cargas de combustible', icono: 'fa-gas-pump', primaria: true, onClick: () => window.abrirTablaConBusqueda?.('carga', '') },
                    { texto: 'Desglose por equipo', icono: 'fa-magnifying-glass-plus', zoom: () => nivelPorEquipo({ campo: 'total_litros', tituloBase: 'Combustible', etiquetaValor: 'los litros totales', formatear: v => `${nf(v, 2)} L`, fuenteTipo: 'carga' }) }
                ] })}
            ${kpi({ id: 'kpi-costo', label: 'Costo total', valor: money(t.total_costo), sub: costoSubPorCombustible(t), titulo: 'Costo total del combustible', pasos: t.pasos.costo,
                acciones: [
                    { texto: 'Ver cargas de combustible', icono: 'fa-gas-pump', primaria: true, onClick: () => window.abrirTablaConBusqueda?.('carga', '') },
                    { texto: 'Desglose por equipo', icono: 'fa-magnifying-glass-plus', zoom: () => nivelPorEquipo({ campo: 'total_costo', tituloBase: 'Costo', etiquetaValor: 'el costo total', formatear: v => money(v), fuenteTipo: 'carga' }) }
                ] })}
            ${kpi({ id: 'kpi-km', label: 'Distancia', valor: `${nf(t.total_km)} <small>km</small>`, sub: 'Según Resumen de Flota', titulo: 'Kilómetros recorridos', pasos: t.pasos.km,
                acciones: [
                    { texto: 'Ver reportes GPS', icono: 'fa-satellite-dish', primaria: true, onClick: () => window.abrirTablaConBusqueda?.('gps', '') },
                    { texto: 'Desglose por equipo', icono: 'fa-magnifying-glass-plus', zoom: () => nivelPorEquipo({ campo: 'total_km', tituloBase: 'Distancia', etiquetaValor: 'los kilómetros totales', formatear: v => `${nf(v)} km`, fuenteTipo: 'gps' }) }
                ] })}
            ${kpi({ id: 'kpi-horas', label: 'Horas de uso', valor: `${nf(t.total_horas)} <small>hs</small>`, sub: `${nf(t.horas_movimiento)} movimiento · ${nf(t.horas_ralenti)} ralentí`, titulo: 'Horas de uso', pasos: t.pasos.horas,
                acciones: [
                    { texto: 'Ver reportes GPS', icono: 'fa-satellite-dish', primaria: true, onClick: () => window.abrirTablaConBusqueda?.('gps', '') },
                    { texto: 'Desglose por equipo', icono: 'fa-magnifying-glass-plus', zoom: () => nivelPorEquipo({ campo: 'total_horas', tituloBase: 'Horas de uso', etiquetaValor: 'las horas totales', formatear: v => `${nf(v, 1)} hs`, fuenteTipo: 'gps' }) }
                ] })}
            ${kpi({ id: 'kpi-sobre', label: 'Sobre la meta', valor: String(t.sobre_meta), sub: `de ${t.con_meta} equipos con meta`, clase: t.sobre_meta > 0 ? 'kpi-alert' : '', titulo: 'Equipos sobre la meta', pasos: t.pasos.sobre_meta,
                acciones: t.sobre_meta > 0 ? [
                    { texto: 'Ver estos equipos', icono: 'fa-eye', primaria: true, onClick: () => filtrarPorEstado('SOBRE') },
                    { texto: 'Ajustar sus metas', icono: 'fa-sliders', onClick: () => abrirAjusteMetas(ultimoAnalisis, 'excedidos') },
                    { texto: 'Ver el detalle de cada equipo', icono: 'fa-magnifying-glass-plus', zoom: () => nivelEquiposSobreMeta() }
                ] : [] })}
            ${kpi({ id: 'kpi-equipos', label: 'Equipos', valor: String(t.equipos), sub: `${t.equipos_con_datos} con actividad · ${t.huerfanos.length} códigos sin padrón`, clase: t.huerfanos.length ? 'kpi-warn' : '', titulo: 'Equipos del maestro', pasos: t.pasos.equipos,
                acciones: [
                    { texto: 'Ver maestro de equipos', icono: 'fa-table-list', primaria: true, onClick: () => window.abrirTablaConBusqueda?.('maestro', '') },
                    ...(t.huerfanos.length ? [{ texto: `Ver ${t.huerfanos.length} código${t.huerfanos.length === 1 ? '' : 's'} sin padrón`, icono: 'fa-triangle-exclamation', onClick: () => window.abrirTablaConBusqueda?.('carga', (t.huerfanos[0]?.interno || t.huerfanos[0]?.dominio || '')) }] : [])
                ] })}
        </div>`;
}

// ---------------------------------------------------------------- diagnóstico

function renderDiagnostico(analisis, rawRecords = []) {
    const el = document.getElementById('panel-diagnostico');
    if (!el) return;
    const hallazgos = generarDiagnostico(analisis.filas, analisis.totales, rawRecords, ralentiEstadosCache, noFlotaAceptadosCache);

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

    const esHallazgoRalenti = (id) => id === 'ralenti' || id === 'ralenti_inverosimil' || id === 'ralenti_camionetas';

    const renderHallazgoCard = (h, i, esIgnorado) => {
        const abierto = diagAbiertos.has(h.id) ? diagAbiertos.get(h.id) : (esPrimerCalculo && i === 0 && !esIgnorado);
        const seguidos = diagSeguimiento.get(h.id) || new Set();
        const acciones = ACCIONES_PROPUESTAS[h.id] || [];
        const esRalenti = esHallazgoRalenti(h.id);
        const esNoflCard = h.id.startsWith('nofl_');
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
                    ${h.equipos && h.equipos.length >= 2 ? `<button class="btn-sm btn-diag-comparar-lista" data-hallazgo="${esc(h.id)}" title="Abrir comparativa con estos equipos"><i class="fa-solid fa-code-compare"></i> Comparar estos equipos</button>` : ''}
                    ${esRalenti && h.internos_bajo_promedio && h.internos_bajo_promedio.length ? `<button class="btn-sm btn-ralenti-promediar" data-hallazgo="${esc(h.id)}" title="Marca como aceptable a los equipos tildados de la lista de abajo (por defecto, los ${h.internos_bajo_promedio.length} que están en la media de ${nf(h.promedio_ralenti)} hs para abajo)"><i class="fa-solid fa-check-double"></i> Marcar aceptable (selección)</button>` : ''}
                    ${esRalenti && h.equipos && h.equipos.length ? `<button class="btn-sm btn-ralenti-reclamo-lote" data-hallazgo="${esc(h.id)}" title="Genera un reclamo de revisión de GPS para cada equipo tildado en la lista de abajo"><i class="fa-solid fa-satellite-dish"></i> Reclamo GPS (selección)</button>` : ''}
                    ${esRalenti ? `<button class="btn-sm btn-ver-reclamos-gps" title="Ver los reclamos de revisión de GPS generados"><i class="fa-solid fa-list-check"></i> Reclamos GPS</button>` : ''}
                    ${esRalenti && ralentiEstadosCache.some(r => r.estado === 'aceptable') ? `<button class="btn-sm btn-ver-ralenti-aceptados" title="Ver y desmarcar equipos con ralentí aceptable"><i class="fa-solid fa-list-check"></i> Ralentí aceptable (${ralentiEstadosCache.filter(r => r.estado === 'aceptable').length})</button>` : ''}
                    ${esNoflCard && noFlotaAceptadosCache.length ? `<button class="btn-sm btn-ver-nofl-aceptados" title="Ver y desmarcar códigos marcados como 'así está bien'"><i class="fa-solid fa-list-check"></i> Códigos válidos así (${noFlotaAceptadosCache.length})</button>` : ''}
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
                ${(() => {
                    if (!esRalenti || !h.bajo_promedio_detalle || !h.bajo_promedio_detalle.length) return '';
                    // Los equipos "en la media para abajo" casi nunca coinciden con los que ya se
                    // ven en la lista de abajo (esa lista muestra los PEORES) — por eso se listan
                    // acá aparte, con checkbox, para poder elegir cuáles quedan incluidos en
                    // "Marcar aceptable (selección)" / "Reclamo GPS (selección)" en vez de que sea
                    // todo-o-nada. Vienen tildados por defecto (son los de menor ralentí del grupo,
                    // la selección "segura"); destildar los que se prefiere revisar antes.
                    const yaMostrados = new Set((h.equipos || []).map(e => e.interno));
                    const extra = h.bajo_promedio_detalle.filter(x => !yaMostrados.has(x.interno));
                    if (!extra.length) return '';
                    return `
                    <details class="diag-bajo-promedio">
                        <summary>Elegir cuáles de los ${extra.length} equipos con ralentí en la media para abajo marcar</summary>
                        <div class="diag-bajo-promedio-toggle">
                            <button type="button" class="btn-xs btn-chk-marcar-todos" data-hallazgo="${esc(h.id)}">Marcar todos</button>
                            <button type="button" class="btn-xs btn-chk-marcar-ninguno" data-hallazgo="${esc(h.id)}">Ninguno</button>
                        </div>
                        <ul class="diag-lista diag-lista-bajo-promedio">
                            ${extra.map(x => `
                            <li data-interno="${esc(x.interno)}">
                                <input type="checkbox" class="chk-ralenti-promedio" data-interno="${esc(x.interno)}" checked title="Incluir en las acciones en bloque de este hallazgo">
                                <span class="diag-eq">${esc(x.interno)}<small>${esc(x.denominacion || '')}</small></span>
                                <span class="diag-val">${nf(x.horas)} hs en ralentí</span>
                            </li>`).join('')}
                        </ul>
                    </details>`;
                })()}
                ${h.equipos && h.equipos.length ? `
                <ul class="diag-lista">
                    ${h.equipos.map(e => {
                        const enSeg = seguidos.has(e.interno);
                        const esNofl = h.id.startsWith('nofl_');
                        const esCargasExceso = h.id === 'cargas_exceden_dias_habiles';
                        const esBajoPromedio = esRalenti && h.internos_bajo_promedio && h.internos_bajo_promedio.includes(e.interno);
                        return `
                        <li data-interno="${esc(e.interno)}" data-hallazgo="${esc(h.id)}" class="${enSeg ? 'diag-li-seguimiento' : ''}${esNofl ? ' diag-li-nofl' : ''}${e.completitud ? ' diag-comp-' + esc(e.completitud) : ''}">
                            ${esRalenti ? `<input type="checkbox" class="chk-ralenti-promedio" data-interno="${esc(e.interno)}" ${esBajoPromedio ? 'checked' : ''} title="Incluir en las acciones en bloque de este hallazgo (Marcar aceptable / Reclamo GPS)">` : ''}
                            <span class="diag-eq">${esc(e.interno)}<small>${esc(e.denominacion || '')}</small></span>
                            <span class="diag-val">${esc(e.texto)}<small>${esc(e.sub || '')}</small></span>
                            ${esNofl ? `
                            <button class="btn-xs btn-ver-cargas" data-interno="${esc(e.interno)}" title="Ver en tabla de cargas"><i class="fa-solid fa-table-list"></i> Ver cargas</button>
                            <button class="btn-xs btn-nofl-valido" data-codigo="${esc(e.interno)}" title="Marcar que este código está bien así (ej. un vehículo de préstamo/demo sin interno propio): sale de este hallazgo de ahora en más">
                                <i class="fa-solid fa-check"></i> Así está bien
                            </button>` : ''}
                            ${esCargasExceso ? `
                            <button class="btn-xs btn-ver-mes-cargas" data-interno="${esc(e.interno)}" data-anio="${esc(e.anio)}" data-mes="${esc(e.mes)}" title="Ver las cargas de ${esc(e.interno)} en ese mes en la tabla de cargas de combustible">
                                <i class="fa-solid fa-table-list"></i> Ver cargas de ese mes
                            </button>` : ''}
                            ${esRalenti ? `
                            <button class="btn-xs btn-ralenti-aceptable" data-interno="${esc(e.interno)}" title="Marcar este ralentí como aceptable: sale de este hallazgo de ahora en más">
                                <i class="fa-solid fa-check"></i> Aceptable
                            </button>
                            <button class="btn-xs btn-ralenti-reclamo" data-interno="${esc(e.interno)}" data-hallazgo="${esc(h.id)}" title="Generar un reclamo interno para pedir revisión del equipo GPS de este equipo">
                                <i class="fa-solid fa-satellite-dish"></i> Reclamo GPS
                            </button>` : ''}
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
            if (e.target.closest('.btn-diag-seguir, .btn-ver-cargas, .btn-ver-mes-cargas, .btn-ralenti-aceptable, .btn-ralenti-reclamo, .chk-ralenti-promedio, .btn-nofl-valido')) return;
            const hallazgoId = li.dataset.hallazgo || '';
            if (hallazgoId.startsWith('nofl_')) {
                // Para hallazgos nofl_*, navegar a tabla de cargas y buscar el valor
                if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', li.dataset.interno);
            } else {
                buscarEquipo(li.dataset.interno);
            }
        });
    });

    // Botón "Ver cargas" en items nofl
    el.querySelectorAll('.btn-ver-cargas').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', btn.dataset.interno);
        });
    });

    // Botón "Ver cargas de ese mes" — hallazgo "cargas_exceden_dias_habiles": lleva directo a
    // la tabla de cargas, ya filtrada por el equipo Y el mes puntual que disparó la alerta (no
    // todo el historial del equipo), para poder confirmar de un vistazo si son cargas duplicadas,
    // mal fechadas, o legítimas.
    el.querySelectorAll('.btn-ver-mes-cargas').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const { interno, anio, mes } = btn.dataset;
            if (typeof window.abrirTablaConBusqueda === 'function') {
                window.abrirTablaConBusqueda('carga', interno, 'id', { anio, mes });
            }
        });
    });
    el.querySelectorAll('.btn-diag-accion').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); abrirAjusteMetas(ultimoAnalisis, b.dataset.filtro); });
    });
    el.querySelectorAll('details.diag-card[data-id]').forEach(det => {
        det.addEventListener('toggle', () => diagAbiertos.set(det.dataset.id, det.open));
    });

    // Botón "Ignorar" individual — antes de ocultar el hallazgo sin más, si tiene una acción
    // propuesta concreta se avisa y se da la chance de aplicarla primero. "Ignorar" oculta la
    // tarjeta (se puede restaurar), no borra ni corrige nada: la corrección real la hace la
    // acción propuesta (ajustar metas, dar de alta el equipo, etc.), no el botón de ignorar.
    el.querySelectorAll('.btn-diag-ignorar').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const hid = b.dataset.hallazgo;
            const h = hallazgos.find(x => x.id === hid);
            const acciones = (h && ACCIONES_PROPUESTAS[hid]) || [];
            if (acciones.length) {
                const ok = confirm(
                    `Antes de ignorar "${h.titulo}":\n\n` +
                    `Hay una acción sugerida que puede corregir esto: "${acciones[0].texto}".\n\n` +
                    `Aceptar = ignorar igual (se puede restaurar después).\nCancelar = quedarme y aplicar esa acción.`
                );
                if (!ok) { ejecutarAccionPropuesta(acciones[0].accion, hid, analisis); return; }
            }
            diagIgnorados.add(hid);
            renderDiagnostico(analisis, rawRecords);
        });
    });

    // Botón "Ignorar todos"
    el.querySelectorAll('.btn-diag-ignorar-todos').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const conAccion = visibles.filter(h => (ACCIONES_PROPUESTAS[h.id] || []).length).length;
            const ok = confirm(
                `¿Ignorar los ${visibles.length} hallazgos visibles?\n\n` +
                (conAccion ? `${conAccion} de ellos tienen una acción sugerida (ajustar metas, dar de alta un equipo, etc.) que los podría corregir en vez de solo ocultarlos. ` : '') +
                `Quedan ocultos, no borrados: se pueden restaurar en cualquier momento desde "hallazgos ignorados".`
            );
            if (!ok) return;
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

    // Botón "Seguimiento de todos" — toggle masivo para todos los equipos del hallazgo
    el.querySelectorAll('.btn-diag-seguir-todos').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const hid = b.dataset.hallazgo;
            const h = hallazgos.find(x => x.id === hid);
            if (!h || !h.equipos) return;
            if (!diagSeguimiento.has(hid)) diagSeguimiento.set(hid, new Set());
            const s = diagSeguimiento.get(hid);
            const todosSeguidos = h.equipos.every(eq => s.has(eq.interno));
            if (todosSeguidos) {
                s.clear();
            } else {
                h.equipos.forEach(eq => s.add(eq.interno));
            }
            renderDiagnostico(analisis, rawRecords);
        });
    });

    // Botón "Comparar estos equipos" — abre comparativa con los equipos del hallazgo
    el.querySelectorAll('.btn-diag-comparar-lista').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const hid = b.dataset.hallazgo;
            const h = hallazgos.find(x => x.id === hid);
            if (!h || !h.equipos || h.equipos.length < 2) return;
            abrirComparativa(analisis, h.equipos.map(eq => eq.interno).slice(0, 8));
        });
    });

    // "Consumo fuera de la flota": marcar un código puntual (vehículo con patente sin interno,
    // planta, otros) como "así está bien" — por ejemplo un vehículo de un programa de préstamo
    // que nunca va a tener alta en el padrón, pero sí tiene centro de costo asignado. Sale del
    // hallazgo de ahora en más, sin necesidad de darlo de alta como equipo.
    el.querySelectorAll('.btn-nofl-valido').forEach(b => {
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const codigo = b.dataset.codigo;
            await setNoFlotaAceptado(codigo);
            noFlotaAceptadosCache = noFlotaAceptadosCache.filter(r => r.codigo !== codigo).concat([{ codigo }]);
            renderDiagnostico(analisis, rawRecords);
        });
    });

    el.querySelectorAll('.btn-ver-nofl-aceptados').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); abrirNoFlotaAceptados(analisis, rawRecords); });
    });

    // Ralentí: marcar un equipo puntual como "aceptable" — sale del hallazgo de ahora en más
    // (queda guardado en la base, no es un toggle de sesión como "seguimiento").
    el.querySelectorAll('.btn-ralenti-aceptable').forEach(b => {
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const interno = b.dataset.interno;
            await setRalentiEstado(interno, 'aceptable');
            ralentiEstadosCache = ralentiEstadosCache.filter(r => r.interno !== interno).concat([{ interno, estado: 'aceptable' }]);
            renderDiagnostico(analisis, rawRecords);
        });
    });

    // Ralentí: generar un reclamo interno para pedir revisión del equipo GPS de ese equipo.
    // Alcance actual: registro local (se puede ver desde "Reclamos GPS abiertos" debajo del
    // hallazgo); todavía no hay integración con ningún proveedor.
    el.querySelectorAll('.btn-ralenti-reclamo').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const motivoSugerido = b.dataset.hallazgo === 'ralenti_inverosimil'
                ? 'Ralentí inverosímil (posible error de datos o sensor del GPS)'
                : 'Ralentí muy alto sostenido: pedir verificación de que el equipo GPS esté reportando bien';
            abrirNuevoReclamoModal([b.dataset.interno], motivoSugerido, analisis, rawRecords);
        });
    });

    // Ralentí: "Reclamo GPS (selección)" — mismo reclamo, pero para todos los equipos tildados
    // de la tarjeta a la vez (los del checklist "en la media" y/o los que se hayan tildado a
    // mano en la lista de peores), en vez de reclamar uno por uno.
    el.querySelectorAll('.btn-ralenti-reclamo-lote').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const hid = b.dataset.hallazgo;
            const card = b.closest('.diag-card');
            const internos = card ? [...card.querySelectorAll('.chk-ralenti-promedio:checked')].map(c => c.dataset.interno) : [];
            if (!internos.length) { alert('No hay equipos tildados. Tildá alguno en la lista de abajo para poder reclamarlos juntos.'); return; }
            const motivoSugerido = hid === 'ralenti_inverosimil'
                ? 'Ralentí inverosímil (posible error de datos o sensor del GPS)'
                : 'Ralentí alto sostenido: pedir verificación de que el equipo GPS esté reportando bien';
            abrirNuevoReclamoModal(internos, motivoSugerido, analisis, rawRecords);
        });
    });

    // "Marcar todos" / "Ninguno" — tilda o destilda de un saque todos los checkboxes de
    // selección de ESTA tarjeta (tanto los de la lista "peores" como los de "en la media para
    // abajo"), para no tener que hacer click uno por uno antes de una acción en bloque.
    el.querySelectorAll('.btn-chk-marcar-todos, .btn-chk-marcar-ninguno').forEach(b => {
        b.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const marcar = b.classList.contains('btn-chk-marcar-todos');
            const card = b.closest('.diag-card');
            card?.querySelectorAll('.chk-ralenti-promedio').forEach(chk => { chk.checked = marcar; });
        });
    });

    // Ralentí: "Promediar y marcar como aceptable" — marca en bloque a todos los equipos del
    // hallazgo que están en la media del grupo para abajo, dejando visibles (para revisar uno
    // por uno) solo a los que se salen claramente por arriba del promedio.
    el.querySelectorAll('.btn-ralenti-promediar').forEach(b => {
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const hid = b.dataset.hallazgo;
            const h = hallazgos.find(x => x.id === hid);
            // Se toman los tildados dentro de ESTA tarjeta (el usuario puede destildar los que
            // no quiere aceptar todavía, por ejemplo porque sospecha que ese en particular tiene
            // un problema real de GPS y prefiere reclamarlo en vez de aceptarlo) — no la lista
            // completa que vino del cálculo, que es solo la propuesta por defecto (todos tildados).
            const card = b.closest('.diag-card');
            const internos = card ? [...card.querySelectorAll('.chk-ralenti-promedio:checked')].map(c => c.dataset.interno) : [];
            if (!internos.length) { alert('No hay equipos tildados para promediar.'); return; }
            if (!confirm(`¿Marcar como "ralentí aceptable" a los ${internos.length} equipos tildados (de los ${(h?.internos_bajo_promedio || []).length} en la media, ${nf(h?.promedio_ralenti)} hs, para abajo)?\n\nLos que superan el promedio, y los que destildaste, siguen visibles para revisar uno por uno.`)) return;
            for (const interno of internos) await setRalentiEstado(interno, 'aceptable');
            ralentiEstadosCache = ralentiEstadosCache.filter(r => !internos.includes(r.interno))
                .concat(internos.map(interno => ({ interno, estado: 'aceptable' })));
            renderDiagnostico(analisis, rawRecords);
        });
    });

    el.querySelectorAll('.btn-ver-reclamos-gps').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); abrirReclamosGPS(); });
    });

    el.querySelectorAll('.btn-ver-ralenti-aceptados').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); abrirRalentiAceptados(analisis, rawRecords); });
    });

    // Acciones propuestas — cada una ejecuta algo concreto
    el.querySelectorAll('.btn-diag-propuesta').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            ejecutarAccionPropuesta(b.dataset.accion, b.dataset.hallazgo, analisis);
        });
    });
}

/**
 * Lista de reclamos internos de revisión de GPS generados desde los hallazgos de ralentí.
 * Alcance actual: registro local, sin integración con ningún proveedor todavía — el campo
 * `proveedor` en la base ya está listo para cuando se sume esa info.
 */
/** Arma y abre un mailto: con el reclamo ya redactado, para que salga por el cliente de mail
 * que tenga configurado por defecto la persona (Outlook, Gmail de escritorio, etc.) — la app no
 * manda nada por sí sola, solo prepara el mensaje. Sin un mail de proveedor cargado todavía, se
 * deja el destinatario vacío para que lo complete quien lo envía. */
function mailtoReclamo(reclamo) {
    const asunto = `Reclamo de revisión GPS — equipo ${reclamo.interno}`;
    const cuerpo = `Hola,\n\nSolicitamos revisión del equipo GPS del equipo ${reclamo.interno}.\n\nMotivo: ${reclamo.motivo}\n\nFecha del reclamo: ${new Date(reclamo.fecha).toLocaleDateString('es-AR')}\n\nSaludos.`;
    const url = `mailto:?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
    window.location.href = url;
}

/** Mismo mailto: que mailtoReclamo(), pero para varios reclamos a la vez (creados juntos desde
 * "Reclamo GPS (selección)"): un solo mail con todos los equipos listados, en vez de uno por
 * equipo — así no le llega al proveedor un mail distinto por cada unidad de un mismo reclamo. */
function mailtoReclamoLote(reclamos) {
    if (!reclamos.length) return;
    if (reclamos.length === 1) { mailtoReclamo(reclamos[0]); return; }
    const asunto = `Reclamo de revisión GPS — ${reclamos.length} equipos`;
    const listado = reclamos.map(r => `· ${r.interno}: ${r.motivo}`).join('\n');
    const cuerpo = `Hola,\n\nSolicitamos revisión del equipo GPS de los siguientes equipos:\n\n${listado}\n\nFecha del reclamo: ${new Date().toLocaleDateString('es-AR')}\n\nSaludos.`;
    const url = `mailto:?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
    window.location.href = url;
}

/** Modal de alta de reclamo GPS: reemplaza el prompt() del navegador (difícil de leer con un
 * motivo largo) por un formulario real donde el motivo sugerido se ve completo y se puede
 * editar antes de guardar, con la opción de abrir de una el cliente de mail para mandarlo.
 * `internos` es siempre un array: con uno solo es el caso de siempre (botón "Reclamo GPS" de
 * una fila); con varios es "Reclamo GPS (selección)" — se guarda un reclamo por equipo, todos
 * con el mismo motivo (editable acá antes de guardar), y un único mail agrupa a todos. */
function abrirNuevoReclamoModal(internos, motivoSugerido, analisis, rawRecords) {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const lista = Array.isArray(internos) ? internos : [internos];
    const modalId = 'modal-nuevo-reclamo';
    document.getElementById(modalId)?.remove();
    const esLote = lista.length > 1;
    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content">
                <div class="modal-header">
                    <div><h2>Reclamo de revisión de GPS</h2>
                    <p class="modal-sub">${esLote ? `${lista.length} equipos: <strong>${lista.map(esc).join(', ')}</strong>` : `Equipo <strong>${esc(lista[0])}</strong>`}</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    <label class="correc-field-label" style="display:block;text-align:left;margin-bottom:0.3rem">Motivo${esLote ? ' (se usa el mismo para los ' + lista.length + ' equipos)' : ''}</label>
                    <textarea class="reclamo-motivo-input" rows="4">${esc(motivoSugerido)}</textarea>
                    <p class="modal-note">Se guarda como registro interno en la app${esLote ? ', uno por equipo' : ''}. Todavía no hay integración con ningún proveedor — "Enviar por mail" abre tu cliente de correo (Outlook, etc.) con el mensaje ya redactado para que lo mandes vos.</p>
                    <div class="modal-actions" style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.75rem">
                        <button class="btn-secondary btn-sm" data-close>Cancelar</button>
                        <button class="btn-secondary btn-sm" id="btn-reclamo-guardar"><i class="fa-solid fa-floppy-disk"></i> Guardar reclamo${esLote ? 's' : ''}</button>
                        <button class="btn-primary btn-sm" id="btn-reclamo-guardar-mail"><i class="fa-solid fa-envelope"></i> Guardar y enviar por mail</button>
                    </div>
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });

    const guardar = async (enviarMail) => {
        const motivo = modal.querySelector('.reclamo-motivo-input').value.trim() || motivoSugerido;
        const reclamos = [];
        for (const interno of lista) reclamos.push(await crearReclamoGPS({ interno, motivo }));
        cerrar();
        renderDiagnostico(analisis, rawRecords);
        if (enviarMail) mailtoReclamoLote(reclamos);
    };
    modal.querySelector('#btn-reclamo-guardar').addEventListener('click', () => guardar(false));
    modal.querySelector('#btn-reclamo-guardar-mail').addEventListener('click', () => guardar(true));
}

async function abrirReclamosGPS() {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const reclamos = (await getReclamosGPS()).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

    const modalId = 'modal-reclamos-gps';
    document.getElementById(modalId)?.remove();
    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Reclamos de revisión de GPS</h2>
                    <p class="modal-sub">${reclamos.length} reclamo${reclamos.length === 1 ? '' : 's'} · ${reclamos.filter(r => r.estado === 'abierto').length} abierto${reclamos.filter(r => r.estado === 'abierto').length === 1 ? '' : 's'}.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    ${reclamos.length ? `
                    <table class="data-table">
                        <thead><tr><th>Equipo</th><th>Motivo</th><th>Fecha</th><th>Estado</th><th></th></tr></thead>
                        <tbody>
                            ${reclamos.map(r => `<tr data-id="${r.id}">
                                <td><strong>${esc(r.interno)}</strong></td>
                                <td>${esc(r.motivo)}</td>
                                <td>${esc(new Date(r.fecha).toLocaleDateString('es-AR'))}</td>
                                <td>${r.estado === 'abierto' ? '<span class="badge-warn">Abierto</span>' : '<span class="badge-ok">Cerrado</span>'}</td>
                                <td style="white-space:nowrap">
                                    <button class="btn-xs btn-mail-reclamo" data-id="${r.id}" title="Abrir el cliente de mail con este reclamo redactado"><i class="fa-solid fa-envelope"></i> Mail</button>
                                    ${r.estado === 'abierto' ? `<button class="btn-xs btn-cerrar-reclamo" data-id="${r.id}">Marcar cerrado</button>` : ''}
                                </td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                    <p class="modal-note">Todavía no hay integración con ningún proveedor — "Mail" abre tu cliente de correo con el reclamo ya redactado para que lo mandes vos, o si preferís, imprimí la página (Ctrl/Cmd+P) y enviala.</p>`
                    : '<p class="modal-note">Todavía no se generó ningún reclamo. Se crean desde el botón "Reclamo GPS" en los hallazgos de ralentí.</p>'}
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    modal.querySelector('[data-close]').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('.btn-cerrar-reclamo').forEach(b => {
        b.addEventListener('click', async () => {
            await actualizarReclamoGPS(parseInt(b.dataset.id, 10), { estado: 'cerrado' });
            abrirReclamosGPS();
        });
    });
    modal.querySelectorAll('.btn-mail-reclamo').forEach(b => {
        b.addEventListener('click', () => {
            const r = reclamos.find(x => x.id === parseInt(b.dataset.id, 10));
            if (r) mailtoReclamo(r);
        });
    });
}

/** Lista de equipos marcados "ralentí aceptable", con opción de desmarcar (vuelven a aparecer
 * en el hallazgo la próxima vez que se recalcule el diagnóstico). */
function abrirRalentiAceptados(analisis, rawRecords) {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const aceptados = ralentiEstadosCache.filter(r => r.estado === 'aceptable');

    const modalId = 'modal-ralenti-aceptados';
    document.getElementById(modalId)?.remove();
    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content">
                <div class="modal-header">
                    <div><h2>Ralentí marcado como aceptable</h2>
                    <p class="modal-sub">${aceptados.length} equipo${aceptados.length === 1 ? '' : 's'}. Desmarcalo para que vuelva a aparecer en el hallazgo.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    ${aceptados.length ? `
                    <ul class="diag-lista">
                        ${aceptados.map(r => `<li data-interno="${esc(r.interno)}">
                            <span class="diag-eq">${esc(r.interno)}</span>
                            <button class="btn-xs btn-quitar-ralenti-aceptable" data-interno="${esc(r.interno)}"><i class="fa-solid fa-rotate-left"></i> Desmarcar</button>
                        </li>`).join('')}
                    </ul>` : '<p class="modal-note">No hay equipos marcados.</p>'}
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    modal.querySelector('[data-close]').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('.btn-quitar-ralenti-aceptable').forEach(b => {
        b.addEventListener('click', async () => {
            const interno = b.dataset.interno;
            await quitarRalentiEstado(interno);
            ralentiEstadosCache = ralentiEstadosCache.filter(r => r.interno !== interno);
            modal.remove();
            renderDiagnostico(analisis, rawRecords);
        });
    });
}

/** Lista de códigos de "consumo fuera de la flota" marcados como "así está bien", con opción
 * de desmarcar (vuelven a aparecer en el hallazgo la próxima vez que se recalcule). */
function abrirNoFlotaAceptados(analisis, rawRecords) {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const aceptados = noFlotaAceptadosCache;

    const modalId = 'modal-nofl-aceptados';
    document.getElementById(modalId)?.remove();
    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content">
                <div class="modal-header">
                    <div><h2>Códigos marcados "así está bien"</h2>
                    <p class="modal-sub">${aceptados.length} código${aceptados.length === 1 ? '' : 's'}. Desmarcalo para que vuelva a aparecer en el hallazgo.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    ${aceptados.length ? `
                    <ul class="diag-lista">
                        ${aceptados.map(r => `<li data-codigo="${esc(r.codigo)}">
                            <span class="diag-eq">${esc(r.codigo)}</span>
                            <button class="btn-xs btn-quitar-nofl-aceptado" data-codigo="${esc(r.codigo)}"><i class="fa-solid fa-rotate-left"></i> Desmarcar</button>
                        </li>`).join('')}
                    </ul>` : '<p class="modal-note">No hay códigos marcados.</p>'}
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    modal.querySelector('[data-close]').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('.btn-quitar-nofl-aceptado').forEach(b => {
        b.addEventListener('click', async () => {
            const codigo = b.dataset.codigo;
            await quitarNoFlotaAceptado(codigo);
            noFlotaAceptadosCache = noFlotaAceptadosCache.filter(r => r.codigo !== codigo);
            modal.remove();
            renderDiagnostico(analisis, rawRecords);
        });
    });
}

/**
 * Ayuda concreta por tipo de hallazgo. No es documentación general de la app: cada entrada
 * responde "qué hago con esto que me está mostrando ahora", y sobre todo "qué hago para que
 * el mes que viene no vuelva a aparecer" — que es la parte que normalmente no se hace y por eso
 * los mismos equipos reaparecen en el diagnóstico todos los meses.
 */
const CONSEJOS = {
    metas: {
        titulo: 'Metas que no cierran contra el consumo real',
        intro: 'Que el real difiera mucho de la meta tiene cuatro explicaciones posibles, y cada una se arregla distinto. Antes de pisar la meta, mirá la etiqueta de causa probable que aparece al lado de cada equipo en la lista.',
        pasos: [
            ['Posible unidad distinta', 'La diferencia es de casi exactamente 100×. La meta está cargada en L/km y la app mide en L/100Km (o al revés). Se corrige la <em>unidad</em> en "Consumos Estimados", no el número.'],
            ['Período fuera de servicio', 'Hay meses con actividad registrada por GPS y cero litros cargados: el promedio del período queda diluido y el consumo real da imposiblemente bajo. Usá <strong>Chequear período fuera de servicio</strong> para verlo mes a mes. Si sacando esos meses la meta cierra, la meta está bien — lo que falta es explicar esos meses (equipo en taller, motor encendido sin operar, o cargas que nunca se registraron).'],
            ['Meta lejos de sus pares', 'La meta está a más de 3× (o menos de un tercio) de lo que miden equipos iguales. Ahí sí: reemplazala por la mediana de pares o por el consumo real desde <strong>Ajustar metas</strong>.'],
            ['Pocos datos', 'Una o dos cargas no alcanzan para afirmar nada. Dejalos para el final y confirmá primero que no falten cargas del período sin cargar en la planilla.']
        ],
        prevenir: [
            'Cargar la meta con la unidad explícita en la planilla de "Consumos Estimados" (poner "L/100Km", no "L/km") evita de una la causa más frecuente.',
            'Cuando se da de alta un equipo nuevo, usar el botón <strong>Usar sugerencia</strong> de su tarjeta: toma la mediana de sus pares ya medidos, que es un valor realista por construcción.',
            'Si un equipo estuvo fuera de servicio un mes, conviene que quede registrado: si no, todos los meses va a volver a aparecer acá.'
        ]
    },
    sin_meta: {
        titulo: 'Equipos sin meta cargada',
        intro: 'Sin meta no hay contra qué comparar: el equipo no aparece ni como sobreconsumo ni como ahorro, simplemente queda afuera del control.',
        pasos: [
            ['Usar la sugerencia', 'La app propone la mediana de sus pares medidos, o su propio consumo real si no hay pares suficientes. Es un punto de partida realista, no un valor definitivo.'],
            ['Aplicarlas en bloque', 'Desde <strong>Ajustar metas faltantes</strong> se aplican todas juntas y después se afinan las que haga falta.'],
            ['Reemplazar cuando llegue el dato oficial', 'La meta sugerida queda marcada como "estimada": cuando el fabricante o el área técnica dé el valor real, se pisa y la tarjeta pasa a decir "ajustada".']
        ],
        prevenir: [
            'Sumar el equipo a "Consumos Estimados" en el mismo momento en que se lo da de alta en el maestro.',
            'Revisar una vez por trimestre los que quedaron con meta estimada: si ya acumularon varios meses de datos, su consumo real medido es mejor que la mediana de pares.'
        ]
    },
    estimacion_inverosimil: {
        titulo: 'Estimaciones por cálculo inverso que no son creíbles',
        intro: 'Estos equipos no tienen GPS. Su actividad se estima dividiendo los litros cargados por la meta. Si la meta está mal, el resultado no es aproximado: es inventado — y se muestra con cara de dato medido ("≈ 1,6 hs"), que es lo peligroso.',
        pasos: [
            ['Mirar la meta, no la estimación', 'El número raro es la consecuencia, no la causa. Entrá al equipo desde <strong>Investigar estas estimaciones</strong> y comparalo contra la mediana de sus pares.'],
            ['Usar la sugerencia de la tarjeta', 'En la ficha del equipo, el botón <strong>Usar sugerencia</strong> ya trae la mediana de sus pares medidos. Guardar con ese valor recalcula la estimación al instante.'],
            ['Chequear los litros también', 'Si la meta ya es razonable y el número sigue sin cerrar, el problema está del otro lado: una carga con litros mal tipeados (un cero de más) infla todo. Se ve en la tabla de cargas.'],
            ['Empezar por arriba', 'La lista viene ordenada de más a menos datos: los primeros se pueden corregir hoy con confianza, los últimos apenas registran una carga y conviene esperar.']
        ],
        prevenir: [
            'Nunca cargar una meta "de memoria" para un equipo sin GPS: es el único caso donde nada la contrasta contra la realidad, así que un error ahí no se detecta solo.',
            'Para equipos sin GPS, revisar la meta cada vez que aparece un par nuevo medido: la mediana de pares mejora con cada equipo que sí tiene GPS.',
            'A mediano plazo, los equipos que más litros cargan sin GPS son los mejores candidatos a que se les instale uno: son los que más plata mueven sin control real.'
        ]
    },
    sin_gps_estimado: {
        titulo: 'Actividad estimada por cálculo inverso',
        intro: 'No es un problema: es lo mejor que se puede medir sin GPS, y estas estimaciones pasaron el control de razonabilidad (la meta es coherente con la de sus pares y el resultado es compatible con la cantidad de cargas).',
        pasos: [
            ['Tomarlo como orden de magnitud', 'Sirve para saber si un equipo trabajó mucho o poco, no para calcular un desvío fino contra la meta.'],
            ['Revisar si algún número no cierra', 'Si conocés el equipo y la estimación no se parece a lo que realmente hizo, el problema está en la meta o en los litros cargados: de ahí sale el número.']
        ],
        prevenir: [
            'Mantener actualizada la meta de estos equipos es lo único que sostiene la estimación.',
            'Priorizar la instalación de GPS en los que más litros cargan de esta lista.'
        ]
    },
    sin_medicion: {
        titulo: 'Cargan combustible sin ningún dato de actividad',
        intro: 'No tienen km ni horas del Resumen de Flota y tampoco meta cargada: no hay forma de calcular ni de estimar nada. Son gasto sin control.',
        pasos: [
            ['Cargarles una meta', 'Es el primer paso: con meta, al menos se puede estimar la actividad por cálculo inverso.'],
            ['Verificar si deberían tener GPS', 'Si el equipo tiene GPS instalado pero no aparece en el Resumen de Flota, es un problema del equipo GPS y corresponde un reclamo, no una meta.']
        ],
        prevenir: [
            'Chequear que el Resumen de Flota que se sube incluya a todos los equipos del padrón, no solo a los que reportaron.',
            'Dar de alta la meta junto con el equipo, siempre.'
        ]
    },
    ralenti: {
        titulo: 'Horas de ralentí',
        intro: 'Ralentí es motor encendido sin trabajar: quema combustible, suma horas al motor y no produce nada. Pero no todo ralentí es desperdicio, y la app ya separa los casos.',
        pasos: [
            ['Aceptar lo que tiene explicación', 'Si un equipo tiene una razón operativa para estar encendido sin moverse, marcalo como aceptable: sale del hallazgo de ahora en más sin borrar el dato.'],
            ['Marcar en bloque', 'Los que están en la media para abajo vienen tildados por defecto: se aceptan todos juntos con <strong>Marcar aceptable (selección)</strong>.'],
            ['Reclamar el GPS cuando el número es imposible', 'Más horas de ralentí que horas del período, o ralentí sin ninguna hora de trabajo, es una falla de medición: usá <strong>Reclamo GPS</strong>.']
        ],
        prevenir: [
            'Volver a mirar los aceptados cada tanto: una excepción que se vuelve permanente deja de ser excepción.',
            'Los equipos con reclamo GPS abierto conviene sacarlos del análisis de consumo hasta que se resuelva: sus números arrastran el promedio del grupo.'
        ]
    },
    cargas_exceden_dias_habiles: {
        titulo: 'Más cargas que días hábiles',
        intro: 'Un equipo no puede cargar combustible más veces que los días laborales que tuvo el mes. Cuando pasa, casi nunca es que trabajó fin de semana: suele ser otra cosa.',
        pasos: [
            ['Cargas duplicadas', 'La misma carga cargada dos veces en la planilla, o un archivo del mismo mes subido dos veces. Es la causa más común.'],
            ['Interno mal asignado', 'Cargas de otro equipo imputadas a este por error de tipeo en el interno. Se ve mirando los importes y los sectores.'],
            ['Trabajo real fuera de días hábiles', 'Guardias, obra con plazo, o un feriado que en esta empresa se trabajó. Es legítimo, pero conviene confirmarlo.'],
            ['Ir a la tabla', 'El botón <strong>Ver cargas de ese mes</strong> te deja la tabla filtrada justo en el período del problema.']
        ],
        prevenir: [
            'Antes de subir un archivo de cargas, verificar que no se haya subido ya ese período: la app limpia los movimientos al iniciar, pero no dentro de la misma sesión.',
            'Normalizar los internos en la planilla de cargas (misma nomenclatura que el maestro) elimina la mayoría de las imputaciones cruzadas.'
        ]
    }
};
CONSEJOS.ralenti_camionetas = CONSEJOS.ralenti;
CONSEJOS.ralenti_inverosimil = CONSEJOS.ralenti;

/** Modal de ayuda contextual de un hallazgo: qué hacer ahora y cómo evitar que vuelva a aparecer. */
function abrirConsejos(hallazgoId) {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const c = CONSEJOS[hallazgoId];
    const modalId = 'modal-consejos';
    document.getElementById(modalId)?.remove();

    const cuerpo = c ? `
        <p class="modal-note" style="margin-bottom:1rem">${c.intro}</p>
        <h4 class="consejo-sub"><i class="fa-solid fa-list-check"></i> Qué hacer con esto</h4>
        <ol class="consejo-lista">
            ${c.pasos.map(([t, d]) => `<li><strong>${esc(t)}</strong><span>${d}</span></li>`).join('')}
        </ol>
        <h4 class="consejo-sub"><i class="fa-solid fa-shield-halved"></i> Para que no vuelva a aparecer</h4>
        <ul class="consejo-prevenir">
            ${c.prevenir.map(p => `<li>${p}</li>`).join('')}
        </ul>`
        : '<p class="modal-note">Todavía no hay consejos escritos para este hallazgo.</p>';

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content">
                <div class="modal-header">
                    <div><h2><i class="fa-solid fa-lightbulb" style="color:var(--accent-amber,#ffb020)"></i> ${esc(c ? c.titulo : 'Ayuda')}</h2>
                    <p class="modal-sub">Guía práctica para este hallazgo.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">${cuerpo}</div>
            </div>
        </div>`);
    const modal = document.getElementById(modalId);
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => modal.remove()));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

/**
 * Chequeo de período fuera de servicio: muestra, mes a mes, litros contra actividad, y marca
 * los meses con actividad y sin cargas (o al revés). Es la respuesta a "¿la meta está mal, o
 * este equipo estuvo parado?" — que hasta ahora había que deducir mirando la tarjeta a ojo.
 */
function abrirChequeoFueraServicio(analisis, internos) {
    const container = document.getElementById('modals-container');
    if (!container || !analisis) return;
    const lista = (internos || []).slice(0, 10);
    const modalId = 'modal-fuera-servicio';
    document.getElementById(modalId)?.remove();

    const bloques = lista.map(interno => {
        const f = analisis.filas.find(x => x.equipo.interno === interno);
        if (!f) return '';
        const fs = mesesFueraDeServicio(f);
        const meta = f.confirmed && f.confirmed.valor ? f.confirmed.valor : 0;
        const esHora = f.metrics.tipo_calculo === 'L/Hora';
        const unidadFactor = esHora ? 'hs' : 'km';
        const causa = causaMetaRara(f, analisis.filas);
        const sospechosos = fs.conActividadSinCarga.length + fs.conCargaSinActividad.length;

        const veredicto = fs.conActividadSinCarga.length
            ? (fs.consumoSaneado && meta && (fs.consumoSaneado / meta) > 0.4 && (fs.consumoSaneado / meta) < 2.5
                ? `<span class="fs-veredicto fs-ok"><i class="fa-solid fa-circle-check"></i> Sacando ${fs.conActividadSinCarga.length === 1 ? 'ese mes' : 'esos meses'}, el consumo da <strong>${nf(fs.consumoSaneado, 2)}</strong> contra una meta de <strong>${nf(meta, 2)}</strong>: la meta está bien, lo que falta es explicar ${fs.conActividadSinCarga.length === 1 ? 'ese mes' : 'esos meses'}.</span>`
                : `<span class="fs-veredicto fs-warn"><i class="fa-solid fa-triangle-exclamation"></i> Hay meses con actividad y sin cargas, pero aun sacándolos el consumo (${fs.consumoSaneado ? nf(fs.consumoSaneado, 2) : '—'}) sigue sin cerrar contra la meta (${nf(meta, 2)}): revisá también la meta.</span>`)
            : `<span class="fs-veredicto fs-neutro"><i class="fa-solid fa-circle-info"></i> No hay meses con actividad registrada y cero cargas: este equipo no estuvo fuera de servicio dentro del período. La diferencia contra la meta viene de otro lado.</span>`;

        return `
        <div class="fs-bloque">
            <div class="fs-head">
                <strong>${esc(interno)}</strong> <small>${esc(f.equipo.denominacion || '')}</small>
                <span class="fs-chip">${esc(completitudDatos(f).etiqueta)}</span>
                ${causa ? `<span class="fs-chip fs-chip-causa">causa probable: ${esc(causa.etiqueta)}</span>` : ''}
            </div>
            <div class="table-responsive">
                <table class="data-table fs-tabla">
                    <thead><tr><th>Mes</th><th>Litros</th><th>${esc(unidadFactor)}</th><th>Consumo</th><th>Cargas</th><th></th></tr></thead>
                    <tbody>
                        ${fs.meses.map(m => {
                            const raro = (m.factor > 0 && m.litros <= 0) ? 'actividad sin cargas'
                                : (m.litros > 0 && m.factor <= 0) ? 'cargas sin actividad' : '';
                            return `<tr class="${raro ? 'fs-fila-rara' : ''}">
                                <td>${esc(m.periodo)}</td>
                                <td>${nf(m.litros, 1)}</td>
                                <td>${nf(m.factor, 1)}</td>
                                <td>${m.consumo > 0 ? nf(m.consumo, 2) : '—'}</td>
                                <td>${nf(m.cargas)}</td>
                                <td>${raro ? `<span class="fs-flag">${esc(raro)}</span>` : ''}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            ${veredicto}
            ${causa ? `<p class="fs-consejo"><i class="fa-solid fa-lightbulb"></i> ${causa.consejo}</p>` : ''}
            <div class="fs-acciones">
                <button class="btn-xs btn-fs-ver-equipo" data-interno="${esc(interno)}"><i class="fa-solid fa-magnifying-glass"></i> Ver equipo</button>
                <button class="btn-xs btn-fs-ver-cargas" data-interno="${esc(interno)}"><i class="fa-solid fa-table-list"></i> Ver sus cargas</button>
                ${sospechosos ? `<span class="fs-nota">${sospechosos} mes${sospechosos === 1 ? '' : 'es'} marcado${sospechosos === 1 ? '' : 's'}</span>` : ''}
            </div>
        </div>`;
    }).join('');

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Chequeo de período fuera de servicio</h2>
                    <p class="modal-sub">Mes a mes: litros contra actividad. Un mes con actividad registrada y cero cargas diluye el promedio y hace parecer mal cargada una meta que está bien.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">${bloques || '<p class="modal-note">No hay equipos para chequear en este hallazgo.</p>'}</div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => modal.remove()));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('.btn-fs-ver-equipo').forEach(b => b.addEventListener('click', () => { modal.remove(); buscarEquipo(b.dataset.interno); }));
    modal.querySelectorAll('.btn-fs-ver-cargas').forEach(b => b.addEventListener('click', () => {
        modal.remove();
        if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', b.dataset.interno);
    }));
}

/**
 * Investigación de las estimaciones por cálculo inverso, agrupadas por completitud de datos:
 * primero los que tienen con qué decidir hoy, al final los que apenas registran una carga.
 * Cada fila muestra de dónde sale el número y qué habría que tocar para que cierre.
 */
function abrirRevisionEstimaciones(analisis, soloDudosas) {
    const container = document.getElementById('modals-container');
    if (!container || !analisis) return;
    const modalId = 'modal-estimaciones';
    document.getElementById(modalId)?.remove();

    const items = analisis.filas
        .filter(f => f.metrics.cantidad_cargas > 0 && f.metrics.total_litros > 0 && f.metrics.consumo_real === 0 && f.metrics.tipo_calculo !== 'No Aplica')
        .map(f => ({ fila: f, chequeo: estimacionCreible(f, analisis.filas) }))
        .filter(x => x.chequeo && (!soloDudosas || !x.chequeo.creible))
        .sort((a, b) => b.chequeo.completitud.score - a.chequeo.completitud.score);

    const grupos = ['alto', 'medio', 'bajo'].map(nivel => ({
        nivel, info: NIVELES_COMPLETITUD[nivel], items: items.filter(x => x.chequeo.completitud.nivel === nivel)
    })).filter(g => g.items.length);

    const cuerpo = grupos.length ? grupos.map(g => `
        <div class="est-grupo est-${esc(g.nivel)}">
            <h4 class="est-grupo-head">${esc(g.info.etiqueta)} <span>${g.items.length}</span></h4>
            <p class="est-grupo-detalle">${esc(g.info.detalle)}</p>
            <div class="table-responsive">
                <table class="data-table">
                    <thead><tr><th>Equipo</th><th>Litros</th><th>Meta usada</th><th>Mediana de pares</th><th>Estimación</th><th>Chequeo</th><th></th></tr></thead>
                    <tbody>
                        ${g.items.map(x => {
                            const c = x.chequeo;
                            return `<tr>
                                <td><strong style="color:var(--accent-cyan)">${esc(x.fila.equipo.interno)}</strong><br><small style="color:var(--text-muted)">${esc(x.fila.equipo.denominacion || '')}</small></td>
                                <td>${nf(x.fila.metrics.total_litros, 1)} L</td>
                                <td>${nf(c.meta, 2)} ${esc(x.fila.metrics.tipo_calculo)}</td>
                                <td>${c.sugerida ? `${nf(c.sugerida.valor, 2)}<br><small style="color:var(--text-muted)">${esc(c.sugerida.base)}</small>` : '<small style="color:var(--text-muted)">sin pares medidos</small>'}</td>
                                <td>≈ ${nf(c.implicita.valor, 1)} ${esc(c.implicita.unidad)}<br><small style="color:var(--text-muted)">${esc(c.implicita.formula)}</small></td>
                                <td>${c.creible
                                    ? '<span class="seg-badge seg-ok"><i class="fa-solid fa-circle-check"></i> razonable</span>'
                                    : `<span class="seg-badge seg-alta"><i class="fa-solid fa-triangle-exclamation"></i> no cierra</span><br><small style="color:var(--text-muted)">${esc(c.motivos.join(' · '))}</small>`}</td>
                                <td><button class="btn-xs btn-est-ver" data-interno="${esc(x.fila.equipo.interno)}"><i class="fa-solid fa-magnifying-glass"></i> Ver equipo</button></td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>`).join('') : '<p class="modal-note">No hay estimaciones por cálculo inverso para revisar con los datos actuales.</p>';

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Estimaciones por cálculo inverso</h2>
                    <p class="modal-sub">Agrupadas por cuántos datos hay detrás: arriba los que se pueden corregir hoy con confianza, al final los que apenas registran una carga. La estimación sale de <strong>litros ÷ meta</strong>: si la meta no es creíble, el número tampoco.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">${cuerpo}</div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => modal.remove()));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('.btn-est-ver').forEach(b => b.addEventListener('click', () => { modal.remove(); buscarEquipo(b.dataset.interno); }));
}

/** Ejecuta la acción propuesta para un hallazgo: abrir comparativa, ajustar metas, etc. */
function ejecutarAccionPropuesta(accion, hallazgoId, analisis) {
    const h = generarDiagnostico(analisis.filas, analisis.totales, [], ralentiEstadosCache, noFlotaAceptadosCache).find(x => x.id === hallazgoId);
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
            // Navegar al maestro y dejar buscado el primer equipo del hallazgo, listo para editar
            if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('maestro', internos[0] || '');
            break;
        case 'ver_cargas':
            if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', internos[0] || '');
            break;
        case 'ver_gps':
            if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('gps', internos[0] || '');
            break;
        case 'chequear_fuera_servicio':
            abrirChequeoFueraServicio(ultimoAnalisis, internos);
            break;
        case 'revisar_estimaciones':
            abrirRevisionEstimaciones(ultimoAnalisis, hallazgoId === 'estimacion_inverosimil');
            break;
        case 'consejos':
            abrirConsejos(hallazgoId);
            break;
        default:
            if (internos.length) buscarEquipo(internos[0]);
    }
}

export function buscarEquipo(interno) {
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

/** Filtra las tarjetas del panel por estado (mismos valores que #filter-estado) y hace scroll hasta ellas. Usado por las acciones de los KPI. */
function filtrarPorEstado(estado) {
    view.busqueda = ''; view.denominacion = 'ALL'; view.estado = estado;
    const input = document.getElementById('search-equip');
    if (input) input.value = '';
    const fd = document.getElementById('filter-denominacion');
    const fe = document.getElementById('filter-estado');
    if (fd) fd.value = 'ALL';
    if (fe) fe.value = estado;
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

/**
 * Lugar de carga, agrupado en dos optgroups (sede propia / estación de servicio de terceros).
 *
 * Fix: antes se armaba solo con el lugar MÁS FRECUENTE de cada equipo (`ubicacion.lugarCarga`),
 * así que un lugar que nunca es el "top" de ningún equipo —como una estación de servicio, que
 * casi siempre es secundaria frente a la sede propia— no aparecía nunca como opción, aunque
 * tuviera cargas reales. Ahora se recorre el desglose completo (`lugarCargaBreakdown`) de cada
 * equipo, así entran todos los lugares que de verdad tienen al menos una carga en el período.
 */
function poblarFiltroLugarCarga(filas) {
    const sel = document.getElementById('filter-lugarcarga');
    if (!sel) return;
    const actual = sel.value || 'ALL';
    const base = view.provincia !== 'ALL' ? filas.filter(f => f.ubicacion?.provincia === view.provincia) : filas;
    const porTipo = new Map(); // 'Sede' | 'Estación de servicio' -> Set(lugares)
    base.forEach(f => (f.ubicacion?.lugarCargaBreakdown || []).forEach(l => {
        if (!l.valor) return;
        const t = tipoLugarCarga(l.valor) || 'Sede';
        if (!porTipo.has(t)) porTipo.set(t, new Set());
        porTipo.get(t).add(l.valor);
    }));
    const grupos = [...porTipo.keys()].sort((a, b) => a === 'Sede' ? -1 : (b === 'Sede' ? 1 : a.localeCompare(b)));

    sel.innerHTML = '<option value="ALL">Todos los lugares de carga</option>' +
        grupos.map(g => `<optgroup label="${esc(g)}">${[...porTipo.get(g)].sort().map(l => `<option value="${esc(l)}">${esc(cap(l))}</option>`).join('')}</optgroup>`).join('');
    const todos = grupos.flatMap(g => [...porTipo.get(g)]);
    sel.value = (todos.includes(actual) || actual === 'ALL') ? actual : 'ALL';
}

/**
 * Centro de costo: la unidad administrativa que paga la carga. Se muestra el CÓDIGO real
 * (PMZA, AMZA, LMZA, CMZA, VMZA...) como valor y etiqueta principal —es el identificador que
 * usa HSV— con el nombre legible al lado solo como referencia cuando hay uno mapeado.
 *
 * Mismo fix que lugar de carga: antes solo entraban los centros que eran "el top" de al menos
 * un equipo (`ubicacion.centroCosto`), así que un centro siempre minoritario quedaba afuera del
 * filtro aunque tuviera cargas reales. Ahora se recorre `centroCostoBreakdown` completo.
 */
function poblarFiltroCentroCosto(filas) {
    const sel = document.getElementById('filter-centrocosto');
    if (!sel) return;
    const actual = sel.value || 'ALL';
    const base = view.provincia !== 'ALL' ? filas.filter(f => f.ubicacion?.provincia === view.provincia) : filas;
    const nombrePorCodigo = new Map();
    base.forEach(f => (f.ubicacion?.centroCostoBreakdown || []).forEach(c => {
        if (c.codigo) nombrePorCodigo.set(c.codigo, c.valor);
    }));
    const codigos = [...nombrePorCodigo.keys()].sort();
    sel.innerHTML = '<option value="ALL">Todos los centros de costo</option>' + codigos.map(c => {
        const nombre = nombrePorCodigo.get(c);
        return `<option value="${esc(c)}">${esc(c)}${nombre && nombre !== c ? ` — ${esc(nombre)}` : ''}</option>`;
    }).join('');
    sel.value = (codigos.includes(actual) || actual === 'ALL') ? actual : 'ALL';
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
    // Cargas de Combustible es la planilla maestra: de ahí salen lugar de carga, interno/
    // dominio, tipo de combustible, precio y centro de costo, y sobre esa base se arman las
    // comparativas. Un equipo del padrón (Equipos.xlsx) que no cargó combustible en el período
    // no tiene nada que analizar todavía — mostrar su tarjeta vacía solo agrega ruido. El KPI
    // "Equipos" arriba sigue contando el padrón completo; esto solo afecta qué tarjetas se ven.
    let out = filas.filter(f => f.metrics.cantidad_cargas > 0);
    if (view.busqueda) {
        const q = view.busqueda.toUpperCase();
        out = out.filter(f => [f.equipo.interno, f.equipo.dominio, f.equipo.denominacion, f.equipo.marca, f.equipo.modelo]
            .some(v => (v || '').toUpperCase().includes(q)));
    }
    if (view.denominacion !== 'ALL') out = out.filter(f => f.equipo.denominacion === view.denominacion);
    if (view.provincia !== 'ALL') out = out.filter(f => f.ubicacion?.provincia === view.provincia);
    // Se compara contra el desglose completo (¿tuvo ALGUNA carga ahí?), no solo contra el lugar
    // o centro más frecuente del equipo: un equipo que carga casi siempre en su sede pero una
    // vez pasó por una estación de servicio debe aparecer al filtrar por esa estación.
    if (view.lugarCarga !== 'ALL') out = out.filter(f => (f.ubicacion?.lugarCargaBreakdown || []).some(l => l.valor === view.lugarCarga));
    if (view.centroCosto !== 'ALL') out = out.filter(f => (f.ubicacion?.centroCostoBreakdown || []).some(c => c.codigo === view.centroCosto));
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
            if (fila) openUnitModal(fila.equipo, fila.metrics, fila.confirmed, fila.cargas, fila.gps, fila.ubicacion, periodoDeAnalisis(analisis));
        });
        card.querySelector('.btn-desalineado')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', interno);
        });
        card.querySelector('.btn-card-compare')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (comparSeleccion.has(interno)) comparSeleccion.delete(interno);
            else comparSeleccion.add(interno);
            renderCards(container, analisis);
        });

        // Click en la tarjeta (fuera de botones) → abrir overlay de pantalla completa
        card.addEventListener('click', (e) => {
            if (e.target.closest('button, a, input, select, label, [role="button"]')) return;
            if (fila) abrirOverlayEquipo(fila, analisis);
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

/**
 * Compara los meses con cargas contra los meses con GPS de un equipo y arma el tag de
 * "períodos desalineados" — ahora como botón real (con `data-interno`), no solo texto: al
 * hacer click navega a Base de Datos → Movimientos, ya filtrado por ese equipo, para ver
 * exactamente qué mes falta de qué fuente y poder actuar (subir el archivo que falta,
 * revisar una fecha mal cargada, etc.). Se usa tanto en la tarjeta como en el overlay de
 * detalle, para que la información y la acción estén disponibles en los dos lugares.
 */
function desalineadoInfo(f) {
    const fechasC = f.cargas.map(c => c.fecha).filter(Boolean).sort();
    const fechasG = f.gps.map(g => g.fecha).filter(Boolean).sort();
    const mesesC = [...new Set(fechasC.map(x => x.slice(0, 7)))].sort();
    const mesesG = [...new Set(fechasG.map(x => x.slice(0, 7)))].sort();
    const mesesSoloC = mesesC.filter(m => !mesesG.includes(m));
    const mesesSoloG = mesesG.filter(m => !mesesC.includes(m));
    if (!mesesC.length || !mesesG.length || (!mesesSoloC.length && !mesesSoloG.length)) return { html: '', mesesC, mesesG };
    const partes = [];
    if (mesesSoloC.length) partes.push(`cargas sin GPS: ${mesesSoloC.map(m => MESES_CORTO[parseInt(m.slice(5), 10) - 1]).join(', ')}`);
    if (mesesSoloG.length) partes.push(`GPS sin cargas: ${mesesSoloG.map(m => MESES_CORTO[parseInt(m.slice(5), 10) - 1]).join(', ')}`);
    const html = `<button type="button" class="meta-periodo-warn btn-desalineado" data-interno="${esc(f.equipo.interno)}" title="Los períodos de cargas y GPS no coinciden al 100%: ${esc(partes.join('; '))}. Click para revisar los movimientos de este equipo."><i class="fa-solid fa-triangle-exclamation"></i> períodos desalineados</button>`;
    return { html, mesesC, mesesG };
}

/**
 * Meta-line de la tarjeta: cargas, GPS, períodos, días hábiles, combustible.
 *
 * Rediseñada a pedido: lo que importa de un vistazo es la RELACIÓN entre cuánto cargó y
 * cuánto pudo haber cargado (cargas vs. días hábiles del período) — es la señal de cuán
 * confiable es el número que se está mirando, así que ahora es lo más destacado, con color
 * según el % de cobertura (mismo cálculo que ya se usaba para el aviso de confiabilidad).
 * El período (Ene–Jun 2026) se muestra UNA sola vez, no repetido para cargas y para GPS. La
 * cantidad de reportes GPS pasa a ser un dato secundario y más chico: sigue estando, pero ya
 * no compite en jerarquía visual con la cobertura de cargas.
 */
function cardPeriodoInfo(f, m, ubi, ralentiTag) {
    const fechasC = f.cargas.map(c => c.fecha).filter(Boolean).sort();
    const fechasG = f.gps.map(g => g.fecha).filter(Boolean).sort();
    const mesesC = [...new Set(fechasC.map(x => x.slice(0, 7)))].sort();
    const mesesG = [...new Set(fechasG.map(x => x.slice(0, 7)))].sort();
    const mesesTodos = [...new Set([...mesesC, ...mesesG])].sort();
    const rango = rangoMeses(mesesTodos);

    // Días hábiles del período de este equipo (unión de cargas + GPS) + % de cobertura —
    // coberturaEquipo() en diagnostico.js, compartida con la vista de Seguimiento para que las
    // dos lean siempre el mismo número.
    //
    // OJO: a propósito NO se recorta a 100%. Antes se recortaba con Math.min(...,100), lo que
    // escondía el caso más grave (más cargas que días hábiles hubo) mostrándolo como "100% -
    // cobertura ok" en verde, igual que un equipo con cobertura perfecta. Cargar combustible más
    // veces de las que hubo días hábiles no es "cobertura completa": es una señal de datos mal
    // cruzados (cargas duplicadas, interno reciclado, período mal recortado) — ver también el
    // hallazgo "cargas_exceden_dias_habiles" del diagnóstico automático.
    let coberturaHtml = '';
    const cob = coberturaEquipo(f);
    if (cob) {
        const { pct, diasHabiles: dias, totalCorridos, completo, cargas } = cob;
        const cls = pct > 100 ? 'cobertura-exceso' : (pct >= 40 ? 'cobertura-ok' : (pct >= 20 ? 'cobertura-media' : 'cobertura-baja'));
        const tituloExceso = pct > 100 ? ` · ⚠ más cargas que días hábiles: revisar datos duplicados o el período` : '';
        coberturaHtml = `<div class="card-cobertura ${cls}" title="${dias} días hábiles de ${totalCorridos} corridos${completo ? '' : ' (sin feriados móviles confirmados)'} · ${cargas} cargas registradas → ${pct}% de cobertura${tituloExceso}">
            <span class="cobertura-num"><i class="fa-solid fa-gas-pump"></i> ${cargas}</span>
            <span class="cobertura-sep">de</span>
            <span class="cobertura-num"><i class="fa-solid fa-calendar-days"></i> ${dias} días hábiles</span>
            <span class="cobertura-pct">${pct > 100 ? `<i class="fa-solid fa-triangle-exclamation"></i> ${pct}%` : `${pct}%`}</span>
        </div>`;
    }

    const desalineado = desalineadoInfo(f).html;

    // Tooltip detallado para GPS (el dato en sí ahora se ve chico, abajo)
    const tooltipG = mesesG.length ? `${m.cantidad_gps} reportes de Resumen de Flota en ${mesesG.length} mes${mesesG.length > 1 ? 'es' : ''}: ${mesesG.map(m => MESES_CORTO[parseInt(m.slice(5), 10) - 1] + ' ' + m.slice(0, 4)).join(', ')}` : '';

    return `
        ${coberturaHtml}
        <div class="card-meta-line card-meta-line-sub">
            ${rango ? `<span class="card-periodo-rango"><i class="fa-solid fa-calendar"></i> ${esc(rango)}</span>` : ''}
            ${m.cantidad_gps > 0 ? `<span title="${esc(tooltipG)}"><i class="fa-solid fa-satellite-dish"></i> ${m.cantidad_gps} GPS</span>` : ''}
            ${desalineado}
            ${ralentiTag}
        </div>`;
}

function estadoDe(m, confirmed, implicita = null) {
    if (m.tipo_calculo === 'No Aplica') return { cls: 'neutral', txt: 'Sin motor propio', icon: 'fa-ban' };
    // Si no hay GPS pero se pudo estimar la actividad por cálculo inverso (litros ÷ meta), no
    // repetir la misma advertencia de "falta GPS" acá abajo: ya se explica arriba, junto al número.
    if (m.motivo_sin_calculo) {
        if (implicita) return { cls: 'warn', txt: 'Sin GPS · actividad estimada por cálculo inverso', icon: 'fa-calculator' };
        return { cls: 'warn', txt: m.motivo_sin_calculo, icon: 'fa-circle-info' };
    }
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
    const est = estadoDe(m, confirmed, implicita);

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
    const sugAttrs = sug ? registrarSugerenciaCalculo(eq.interno, sug) : '';

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
            ${sug ? `
            <button class="btn-sugerir" data-valor="${sug.valor}" data-unidad="${sug.unidad}">
                <span><i class="fa-solid fa-wand-magic-sparkles"></i> Usar sugerencia: <strong>${nf(sug.valor, 2)} ${sug.unidad}</strong></span>
                <small>${esc(sug.base)} · rango real ${nf(sug.minimo, 1)}–${nf(sug.maximo, 1)}</small>
            </button>
            <button class="btn-sugerencia-detalle" ${sugAttrs}><i class="fa-solid fa-circle-info"></i> ¿De qué equipos sale?</button>` : ''}
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

/**
 * Abre una capa de pantalla completa con toda la información del equipo y controles
 * de edición siempre visibles. Se activa al hacer click en cualquier tarjeta del Panel.
 */
function abrirOverlayEquipo(fila, analisis) {
    const { equipo: eq, metrics: m, confirmed } = fila;
    const esHora = m.tipo_calculo === 'L/Hora';
    const factor = esHora ? m.total_horas : m.total_km;
    const uf = esHora ? 'hs' : 'km';
    const ubi = fila.ubicacion || {};

    // Sin GPS pero con litros: mismo cálculo inverso (litros ÷ meta) que se usa en la tarjeta,
    // para no repetir acá el bug de mostrar "0,0 hs" y "Consumo real —" cuando en realidad se
    // puede estimar la actividad a partir de lo cargado.
    const sinActividad = factor <= 0 && m.total_litros > 0;
    const implicita = sinActividad ? actividadImplicita(fila) : null;
    const est = estadoDe(m, confirmed, implicita);

    // Sugerencia de meta (igual que en la tarjeta)
    const sug = ultimoAnalisis ? sugerirMeta(fila, ultimoAnalisis.filas) : null;
    const sugAttrs = sug ? registrarSugerenciaCalculo(eq.interno, sug) : '';

    // Estado de comparación
    const enComparacion = comparSeleccion.has(eq.interno);

    // Desvío
    let desvioHTML = '';
    if (m.consumo_real > 0 && confirmed?.valor) {
        const pct = m.desvio_pct;
        const cls = pct > 15 ? 'desvio-alto' : (pct < -15 ? 'desvio-bajo' : 'desvio-ok');
        desvioHTML = `<span class="meta-desvio overlay-desvio ${cls}">${pct >= 0 ? '+' : ''}${nf(pct)}% vs meta</span>`;
    }

    // Combustible
    let combustibleLine = '';
    if (ubi.combustible) {
        const ban = getBandera(ubi.combustible) || '';
        combustibleLine = `<div class="overlay-line">${ban ? `<span class="combustible-bandera">${esc(ban)}</span>` : ''}<span>${esc(ubi.combustible)}</span></div>`;
    }

    // Ralentí
    let ralentiTagOverlay = '';
    if (m.horas_ralenti > 0) {
        const cat = categoriaRalenti(eq.interno);
        const info = RALENTI_INFO[cat] || RALENTI_INFO.desperdicio;
        const pct = m.total_horas > 0 ? (m.horas_ralenti / m.total_horas * 100) : 0;
        ralentiTagOverlay = `<span class="ralenti-tag ${info.clase}" title="${nf(pct)}% del tiempo total · ${info.texto}"><i class="fa-solid ${info.icono}"></i> ${nf(m.horas_ralenti, 1)} hs ralentí · ${info.texto}</span>`;
    }

    // Cobertura de días hábiles, período, cantidad de reportes GPS y períodos desalineados: se
    // reutiliza EXACTAMENTE la misma función que arma esta línea en la tarjeta chica (antes el
    // overlay tenía su propia versión recortada, que no incluía la cobertura ni el conteo de
    // GPS — al pasar de tarjeta a overlay esa información desaparecía). Usando la misma función
    // en los dos lugares, no se puede volver a perder nada al cambiar de vista.
    const periodoInfoOverlay = cardPeriodoInfo(fila, m, ubi, ralentiTagOverlay);

    const html = `
    <div class="equip-overlay" id="equip-overlay">
      <div class="equip-overlay-panel">
        <div class="equip-overlay-header">
          <div class="equip-overlay-ident">
            <div class="overlay-id-row">
              <h2>${esc(eq.interno)}</h2>
              ${eq.dominio ? `<span class="card-dominio">${esc(eq.dominio)}</span>` : '<em class="card-dominio">sin dominio</em>'}
            </div>
            <p class="card-deno">${esc(eq.denominacion || 'SIN CLASIFICAR')}</p>
            ${[eq.marca, eq.modelo].filter(Boolean).length ? `<p class="card-modelo">${esc([eq.marca, eq.modelo].filter(Boolean).join(' '))}</p>` : ''}
            ${(eq.anio || eq.potencia || eq.capacidad) ? `<p class="card-specs">${[eq.anio, eq.potencia, eq.capacidad].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
            <div class="card-status status-${est.cls}"><i class="fa-solid ${est.icon}"></i> <span>${esc(est.txt)}</span></div>
          </div>
          <button class="btn-icon btn-overlay-close" title="Cerrar (Esc)"><i class="fa-solid fa-xmark"></i></button>
        </div>

        <div class="equip-overlay-body">
          <!-- MÉTRICAS -->
          <div class="equip-overlay-metrics">
            <div class="overlay-stats-grid">
              <div class="stat stat-emphasis">
                <span class="stat-label"><i class="fa-solid fa-gas-pump"></i> Litros</span>
                <span class="stat-value">${nf(m.total_litros, 1)} <small class="stat-unit">L</small></span>
              </div>
              <div class="stat stat-emphasis">
                <span class="stat-label"><i class="fa-solid fa-sack-dollar"></i> Costo</span>
                <span class="stat-value">${Math.abs(m.total_costo) >= 1e6 ? `$${nf(m.total_costo / 1e6, 1)} M` : `$${nf(m.total_costo)}`}</span>
              </div>
              <div class="stat ${implicita ? 'stat-implicita' : ''}">
                <span class="stat-label">${esHora ? 'Horas' : 'Distancia'}${implicita ? ' <i class="fa-solid fa-calculator" title="Sin GPS: estimado por cálculo inverso"></i>' : ''}</span>
                <span class="stat-value ${implicita ? 'stat-muted' : ''}">${implicita ? '≈ ' + nf(implicita.valor, esHora ? 1 : 0) : nf(factor, esHora ? 1 : 0)} <small class="stat-unit">${uf}</small></span>
                ${implicita ? `<span class="stat-nota">estimado: ${esc(implicita.formula)}</span>` : ''}
              </div>
              <div class="stat">
                <span class="stat-label">Consumo real</span>
                <span class="stat-value ${m.consumo_real > 0 ? 'stat-highlight' : 'stat-muted'}">${m.consumo_real > 0 ? `${nf(m.consumo_real, 2)} <small class="stat-unit">${esc(m.tipo_calculo !== 'No Aplica' ? m.tipo_calculo : '')}</small>` : '—'}</span>
                ${implicita ? `<span class="stat-nota">no hay GPS: no se puede medir el consumo real de forma independiente, solo estimar la actividad</span>` : ''}
              </div>
            </div>
            ${implicita ? `<div class="overlay-line overlay-implicita-nota"><i class="fa-solid fa-circle-info"></i> No hay dato de GPS para este equipo en el período: la actividad (${uf}) se estimó de forma inversa, dividiendo los litros cargados por la meta cargada. Si el resultado no parece razonable, revisá o ajustá la meta debajo, o los litros cargados en el registro de cargas de este equipo.</div>` : ''}
            ${confirmed ? `
            <div class="card-meta-hero overlay-meta-hero">
              <span class="meta-label"><i class="fa-solid fa-bullseye"></i> Meta ${confirmed.source === 'Maestro' ? '(ajustada)' : '(estimada)'}</span>
              <span class="meta-valor">${nf(confirmed.valor, 2)} <small>${esc(m.tipo_calculo !== 'No Aplica' ? m.tipo_calculo : '')}</small></span>
              ${desvioHTML}
            </div>
            ${m.consumo_real > 0 ? `
            <div class="meta-bar overlay-meta-bar">
              <div class="meta-bar-track"><div class="meta-bar-fill" style="width:${Math.min((m.consumo_real / confirmed.valor) * 100, 100)}%; background:${m.desvio_pct > 15 ? 'var(--accent-red)' : (m.desvio_pct < -15 ? 'var(--accent-cyan)' : 'var(--accent-green)')}"></div></div>
              <div class="meta-bar-legend">
                <span>Real <strong>${nf(m.consumo_real, 2)}</strong></span>
                <span>Meta <strong>${nf(confirmed.valor, 2)}</strong></span>
              </div>
            </div>` : ''}` : (m.consumo_real > 0 ? `<div class="card-meta-hero card-meta-falta overlay-meta-hero"><span class="meta-label"><i class="fa-solid fa-circle-question"></i> Sin meta cargada</span></div>` : '')}
            ${m.cross_check ? `<div class="card-cross-check" style="margin-top:8px"><i class="fa-solid fa-arrows-left-right"></i> También medible como <strong>${nf(m.cross_check.consumo_alt, 2)} ${esc(m.cross_check.tipo_alt)}</strong> <small>(${nf(m.total_horas, 1)} hs · ${nf(m.total_km)} km)</small></div>` : ''}
            ${combustibleLine}
            ${ubi.centroCosto ? `<div class="overlay-line"><i class="fa-solid fa-building"></i> ${esc(ubi.centroCosto)}</div>` : ''}
            ${ubi.provincia && ubi.provincia !== 'SIN DATO' ? `<div class="overlay-line"><i class="fa-solid fa-location-dot"></i> ${esc(ubi.provincia)}</div>` : ''}
            <div class="overlay-line overlay-periodo-info">${periodoInfoOverlay}</div>
            <div class="overlay-line overlay-fuentes">
              ${m.cantidad_cargas > 0 ? `<span class="fuente-tag fuente-cargas"><i class="fa-solid fa-gas-pump"></i> ${m.cantidad_cargas} cargas</span>` : ''}
              ${m.cantidad_gps > 0 ? `<span class="fuente-tag fuente-gps"><i class="fa-solid fa-satellite-dish"></i> ${m.cantidad_gps} GPS</span>` : ''}
              ${confirmed ? `<span class="fuente-tag fuente-meta"><i class="fa-solid fa-bullseye"></i> Meta</span>` : ''}
              ${implicita ? `<span class="fuente-tag fuente-estimado" title="Cálculo inverso: litros ÷ meta, sin GPS"><i class="fa-solid fa-calculator"></i> Estimado</span>` : ''}
            </div>
          </div>

          <!-- EDICIÓN -->
          <div class="equip-overlay-edit">
            <h4 class="overlay-edit-title"><i class="fa-solid fa-pen"></i> Editar equipo</h4>
            <div class="card-edit overlay-card-edit">
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
              ${sug ? `
              <button class="btn-sugerir" data-valor="${sug.valor}" data-unidad="${sug.unidad}">
                <span><i class="fa-solid fa-wand-magic-sparkles"></i> Usar sugerencia: <strong>${nf(sug.valor, 2)} ${sug.unidad}</strong></span>
                <small>${esc(sug.base)} · rango real ${nf(sug.minimo, 1)}–${nf(sug.maximo, 1)}</small>
              </button>
              <button class="btn-sugerencia-detalle" ${sugAttrs}><i class="fa-solid fa-circle-info"></i> ¿De qué equipos sale?</button>` : ''}
              <div class="edit-actions overlay-edit-actions">
                <button class="btn-primary btn-card-save"><i class="fa-solid fa-check"></i> Guardar</button>
                <button class="btn-secondary btn-overlay-close-cancel">Cancelar</button>
              </div>
            </div>

            <div class="overlay-extra-actions">
              <button class="btn-secondary btn-sm btn-overlay-compare ${enComparacion ? 'active' : ''}">
                <i class="fa-solid ${enComparacion ? 'fa-square-check' : 'fa-code-compare'}"></i>
                ${enComparacion ? 'Quitar de comparativa' : 'Agregar a comparativa'}
              </button>
              <button class="btn-secondary btn-sm btn-overlay-detail">
                <i class="fa-solid fa-chart-simple"></i> Ver detalle de cálculo
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

    // Inyectar y conectar
    document.getElementById('equip-overlay')?.remove();
    const container = document.getElementById('modals-container');
    container.insertAdjacentHTML('beforeend', html);
    const overlay = document.getElementById('equip-overlay');

    // Cerrar
    const cerrar = () => overlay.remove();
    overlay.querySelectorAll('.btn-overlay-close, .btn-overlay-close-cancel').forEach(b => b.addEventListener('click', cerrar));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrar(); });
    const keyClose = (e) => { if (e.key === 'Escape') { cerrar(); document.removeEventListener('keydown', keyClose); } };
    document.addEventListener('keydown', keyClose);

    // Guardar
    overlay.querySelector('.btn-card-save')?.addEventListener('click', async () => {
        await guardarEdicion(eq.interno, overlay);
        cerrar();
    });

    // Sugerir meta
    overlay.querySelector('.btn-sugerir')?.addEventListener('click', (e) => {
        const b = e.currentTarget;
        overlay.querySelector('.edit-meta').value = b.dataset.valor;
        overlay.querySelector('.edit-unidad').value = b.dataset.unidad;
        b.classList.add('aplicada');
    });

    // Períodos desalineados: ir a revisar los movimientos de este equipo.
    // Cierra el overlay ANTES de navegar: si no, la tabla queda debajo de este panel y
    // ningún click en la vista de datos responde (el overlay sigue intercpetando eventos).
    overlay.querySelector('.btn-desalineado')?.addEventListener('click', () => {
        cerrar();
        if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', eq.interno);
    });

    // Comparar
    overlay.querySelector('.btn-overlay-compare')?.addEventListener('click', () => {
        if (comparSeleccion.has(eq.interno)) comparSeleccion.delete(eq.interno);
        else comparSeleccion.add(eq.interno);
        const c = document.getElementById('cards-container');
        if (c && analisis) renderCards(c, analisis);
        cerrar();
    });

    // Ver detalle de cálculo
    overlay.querySelector('.btn-overlay-detail')?.addEventListener('click', () => {
        openUnitModal(eq, m, confirmed, fila.cargas, fila.gps, fila.ubicacion, periodoDeAnalisis(analisis));
    });
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
