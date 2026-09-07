/**
 * Panel unificado: KPIs + diagnóstico + tarjetas, en una sola página.
 *
 * Todo número mostrado acá registra sus pasos de cálculo (ver calcpopover.js): al hacer
 * click en cualquier KPI o métrica de una tarjeta se abre el detalle de cómo se obtuvo.
 */
import { getAllEquipos, getAllRawRecords, getAllEstimados, updateEquipo, editarCampoEquipo, getRalentiEstados, setRalentiEstado, quitarRalentiEstado, crearReclamoGPS, getReclamosGPS, actualizarReclamoGPS, getNoFlotaAceptados, setNoFlotaAceptado, quitarNoFlotaAceptado, getEquiposExcluidos, setEquipoExcluido, quitarEquipoExcluido, updateRawRecord, registrarEdicion, saveCorreccionCarga, huellaCarga, getPrefijosNoFlota, agregarPrefijoNoFlota, quitarPrefijoNoFlota, getSeguimientoEquipos, setSeguimientoEquipo, setSeguimientoRangos, quitarSeguimientoEquipo, getActividadEstimada, setActividadEstimada, quitarActividadEstimada, deleteRawRecord, getAccionesAutomaticas } from '../data/database.js';
import { analizarFlota, periodosDisponibles, resumirMovimientosGenericos, registroVacio, mesesDeRegistro } from '../data/analyzer.js';
import { generarDiagnostico, sugerirMeta, evolucionMensual, categoriaRalenti, actividadImplicita, coberturaEquipo, completitudDatos, mesesFueraDeServicio, causaMetaRara, estimacionCreible, NIVELES_COMPLETITUD, coberturaMensual, resolverEquipo, investigarMeta, potenciaEquipo, auditarCalidadCargas, detectarPrefijosNuevos, CLASES_NO_FLOTA, cadenciaCargas, consumoDesdeActividadDeclarada, mediana, utilizacion } from '../data/diagnostico.js';
import { TIPO_POR_PREFIJO, MESES, getBandera, tipoLugarCarga, formatFechaAR, normalizeEquipoKey, getDenominacion } from '../data/normalizer.js';
import { aplicarCorreccionesAutomaticas, deshacerAccionAutomatica } from '../data/autocorreccion.js';
import { diasHabiles, esDiaHabil, esFeriado } from '../data/feriados.js';
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
let equiposExcluidosCache = [];
// Prefijos "fuera de flota" ya oficializados (persistente, ver database.js). Se pasa a
// generarDiagnostico() para que un código recién dado de alta deje de aparecer como "nuevo"
// de inmediato, sin esperar a recargar la página.
let prefijosOficialesCache = [];
// "Ignorar por ahora" de un prefijo nuevo — a propósito solo de sesión (no persiste): es una
// alerta administrativa de baja frecuencia, no hace falta el mismo mecanismo que ralentí/no-flota.
let prefijosIgnoradosCache = [];
// Grupos de variantes de texto ("Unificar variantes") marcados como "son distintos, no juntar"
// — también solo de sesión, por el mismo motivo. Clave: "campo|claveNormalizada".
const variantesIgnoradasCache = new Set();
// Correcciones que aplicó solo el diagnóstico automático (ver autocorreccion.js), para el
// hallazgo "se aplicó sola" — acotado a los últimos 14 días para que no quede como una alerta
// permanente mucho después de que alguien ya la vio.
let accionesAutomaticasCache = [];
const RECIENTE_DIAS = 14;
function accionesRecientes() {
    const corte = Date.now() - RECIENTE_DIAS * 24 * 60 * 60 * 1000;
    return accionesAutomaticasCache.filter(a => new Date(a.fecha).getTime() >= corte);
}

// "Estado del equipo": mismo store persistente que usa Base de Datos / Consumo Real
// (seguimientoEquipos) para anotar por qué un equipo tiene poca base o datos raros, sin
// excluirlo del análisis — acá se reutiliza desde las tarjetas de hallazgos (ralentí, GPS vs
// ignición, sin actividad, estimación no creíble) para no tener un mecanismo aparte por cada uno.
let seguimientoEquiposCache = new Map();
// Actividad (km/horas) declarada a mano, para equipos sin GPS. Ver database.js v11.
let actividadEstimadaCache = [];
const CATEGORIAS_SEGUIMIENTO = [
    { id: 'fuera_servicio', label: 'Fuera de servicio' },
    { id: 'taller_ext', label: 'Taller externo' },
    { id: 'taller_int', label: 'Taller interno' },
    { id: 'temporada_baja', label: 'Temporada baja' },
    { id: 'sin_chofer', label: 'Sin chofer asignado' },
    { id: 'backup', label: 'Backup / uso esporádico (ej. grupo electrógeno solo sin energía de red)' },
    { id: 'otro', label: 'Otro (detallar)' }
];
const CATEGORIA_SEGUIMIENTO_LABEL = Object.fromEntries(CATEGORIAS_SEGUIMIENTO.map(c => [c.id, c.label]));

/** El 7° parámetro opcional de generarDiagnostico(): siempre las mismas cachés de sesión. */
function extraDiag() {
    return { prefijosOficiales: prefijosOficialesCache, prefijosIgnorados: prefijosIgnoradosCache, accionesRecientes: accionesRecientes() };
}

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
// diagAtendidos: Map<hallazgoId, Map<interno, motivo>> — equipos sobre los que YA se tomó una
// acción en esta sesión (se aceptó el ralentí, se generó el reclamo, se ajustó la meta, se marcó
// para seguimiento). Salen de la lista principal del hallazgo y quedan en un desplegable aparte:
// el diagnóstico se va vaciando a medida que se trabaja, en vez de mostrar siempre lo mismo.
const diagAtendidos = new Map();
// Modo compacto: esconde los párrafos explicativos de cada hallazgo. Se enciende solo la primera
// vez que se toma una acción — la explicación sirve para entender el hallazgo, no para leerla
// cada vez que se vuelve al panel.
let diagCompacto = false;

// Último diagnóstico calculado, para poder guardar los datos de un equipo en el momento de
// atenderlo: acciones como "ralentí aceptable" lo sacan del hallazgo en el recálculo siguiente,
// y sin esta copia el registro de "lo que ya atendí" quedaría vacío.
let diagUltimosHallazgos = [];

function marcarAtendido(hallazgoId, interno, motivo) {
    if (!hallazgoId || !interno) return;
    if (!diagAtendidos.has(hallazgoId)) diagAtendidos.set(hallazgoId, new Map());
    const eq = (diagUltimosHallazgos.find(h => h.id === hallazgoId)?.equipos || []).find(e => e.interno === interno) || {};
    const previo = diagAtendidos.get(hallazgoId).get(interno);
    diagAtendidos.get(hallazgoId).set(interno, {
        motivo,
        denominacion: eq.denominacion || previo?.denominacion || '',
        texto: eq.texto || previo?.texto || '',
        sub: eq.sub || previo?.sub || ''
    });
    if (!diagCompacto) diagCompacto = true;
}

const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Rango de fechas efectivamente analizado (el mismo que ya se muestra en el KPI de período). */
const periodoDeAnalisis = (analisis) => ({ desde: analisis?.totales?.periodo_desde, hasta: analisis?.totales?.periodo_hasta });

/**
 * Verifica si una corrección guardada con `storedPeriodo` aplica al `actual`.
 * Sin periodo guardado (datos anteriores a v13) → aplica siempre (backward compat).
 * Dos períodos se solapan si A.desde ≤ B.hasta && B.desde ≤ A.hasta.
 */
const periodosCoinciden = (storedPeriodo, actual) => {
    if (!storedPeriodo || !storedPeriodo.desde || !storedPeriodo.hasta) return true;
    if (!actual || !actual.desde || !actual.hasta) return true;
    return storedPeriodo.desde <= actual.hasta && actual.desde <= storedPeriodo.hasta;
};

/**
 * Punto de entrada para la vista "Seguimiento" (js/ui/seguimiento.js): expone el último
 * análisis + diagnóstico ya calculado para que esa vista arme su propia lista de "para
 * revisar" sin volver a analizar la flota desde cero ni duplicar las reglas de negocio que
 * ya viven en generarDiagnostico(). Devuelve null si todavía no se procesó ningún dato.
 */
export function datosParaSeguimiento() {
    if (!ultimoAnalisis) return null;
    const rawRecords = datosCrudos?.rawRecords || [];
    const hallazgos = generarDiagnostico(ultimoAnalisis.filas, ultimoAnalisis.totales, rawRecords, ralentiEstadosCache, noFlotaAceptadosCache, equiposExcluidosCache, extraDiag());
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
        { texto: 'Investigar consumos estimados', icono: 'fa-magnifying-glass-chart', accion: 'investigar_meta' },
        { texto: 'Ajustar metas a consumo real', icono: 'fa-sliders', accion: 'ajustar_metas_raras' },
        { texto: 'Chequear período fuera de servicio', icono: 'fa-calendar-xmark', accion: 'chequear_fuera_servicio' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    sin_meta: [
        { texto: 'Investigar consumos estimados', icono: 'fa-magnifying-glass-chart', accion: 'investigar_meta' },
        { texto: 'Cargar metas faltantes', icono: 'fa-sliders', accion: 'ajustar_sin_meta' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    estimacion_inverosimil: [
        { texto: 'Declarar km/horas estimados', icono: 'fa-gauge-high', accion: 'declarar_actividad' },
        { texto: 'Investigar consumos estimados', icono: 'fa-magnifying-glass-chart', accion: 'investigar_meta' },
        { texto: 'Investigar estas estimaciones', icono: 'fa-magnifying-glass-chart', accion: 'revisar_estimaciones' },
        { texto: 'Chequear período fuera de servicio', icono: 'fa-calendar-xmark', accion: 'chequear_fuera_servicio' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    sin_gps_estimado: [
        { texto: 'Declarar km/horas estimados', icono: 'fa-gauge-high', accion: 'declarar_actividad' },
        { texto: 'Revisar las estimaciones', icono: 'fa-magnifying-glass-chart', accion: 'revisar_estimaciones' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    datos_parciales: [
        { texto: 'Revisar y decidir equipo por equipo', icono: 'fa-list-check', accion: 'revisar_parciales' },
        { texto: 'Declarar km/horas estimados', icono: 'fa-gauge-high', accion: 'declarar_actividad' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    bajo_uso: [
        { texto: 'Declarar km/horas estimados', icono: 'fa-gauge-high', accion: 'declarar_actividad' }
    ],
    meses_sin_gps: [
        { texto: 'Ampliar el período de análisis', icono: 'fa-cloud-arrow-up', accion: 'ir_a_carga' }
    ],
    cargas_sin_valorizar: [
        { texto: 'Completar los precios que faltan', icono: 'fa-wand-magic-sparkles', accion: 'completar_precios' },
        { texto: 'Ver esas cargas en la tabla', icono: 'fa-table-list', accion: 'ver_cargas_sin_valor' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    calidad_planilla: [
        { texto: 'Corregir duplicados exactos', icono: 'fa-check-double', accion: 'corregir_duplicados' },
        { texto: 'Unificar variantes', icono: 'fa-clone', accion: 'unificar_variantes' },
        { texto: 'Ver las cargas repetidas', icono: 'fa-table-list', accion: 'ver_cargas_repetidas' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    cargas_exceden_dias_habiles: [
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    prefijos_nuevos: [
        { texto: 'Revisar y dar de alta', icono: 'fa-shield-halved', accion: 'revisar_prefijos_nuevos' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    pares: [
        { texto: 'Comparar peores vs mejores', icono: 'fa-code-compare', accion: 'comparar_pares' }
    ],
    ralenti: [
        { texto: 'Cómo lo resuelvo', icono: 'fa-wand-magic-sparkles', accion: 'resolver' },
        { texto: 'Ver detalle de ralentí por equipo', icono: 'fa-chart-simple', accion: 'detalle_ralenti' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    ralenti_camionetas: [
        { texto: 'Cómo lo resuelvo', icono: 'fa-wand-magic-sparkles', accion: 'resolver' },
        { texto: 'Ver detalle de ralentí por equipo', icono: 'fa-chart-simple', accion: 'detalle_ralenti' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    ralenti_inverosimil: [
        { texto: 'Cómo lo resuelvo', icono: 'fa-wand-magic-sparkles', accion: 'resolver' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    ralenti_espera: [
        { texto: 'Cómo lo resuelvo', icono: 'fa-wand-magic-sparkles', accion: 'resolver' },
        { texto: 'Comparar espera mes a mes', icono: 'fa-chart-line', accion: 'comparar_espera' }
    ],
    sin_medicion: [
        { texto: 'Declarar km/horas estimados', icono: 'fa-gauge-high', accion: 'declarar_actividad' },
        { texto: 'Investigar consumos estimados', icono: 'fa-magnifying-glass-chart', accion: 'investigar_meta' },
        { texto: 'Cómo lo resuelvo', icono: 'fa-wand-magic-sparkles', accion: 'resolver' },
        { texto: 'Cargar metas para estimar actividad', icono: 'fa-bullseye', accion: 'ajustar_sin_medicion' },
        { texto: 'Cómo corregir esto', icono: 'fa-lightbulb', accion: 'consejos' }
    ],
    nofl_vehiculo_sin_interno: [
        { texto: 'Dar de alta como fuera de flota', icono: 'fa-boxes-stacked', accion: 'alta_no_flota' },
        { texto: 'Dar de alta en maestro de equipos', icono: 'fa-plus', accion: 'alta_equipo' }
    ],
    nofl_otros: [
        { texto: 'Dar de alta como fuera de flota', icono: 'fa-boxes-stacked', accion: 'alta_no_flota' },
        { texto: 'Asignar centro de costo', icono: 'fa-building', accion: 'asignar_cc' }
    ],
    nofl_planta: [
        { texto: 'Dar de alta como fuera de flota', icono: 'fa-boxes-stacked', accion: 'alta_no_flota' }
    ],
    no_flota_alta: [
        { texto: 'Ver en el maestro', icono: 'fa-table-list', accion: 'ver_maestro_no_flota' }
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
        const [equipos, rawRecords, estimados, ralentiEstados, noFlotaAceptados, equiposExcluidos, prefijosOficiales, seguimientoEquipos, actividadEstimada, accionesAutomaticas] = await Promise.all([
            getAllEquipos(), getAllRawRecords(), getAllEstimados(), getRalentiEstados(), getNoFlotaAceptados(), getEquiposExcluidos(), getPrefijosNoFlota(), getSeguimientoEquipos(), getActividadEstimada(), getAccionesAutomaticas()
        ]);
        datosCrudos = { equipos, rawRecords, estimados };
        ralentiEstadosCache = ralentiEstados;
        noFlotaAceptadosCache = noFlotaAceptados;
        equiposExcluidosCache = equiposExcluidos;
        prefijosOficialesCache = prefijosOficiales;
        seguimientoEquiposCache = new Map(seguimientoEquipos.map(s => [s.interno, s]));
        actividadEstimadaCache = actividadEstimada;
        window.actividadEstimadaCache = actividadEstimada;
        accionesAutomaticasCache = accionesAutomaticas;

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
        const filtroActivo = { anio: view.anio || null, periodos: [...view.meses] };
        ultimoAnalisis = analizarFlota({ equipos, rawRecords, estimados, filtro: filtroActivo });

        // Diagnóstico automático que se resuelve solo (ver autocorreccion.js): dar de alta un
        // interno nuevo, aceptar un código no identificable, alinear una meta vacía al consumo
        // real la primera vez. Si aplicó algo, el maestro cambió — se vuelve a analizar con los
        // datos frescos antes de mostrar nada, para no pintar un huérfano que ya se resolvió
        // hace un instante.
        const codigosAceptadosSet = new Set(noFlotaAceptados.map(n => n.codigo));
        const aplicado = await aplicarCorreccionesAutomaticas({
            equipos, huerfanos: ultimoAnalisis.totales.huerfanos, filas: ultimoAnalisis.filas,
            codigosAceptados: codigosAceptadosSet, accionesPrevias: accionesAutomaticasCache
        });
        if (aplicado.altas || aplicado.aceptados || aplicado.metas) {
            const [equiposFrescos, noFlotaFrescos, accionesFrescas] = await Promise.all([getAllEquipos(), getNoFlotaAceptados(), getAccionesAutomaticas()]);
            datosCrudos = { equipos: equiposFrescos, rawRecords, estimados };
            noFlotaAceptadosCache = noFlotaFrescos;
            accionesAutomaticasCache = accionesFrescas;
            ultimoAnalisis = analizarFlota({ equipos: equiposFrescos, rawRecords, estimados, filtro: filtroActivo });
            fuentes.equipos = equiposFrescos.length;
        }

        // Exponer para que datatable.js pueda abrir el modal de metas sin importar directamente
        window.ultimoAnalisis = ultimoAnalisis;
        window.abrirAjusteMetasDesdeTabla = (filtro) => abrirAjusteMetas(ultimoAnalisis, filtro);
        // Expuesta para que Base de Datos (pestaña "Consumo Real") pueda abrir la misma
        // investigación de meta que usan las tarjetas del Panel, sin duplicar el modal.
        window.abrirInvestigacionMeta = abrirInvestigacionMeta;
window.abrirActividadEstimada = (internos) => abrirActividadEstimada(internos, ultimoAnalisis);

        // Ítem 7: filtrar correcciones del período actual.
        // Las grabadas sin período (anteriores a v13) aplican siempre — backward compat.
        const periodoActual = periodoDeAnalisis(ultimoAnalisis);
        ralentiEstadosCache = ralentiEstadosCache.filter(r => periodosCoinciden(r.periodo, periodoActual));
        noFlotaAceptadosCache = noFlotaAceptadosCache.filter(r => periodosCoinciden(r.periodo, periodoActual));

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

    // Contar qué meses tienen cargas y cuáles GPS. Para el GPS se toman TODOS los meses que
    // cubre el reporte (mesesDeRegistro), no solo el de su fecha de inicio: un "Resumen de
    // Flota Ene-Jul" mide siete meses, y marcando solo enero el resto aparecía como "sin GPS"
    // aunque el dato estuviera cargado.
    const mesesCargas = new Set();
    const mesesGps = new Set();
    rawRecords.forEach(r => {
        if (r.type === 'carga') {
            const p = r.periodo || (r.fecha ? r.fecha.slice(0, 7) : null);
            if (p) mesesCargas.add(p);
        } else if (r.type === 'gps') {
            mesesDeRegistro(r).forEach(m => mesesGps.add(m));
        }
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

/**
 * Zoom del KPI de costo: gasto por LUGAR de carga (sede propia vs. estación de servicio de
 * terceros), no por equipo. Cada sede/estación carga uno o más combustibles con su propio
 * precio fijo por litro (ver getBandera/tipoLugarCarga en normalizer.js): el precio efectivo de
 * un lugar puede diferir del de otro simplemente porque compra un producto distinto, no porque
 * pague más caro por el mismo producto — el desglose por combustible de cada fila existe
 * justamente para no confundir esas dos cosas.
 */
function nivelPorLugar() {
    const lugares = ultimoAnalisis?.totales?.lugar_desglose || [];
    const total = lugares.reduce((s, l) => s + l.costo, 0);
    return {
        titulo: 'Costo por lugar de carga',
        valor: `${lugares.length} lugar${lugares.length === 1 ? '' : 'es'}`,
        nota: 'Ordenados de mayor a menor gasto. El precio por litro de cada lugar depende de qué combustible(s) compra ahí, no de una tarifa distinta para el mismo producto.',
        pasos: lugares.map(l => ({
            texto: `${l.lugar} ${l.tipo ? `(${l.tipo})` : ''}`,
            calculo: l.combustibles.map(c => `${cap(c.tipo)}: ${nf(c.litros, 1)} L`).join(' · '),
            resultado: `${money(l.costo)} · ${nf(l.litros, 1)} L · $${nf(l.precio_litro, 2)}/L prom.${total > 0 ? ` · ${nf((l.costo / total) * 100, 1)}%` : ''}`
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
                    { texto: 'Desglose por equipo', icono: 'fa-magnifying-glass-plus', zoom: () => nivelPorEquipo({ campo: 'total_costo', tituloBase: 'Costo', etiquetaValor: 'el costo total', formatear: v => money(v), fuenteTipo: 'carga' }) },
                    { texto: 'Desglose por lugar de carga', icono: 'fa-map-location-dot', zoom: () => nivelPorLugar() }
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
                acciones: [
                    ...(t.sobre_meta > 0 ? [
                        { texto: 'Ver estos equipos', icono: 'fa-eye', primaria: true, onClick: () => filtrarPorEstado('SOBRE') },
                        { texto: 'Ver el detalle de cada equipo', icono: 'fa-magnifying-glass-plus', zoom: () => nivelEquiposSobreMeta() }
                    ] : []),
                    { texto: 'Ajustar metas', icono: 'fa-sliders', primaria: t.sobre_meta === 0, onClick: () => abrirAjusteMetas(ultimoAnalisis, t.sobre_meta > 0 ? 'excedidos' : 'todos') }
                ] })}
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
    const hallazgos = generarDiagnostico(analisis.filas, analisis.totales, rawRecords, ralentiEstadosCache, noFlotaAceptadosCache, equiposExcluidosCache, extraDiag());

    // Qué categorías de hallazgo había la vez anterior y ya no están: es la señal de que un
    // ajuste de metas o un archivo nuevo realmente cambió algo, no solo un texto que dice
    // "actualizado" sin mostrar qué se limpió.
    const esPrimerCalculo = diagHallazgosPrevios === null;
    const idsNuevos = new Set(hallazgos.map(h => h.id));
    const resueltos = esPrimerCalculo ? [] : [...diagHallazgosPrevios.entries()].filter(([id]) => !idsNuevos.has(id));
    diagAbiertos.forEach((_, id) => { if (!idsNuevos.has(id)) diagAbiertos.delete(id); }); // no arrastrar estado de categorías que ya no existen
    diagHallazgosPrevios = new Map(hallazgos.map(h => [h.id, h.titulo]));
    diagUltimosHallazgos = hallazgos;

    // Limpiar seguimientos de hallazgos que ya no existen
    diagSeguimiento.forEach((_, id) => { if (!idsNuevos.has(id)) diagSeguimiento.delete(id); });
    // Ídem con los "atendidos": si el hallazgo desapareció (porque el ajuste lo resolvió de
    // verdad), no tiene sentido seguir arrastrando la lista de lo que se atendió dentro de él.
    diagAtendidos.forEach((_, id) => { if (!idsNuevos.has(id)) diagAtendidos.delete(id); });
    let totalAtendidos = 0;
    diagAtendidos.forEach(m => { totalAtendidos += m.size; });

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
        // "sin_medicion" (carga combustible pero el GPS no reporta ni un km ni una hora) es el
        // mismo tipo de reclamo que el ralentí: pedirle al proveedor de GPS que revise el
        // equipo, con el dato en la mano.
        const puedeReclamarGPS = esRalenti || h.id === 'sin_medicion';
        // En ralentí, "Aceptable"/"Reclamo GPS" (por fila o en selección) YA SON las dos
        // resoluciones reales — "Cómo lo resuelvo" era un tercer botón que solo repetía la
        // explicación sin resolver nada, e "Ignorar"/"Ignorar todos" esconden el hallazgo sin
        // que el problema real (posible falla de GPS) quede investigado. Se ocultan acá para
        // que la barra no ofrezca más opciones que las que de verdad cierran el caso.
        const ocultarResolverEIgnorar = esRalenti;
        // "huerfanos_typo" se trata igual que un "nofl_*" a los fines de "Así está bien": una vez
        // que una persona confirmó contra el comprobante que ese código puntual no es un typo real
        // (ej. un interno fuera de flota que se dio de alta después, o un consumo de limpieza del
        // surtidor), debe poder salir del hallazgo sin tener que ir a reasignarlo en Base de Datos.
        const esNoflCard = h.id.startsWith('nofl_') || h.id === 'huerfanos_typo';
        // Hallazgos donde tiene sentido marcar estado en bloque (backup, taller, sin chofer...)
        // para que el denominador de cobertura/utilización se ajuste a los días reales.
        const esEstadoEquipoBulk = ['subutilizacion', 'datos_parciales', 'sin_gps_estimado', 'bajo_uso'].includes(h.id);
        // Los equipos ya atendidos en esta sesión salen de la lista principal: el hallazgo se va
        // vaciando a medida que se trabaja en vez de quedar siempre igual de largo.
        const atendidos = diagAtendidos.get(h.id) || new Map();
        const equiposTodos = h.equipos || [];
        const equiposPendientes = equiposTodos.filter(e => !atendidos.has(e.interno));
        // Se listan desde el registro y no desde h.equipos: una acción como "ralentí aceptable"
        // saca al equipo del hallazgo en el recálculo, y aun así hay que poder ver qué se hizo
        // (y poder reabrirlo) sin tener que recordarlo de memoria.
        const equiposAtendidos = [...atendidos.entries()].map(([interno, d]) => ({ interno, ...d }));
        const todoAtendido = equiposPendientes.length === 0 && equiposAtendidos.length > 0;
        return `
        <details class="diag-card ${sev[h.severidad]} ${esIgnorado ? 'diag-ignorado' : ''}${todoAtendido ? ' diag-todo-atendido' : ''}" data-id="${esc(h.id)}" ${abierto && !todoAtendido ? 'open' : ''}>
            <summary>
                <i class="fa-solid ${h.icono} diag-icon"></i>
                <div class="diag-titulo">
                    <span class="diag-badge">${txt[h.severidad]}</span>
                    <h3>${esc(h.titulo)}</h3>
                    ${esIgnorado ? '<span class="diag-badge-ignorado">Ignorado</span>' : ''}
                    ${seguidos.size ? `<span class="diag-badge-seguimiento"><i class="fa-solid fa-eye"></i> ${seguidos.size} en seguimiento</span>` : ''}
                    ${atendidos.size ? `<span class="diag-badge-atendidos"><i class="fa-solid fa-check"></i> ${todoAtendido ? 'todo atendido' : `${atendidos.size} atendido${atendidos.size === 1 ? '' : 's'}`}</span>` : ''}
                </div>
                <i class="fa-solid fa-chevron-down diag-chevron"></i>
            </summary>
            <div class="diag-body">
                <p class="diag-detalle">${h.detalle}</p>
                <div class="diag-acciones-bar">
                    ${h.accion ? `<button class="btn-primary btn-sm btn-diag-accion" data-filtro="${esc(h.accion.filtro)}"><i class="fa-solid fa-sliders"></i> ${esc(h.accion.texto)}</button>` : ''}
                    ${acciones.filter(a => !(ocultarResolverEIgnorar && a.accion === 'resolver')).map(a => `<button class="btn-sm btn-diag-propuesta" data-accion="${esc(a.accion)}" data-hallazgo="${esc(h.id)}"><i class="fa-solid ${a.icono}"></i> ${esc(a.texto)}</button>`).join('')}
                    ${h.equipos && h.equipos.length >= 2 && !h.no_comparar ? `<button class="btn-sm btn-diag-comparar-lista" data-hallazgo="${esc(h.id)}" title="Abrir comparativa con estos equipos"><i class="fa-solid fa-code-compare"></i> Comparar estos equipos</button>` : ''}
                    ${esRalenti && h.internos_bajo_promedio && h.internos_bajo_promedio.length ? `<button class="btn-sm btn-ralenti-promediar" data-hallazgo="${esc(h.id)}" title="Marca como aceptable a los equipos tildados de la lista de abajo (por defecto, los ${h.internos_bajo_promedio.length} que están en la media de ${nf(h.promedio_ralenti)} hs para abajo)"><i class="fa-solid fa-check-double"></i> Marcar aceptable (selección)</button>` : ''}
                    ${(esRalenti || h.id === 'sin_medicion') && h.equipos && h.equipos.length ? `<button class="btn-sm btn-ralenti-reclamo-lote" data-hallazgo="${esc(h.id)}" title="Genera un reclamo de revisión de GPS para cada equipo tildado en la lista de abajo"><i class="fa-solid fa-satellite-dish"></i> Reclamo GPS (selección)</button>` : ''}
                    ${puedeReclamarGPS ? `<button class="btn-sm btn-ver-reclamos-gps" title="Ver los reclamos de revisión de GPS generados"><i class="fa-solid fa-list-check"></i> Reclamos GPS</button>` : ''}
                    ${esRalenti && ralentiEstadosCache.some(r => r.estado === 'aceptable') ? `<button class="btn-sm btn-ver-ralenti-aceptados" title="Ver y desmarcar equipos con ralentí aceptable"><i class="fa-solid fa-list-check"></i> Ralentí aceptable (${ralentiEstadosCache.filter(r => r.estado === 'aceptable').length})</button>` : ''}
                    ${esNoflCard && equiposPendientes.length >= 2 ? `<button class="btn-sm btn-nofl-valido-lote" data-hallazgo="${esc(h.id)}" title="Marca como 'así está bien' a todos los códigos tildados de la lista de abajo"><i class="fa-solid fa-check-double"></i> Así está bien (selección)</button>` : ''}
                    ${esNoflCard && noFlotaAceptadosCache.length ? `<button class="btn-sm btn-ver-nofl-aceptados" title="Ver y desmarcar códigos marcados como 'así está bien'"><i class="fa-solid fa-list-check"></i> Códigos válidos así (${noFlotaAceptadosCache.length})</button>` : ''}
                    ${esEstadoEquipoBulk && equiposPendientes.length >= 2 ? `
                        <button class="btn-sm btn-estado-eq-lote" data-hallazgo="${esc(h.id)}" title="Anotá el estado (backup, taller, sin chofer…) de los equipos tildados en la lista de abajo — en bloque, con motivo por fila"><i class="fa-solid fa-clipboard-list"></i> Marcar estado (selección)</button>
                        <button type="button" class="btn-xs btn-chk-marcar-todos" data-hallazgo="${esc(h.id)}" title="Tildar todos">Tildar todos</button>
                        <button type="button" class="btn-xs btn-chk-marcar-ninguno" data-hallazgo="${esc(h.id)}" title="Destildar todos">Ninguno</button>
                    ` : ''}
                    <span class="diag-acciones-sep"></span>
                    ${esIgnorado
                        ? `<button class="btn-sm btn-diag-restaurar" data-hallazgo="${esc(h.id)}" title="Volver a mostrar este hallazgo"><i class="fa-solid fa-eye"></i> Restaurar</button>`
                        : (ocultarResolverEIgnorar ? '' : `<button class="btn-sm btn-diag-ignorar" data-hallazgo="${esc(h.id)}" title="Ocultar este hallazgo hasta que cambien los datos"><i class="fa-solid fa-eye-slash"></i> Ignorar</button>`)
                    }
                    ${!ocultarResolverEIgnorar && !esIgnorado && visibles.length > 1 ? `<button class="btn-sm btn-diag-ignorar-todos" title="Ocultar todos los hallazgos"><i class="fa-solid fa-eye-slash"></i> Ignorar todos</button>` : ''}
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
                ${equiposPendientes.length ? `
                <ul class="diag-lista">
                    ${equiposPendientes.map(e => {
                        const enSeg = seguidos.has(e.interno);
                        const esNofl = h.id.startsWith('nofl_') || h.id === 'huerfanos_typo';
                        const esAccionAuto = h.id === 'acciones_automaticas';
                        const esCargasExceso = h.id === 'cargas_exceden_dias_habiles';
                        const esAnomala = h.id === 'anomalas';
                        const esBajoPromedio = esRalenti && h.internos_bajo_promedio && h.internos_bajo_promedio.includes(e.interno);
                        const estadoEq = seguimientoEquiposCache.get(e.interno);
                        return `
                        <li data-interno="${esc(e.interno)}" data-hallazgo="${esc(h.id)}" class="${enSeg ? 'diag-li-seguimiento' : ''}${esNofl ? ' diag-li-nofl' : ''}${e.completitud ? ' diag-comp-' + esc(e.completitud) : ''}">
                            ${puedeReclamarGPS || esNofl || esEstadoEquipoBulk ? `<input type="checkbox" class="chk-ralenti-promedio" data-interno="${esc(e.interno)}" ${(esBajoPromedio || esEstadoEquipoBulk) ? 'checked' : ''} title="Incluir en las acciones en bloque de este hallazgo">` : ''}
                            <span class="diag-eq">${esc(e.interno)}<small>${esc(e.denominacion || '')}</small></span>
                            <span class="diag-val">${esc(e.texto)}<small>${esc(e.sub || '')}</small>${estadoEq ? `<span class="diag-estado-badge" title="${esc(estadoEq.motivo || '')}"><i class="fa-solid fa-clipboard-list"></i> ${esc(CATEGORIA_SEGUIMIENTO_LABEL[estadoEq.categoria] || 'anotado')}</span>` : ''}</span>
                            ${esNofl ? `
                            <button class="btn-xs btn-ver-cargas" data-interno="${esc(e.interno)}" title="Ver en tabla de cargas"><i class="fa-solid fa-table-list"></i> Ver cargas</button>
                            <button class="btn-xs btn-nofl-valido" data-codigo="${esc(e.interno)}" title="Marcar que este código está bien así (ej. un vehículo de préstamo/demo sin interno propio): sale de este hallazgo de ahora en más">
                                <i class="fa-solid fa-check"></i> Así está bien
                            </button>` : ''}
                            ${esAccionAuto ? `
                            <button class="btn-xs btn-deshacer-auto" data-id="${esc(e.accion_id)}" title="Revertir esta corrección automática. No vuelve a aplicarse sola.">
                                <i class="fa-solid fa-rotate-left"></i> Deshacer
                            </button>` : ''}
                            ${esCargasExceso ? `
                            <button class="btn-xs btn-ver-mes-cargas" data-interno="${esc(e.interno)}" data-anio="${esc(e.anio)}" data-mes="${esc(e.mes)}" title="Ver las cargas de ${esc(e.interno)} en ese mes en la tabla de cargas de combustible">
                                <i class="fa-solid fa-table-list"></i> Ver cargas de ese mes
                            </button>` : ''}
                            ${esAnomala ? `
                            <button class="btn-xs btn-ver-cargas" data-interno="${esc(e.interno)}" title="Ver todas las cargas de este equipo en la tabla, para comparar esta contra las demás">
                                <i class="fa-solid fa-table-list"></i> Ver y comparar cargas
                            </button>` : ''}
                            ${esRalenti ? `
                            <button class="btn-xs btn-ralenti-aceptable" data-interno="${esc(e.interno)}" title="Investigado: el ralentí de este equipo es normal. Sale de este hallazgo de ahora en más">
                                <i class="fa-solid fa-check"></i> Investigar y marcar aceptable
                            </button>` : ''}
                            ${puedeReclamarGPS ? `
                            <button class="btn-xs btn-ralenti-reclamo" data-interno="${esc(e.interno)}" data-hallazgo="${esc(h.id)}" title="Investigado: los datos no cierran. Generar un reclamo interno para pedir revisión del equipo GPS">
                                <i class="fa-solid fa-satellite-dish"></i> Investigar y reclamar GPS
                            </button>` : ''}
                            <button class="btn-xs btn-estado-equipo" data-interno="${esc(e.interno)}" title="${estadoEq ? 'Editar el estado anotado de este equipo' : 'Anotar el estado del equipo: fuera de servicio, taller, temporada baja, sin chofer, backup...'}">
                                <i class="fa-solid fa-clipboard-list"></i> ${estadoEq ? 'Editar estado' : 'Estado'}
                            </button>
                            <button class="btn-xs btn-diag-seguir ${enSeg ? 'active' : ''}" data-hallazgo="${esc(h.id)}" data-interno="${esc(e.interno)}" title="${enSeg ? 'Quitar seguimiento' : 'Marcar para seguimiento'}">
                                <i class="fa-solid ${enSeg ? 'fa-eye-slash' : 'fa-eye'}"></i>
                            </button>
                        </li>`;
                    }).join('')}
                </ul>` : ''}
                ${equiposAtendidos.length ? `
                <details class="diag-atendidos" ${todoAtendido ? 'open' : ''}>
                    <summary>${equiposAtendidos.length} equipo${equiposAtendidos.length === 1 ? '' : 's'} ya atendido${equiposAtendidos.length === 1 ? '' : 's'} en esta sesión${todoAtendido ? ' — no queda nada pendiente en este hallazgo' : ''}</summary>
                    <ul class="diag-lista">
                        ${equiposAtendidos.map(e => `
                        <li data-interno="${esc(e.interno)}" data-hallazgo="${esc(h.id)}" class="diag-li-atendido">
                            <span class="diag-eq">${esc(e.interno)}<small>${esc(e.denominacion || '')}</small></span>
                            <span class="diag-val">${esc(e.texto)}<small>${esc(e.sub || '')}</small></span>
                            <span class="diag-atendido-motivo"><i class="fa-solid fa-check"></i> ${esc(e.motivo || 'atendido')}</span>
                            <button class="btn-xs btn-diag-desatender" data-hallazgo="${esc(h.id)}" data-interno="${esc(e.interno)}" title="Volver a dejarlo pendiente en este hallazgo"><i class="fa-solid fa-rotate-left"></i> Reabrir</button>
                        </li>`).join('')}
                    </ul>
                </details>` : ''}
            </div>
        </details>`;
    };

    el.innerHTML = `
        ${bannerResueltos}
        <div class="diag-head">
            <h2><i class="fa-solid fa-clipboard-check"></i> Diagnóstico automático</h2>
            <span class="diag-sub">${hallazgos.length} hallazgo${hallazgos.length === 1 ? '' : 's'} calculado${hallazgos.length === 1 ? '' : 's'} sobre los datos del período${ignorados.length ? ` · ${ignorados.length} ignorado${ignorados.length === 1 ? '' : 's'}` : ''}${totalAtendidos ? ` · ${totalAtendidos} equipo${totalAtendidos === 1 ? '' : 's'} atendido${totalAtendidos === 1 ? '' : 's'} en esta sesión` : ''}</span>
            <div class="diag-head-tools">
                <button class="btn-diag-compacto ${diagCompacto ? 'active' : ''}" id="btn-diag-compacto" title="${diagCompacto ? 'Volver a mostrar la explicación de cada hallazgo' : 'Esconder los párrafos explicativos y dejar solo títulos, acciones y equipos'}">
                    <i class="fa-solid ${diagCompacto ? 'fa-align-left' : 'fa-bars-staggered'}"></i> ${diagCompacto ? 'Mostrar explicaciones' : 'Modo compacto'}
                </button>
            </div>
        </div>
        <div class="diag-grid ${diagCompacto ? 'diag-compacto' : ''}">
            ${visibles.map((h, i) => renderHallazgoCard(h, i, false)).join('')}
        </div>
        ${ignorados.length ? `
        <details class="diag-ignorados-section">
            <summary class="diag-ignorados-toggle">
                <i class="fa-solid fa-eye-slash"></i> ${ignorados.length} hallazgo${ignorados.length === 1 ? '' : 's'} ignorado${ignorados.length === 1 ? '' : 's'}
                <button class="btn-xs btn-diag-restaurar-todos" title="Restaurar todos"><i class="fa-solid fa-eye"></i> Restaurar todos</button>
            </summary>
            <div class="diag-grid ${diagCompacto ? 'diag-compacto' : ''}">
                ${ignorados.map((h, i) => renderHallazgoCard(h, i, true)).join('')}
            </div>
        </details>` : ''}`;

    // --- Event listeners ---
    el.querySelectorAll('.diag-lista li[data-interno]').forEach(li => {
        li.addEventListener('click', (e) => {
            if (e.target.closest('.btn-diag-seguir, .btn-ver-cargas, .btn-ver-mes-cargas, .btn-ralenti-aceptable, .btn-ralenti-reclamo, .chk-ralenti-promedio, .btn-nofl-valido, .btn-estado-equipo, .btn-deshacer-auto')) return;
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

    // Modo compacto: esconde los párrafos explicativos de todos los hallazgos de una.
    el.querySelector('#btn-diag-compacto')?.addEventListener('click', (e) => {
        e.stopPropagation();
        diagCompacto = !diagCompacto;
        renderDiagnostico(analisis, rawRecords);
    });

    // "Reabrir": devuelve a la lista principal un equipo que se había atendido.
    el.querySelectorAll('.btn-diag-desatender').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            diagAtendidos.get(b.dataset.hallazgo)?.delete(b.dataset.interno);
            renderDiagnostico(analisis, rawRecords);
        });
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

    // Botón "Estado" / "Editar estado" por equipo — abre el modal de estado (fuera de servicio,
    // taller, temporada baja, sin chofer, backup...), respaldado en el store seguimientoEquipos.
    el.querySelectorAll('.btn-estado-equipo').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            abrirEstadoEquipo(b.dataset.interno);
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
            if (s.has(int)) { s.delete(int); diagAtendidos.get(hid)?.delete(int); }
            else { s.add(int); marcarAtendido(hid, int, 'en seguimiento'); }
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
            const per = periodoDeAnalisis(analisis);
            await setNoFlotaAceptado(codigo, '', per);
            noFlotaAceptadosCache = noFlotaAceptadosCache.filter(r => r.codigo !== codigo).concat([{ codigo, periodo: per }]);
            renderDiagnostico(analisis, rawRecords);
        });
    });

    // Mismo "así está bien", pero para todos los códigos tildados de la tarjeta de una sola vez —
    // necesario cuando el hallazgo trae varios códigos ya confirmados (huérfanos con patente,
    // servicios de planta, o un típeo que en realidad resultó ser un alta fuera de flota legítima)
    // en vez de tener que aceptarlos uno por uno.
    el.querySelectorAll('.btn-nofl-valido-lote').forEach(b => {
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const card = b.closest('.diag-card');
            const codigos = card ? [...card.querySelectorAll('.chk-ralenti-promedio:checked')].map(c => c.dataset.interno) : [];
            if (!codigos.length) { alert('No hay códigos tildados. Tildá alguno en la lista de abajo para aceptarlos juntos.'); return; }
            if (!confirm(`¿Marcar "así está bien" a los ${codigos.length} códigos tildados? Salen de este hallazgo de ahora en más.`)) return;
            const per = periodoDeAnalisis(analisis);
            for (const codigo of codigos) await setNoFlotaAceptado(codigo, '', per);
            noFlotaAceptadosCache = noFlotaAceptadosCache.filter(r => !codigos.includes(r.codigo))
                .concat(codigos.map(codigo => ({ codigo, periodo: per })));
            renderDiagnostico(analisis, rawRecords);
        });
    });

    el.querySelectorAll('.btn-ver-nofl-aceptados').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); abrirNoFlotaAceptados(analisis, rawRecords); });
    });

    el.querySelectorAll('.btn-estado-eq-lote').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = b.closest('.diag-card');
            const internos = card ? [...card.querySelectorAll('.chk-ralenti-promedio:checked')].map(c => c.dataset.interno) : [];
            if (!internos.length) { alert('No hay equipos tildados. Tildá alguno en la lista de abajo para marcarlos juntos.'); return; }
            abrirEstadoEquipoBulk(internos, b.dataset.hallazgo || '');
        });
    });

    // Deshacer una corrección automática puntual: revierte el dato (borra el alta, destilda el
    // código, o vacía la meta) y queda marcada para que no se vuelva a aplicar sola. Cambia el
    // maestro, así que hace falta un renderPanel() completo (re-analiza y vuelve a correr el
    // diagnóstico automático con la lista de deshechas ya actualizada) — no alcanza con
    // renderDiagnostico() solo, como en las acciones que no tocan equipos.
    el.querySelectorAll('.btn-deshacer-auto').forEach(b => {
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(b.dataset.id, 10);
            if (!id) return;
            const accion = accionesAutomaticasCache.find(a => a.id === id);
            if (!accion) return;
            const r = await deshacerAccionAutomatica(accion);
            if (!r.revertido) alert(r.motivo);
            await renderPanel();
        });
    });

    // Ralentí: marcar un equipo puntual como "aceptable" — sale del hallazgo de ahora en más
    // (queda guardado en la base, no es un toggle de sesión como "seguimiento").
    el.querySelectorAll('.btn-ralenti-aceptable').forEach(b => {
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const interno = b.dataset.interno;
            const per = periodoDeAnalisis(analisis);
            await setRalentiEstado(interno, 'aceptable', '', per);
            ralentiEstadosCache = ralentiEstadosCache.filter(r => r.interno !== interno).concat([{ interno, estado: 'aceptable', periodo: per }]);
            marcarAtendido(b.closest('li')?.dataset.hallazgo || '', interno, 'ralentí aceptable');
            renderDiagnostico(analisis, rawRecords);
        });
    });

    // Ralentí: generar un reclamo interno para pedir revisión del equipo GPS de ese equipo.
    // Alcance actual: registro local (se puede ver desde "Reclamos GPS abiertos" debajo del
    // hallazgo); todavía no hay integración con ningún proveedor.
    el.querySelectorAll('.btn-ralenti-reclamo').forEach(b => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const motivoSugerido = motivoReclamoGPS(b.dataset.hallazgo);
            abrirNuevoReclamoModal([b.dataset.interno], motivoSugerido, analisis, rawRecords, b.dataset.hallazgo);
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
            abrirNuevoReclamoModal(internos, motivoReclamoGPS(hid), analisis, rawRecords, hid);
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
            const per = periodoDeAnalisis(analisis);
            for (const interno of internos) await setRalentiEstado(interno, 'aceptable', '', per);
            ralentiEstadosCache = ralentiEstadosCache.filter(r => !internos.includes(r.interno))
                .concat(internos.map(interno => ({ interno, estado: 'aceptable', periodo: per })));
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
// Casilla de soporte del proveedor de GPS. El mail se abre YA dirigido acá, en vez de dejar el
// campo "Para" vacío para que alguien recuerde a quién se le reclama.
const SOPORTE_GPS = 'soportewara@waragps.com';

/**
 * Datos objetivos del equipo para meter en el reclamo. Un reclamo que dice "el ralentí parece
 * alto" no se puede accionar del otro lado; uno que dice "el GPS reporta 1.379 hs contra 363 hs
 * del informe de ignición en el mismo período" sí. Se arma con lo que la app ya calculó.
 */
function evidenciaReclamo(interno) {
    if (!ultimoAnalisis) return '';
    const f = ultimoAnalisis.filas.find(x => x.equipo.interno === interno);
    if (!f) return '';
    const m = f.metrics;
    const lin = [];
    const desde = ultimoAnalisis.totales.periodo_desde, hasta = ultimoAnalisis.totales.periodo_hasta;
    if (desde && hasta) lin.push(`  Periodo analizado: ${desde} a ${hasta}`);
    if (f.equipo.dominio) lin.push(`  Dominio: ${f.equipo.dominio}`);
    if (f.equipo.denominacion) lin.push(`  Tipo: ${f.equipo.denominacion}`);
    if (m.total_horas > 0) {
        lin.push(`  Horas reportadas por el GPS: ${nf(m.total_horas, 1)} hs (${nf(m.horas_ralenti, 1)} hs en ralenti + ${nf(m.horas_movimiento, 1)} hs en movimiento)`);
        if (m.horas_ralenti > 0) lin.push(`  Proporcion de ralenti: ${nf((m.horas_ralenti / m.total_horas) * 100)}% del tiempo reportado`);
    }
    if (m.total_km > 0) lin.push(`  Kilometros reportados: ${nf(m.total_km)} km`);
    if (m.cantidad_gps > 0) lin.push(`  Reportes recibidos en el periodo: ${nf(m.cantidad_gps)}`);
    return lin.length ? `\n\nDatos medidos por nuestro sistema:\n${lin.join('\n')}` : '';
}

// De donde sale cada dato, dicho con precision: el reclamo va a Wara, y una parte de la
// evidencia viene de Loop, que consume la API de Wara. Decirlo mal le da al proveedor una
// excusa para discutir la fuente en vez del problema.
const FUENTES_RECLAMO =
    `Aclaracion sobre las fuentes que citamos:\n` +
    `  - "Resumen de Flota": reporte mensual de Wara, con tiempo en ralenti y tiempo en movimiento por unidad.\n` +
    `  - "Informe de Ignicion": reporte de Loop (nuestro sistema de logistica), que toma los datos de Wara por API\n` +
    `    y los expone por dia, con hora de encendido, hora de apagado y horas de motor encendido.\n` +
    `  Las dos miden la misma flota y se alimentan del mismo origen, por eso la diferencia entre ambas\n` +
    `  no se explica por el metodo sino por el dato que esta reportando el equipo.\n`;

function cuerpoReclamo(intro, detalle, evidencia) {
    return `Estimados,\n\n${intro}\n\n${detalle}${evidencia}\n\n${FUENTES_RECLAMO}\n` +
        `Solicitamos la revision de los equipos y que nos informen el diagnostico y la fecha estimada de resolucion. ` +
        `Mientras tanto no podemos usar los datos de estas unidades para el control de consumo de combustible.\n\n` +
        `Fecha del reclamo: ${new Date().toLocaleDateString('es-AR')}\n\n` +
        `Muchas gracias.\n`;
}

/** Abre el cliente de correo ya dirigido al soporte del proveedor. Guarda el último mensaje en
 *  `window.__ultimoReclamoMail` para poder recuperarlo si el cliente de correo no llega a abrir. */
function abrirMailto(asunto, cuerpo) {
    const url = `mailto:${encodeURIComponent(SOPORTE_GPS)}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
    window.__ultimoReclamoMail = { para: SOPORTE_GPS, asunto, cuerpo };
    window.location.href = url;
}

function mailtoReclamo(reclamo) {
    const asunto = `Reclamo de revision GPS - equipo ${reclamo.interno}`;
    const cuerpo = cuerpoReclamo(
        `Solicitamos la revision del equipo GPS instalado en la unidad ${reclamo.interno}, porque los datos que esta reportando no son consistentes con la operacion real del equipo.`,
        `Motivo: ${reclamo.motivo}`,
        evidenciaReclamo(reclamo.interno)
    );
    abrirMailto(asunto, cuerpo);
}

/** Mismo mailto: que mailtoReclamo(), pero para varios reclamos a la vez (creados juntos desde
 * "Reclamo GPS (selección)"): un solo mail con todos los equipos listados, en vez de uno por
 * equipo — así no le llega al proveedor un mail distinto por cada unidad de un mismo reclamo. */
function mailtoReclamoLote(reclamos) {
    if (!reclamos.length) return;
    if (reclamos.length === 1) { mailtoReclamo(reclamos[0]); return; }
    const asunto = `Reclamo de revision GPS - ${reclamos.length} equipos`;
    const listado = reclamos.map(r => `- Unidad ${r.interno}: ${r.motivo}${evidenciaReclamo(r.interno)}`).join('\n\n');
    const cuerpo = cuerpoReclamo(
        `Solicitamos la revision de los equipos GPS instalados en las siguientes ${reclamos.length} unidades, porque los datos que estan reportando no son consistentes con la operacion real de los equipos.`,
        listado, ''
    );
    abrirMailto(asunto, cuerpo);
}

/** Motivo sugerido para el reclamo de GPS, según de qué hallazgo salió — cada uno describe un
 * problema real distinto (ralentí alto, ignición que no cierra, o cero actividad reportada) y el
 * texto queda editable antes de guardar, así que esto es solo un punto de partida razonable. */
function motivoReclamoGPS(hallazgoId) {
    if (hallazgoId === 'ralenti_inverosimil') return 'Ralentí inverosímil (posible error de datos o sensor del GPS)';
    if (hallazgoId === 'sin_medicion') return 'El equipo carga combustible pero el GPS no reporta ni un km ni una hora en todo el período: pedimos verificación de que el equipo esté transmitiendo.';
    return 'Ralentí alto sostenido: pedir verificación de que el equipo GPS esté reportando bien';
}

/** Modal de alta de reclamo GPS: reemplaza el prompt() del navegador (difícil de leer con un
 * motivo largo) por un formulario real donde el motivo sugerido se ve completo y se puede
 * editar antes de guardar, con la opción de abrir de una el cliente de mail para mandarlo.
 * `internos` es siempre un array: con uno solo es el caso de siempre (botón "Reclamo GPS" de
 * una fila); con varios es "Reclamo GPS (selección)" — se guarda un reclamo por equipo, todos
 * con el mismo motivo (editable acá antes de guardar), y un único mail agrupa a todos. */
function abrirNuevoReclamoModal(internos, motivoSugerido, analisis, rawRecords, hallazgoId = '') {
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
                    <p class="modal-note">Se guarda como registro interno en la app${esLote ? ', uno por equipo' : ''}. "Enviar por mail" abre tu cliente de correo con el mensaje ya redactado y dirigido a <strong>${SOPORTE_GPS}</strong>, incluyendo los datos medidos de cada equipo (horas reportadas, proporción de ralentí y, si está cargado el Informe de Ignición, la diferencia entre las dos fuentes).</p>
                    <div class="modal-actions" style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.75rem">
                        <button class="btn-secondary btn-sm" data-close>Cancelar</button>
                        <button class="btn-secondary btn-sm" id="btn-reclamo-guardar"><i class="fa-solid fa-floppy-disk"></i> Guardar reclamo${esLote ? 's' : ''}</button>
                        <button class="btn-secondary btn-sm" id="btn-reclamo-guardar-todos" title="Guarda estos y abre UN SOLO mail con todos los reclamos abiertos, no solo con estos"><i class="fa-solid fa-layer-group"></i> Guardar y sumar al reclamo único</button>
                        <button class="btn-primary btn-sm" id="btn-reclamo-guardar-mail"><i class="fa-solid fa-envelope"></i> Guardar y enviar solo estos</button>
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
        for (const interno of lista) {
            reclamos.push(await crearReclamoGPS({ interno, motivo }));
            if (hallazgoId) marcarAtendido(hallazgoId, interno, 'reclamo GPS generado');
        }
        cerrar();
        renderDiagnostico(analisis, rawRecords);
        if (enviarMail) mailtoReclamoLote(reclamos);
    };
    modal.querySelector('#btn-reclamo-guardar').addEventListener('click', () => guardar(false));
    modal.querySelector('#btn-reclamo-guardar-mail').addEventListener('click', () => guardar(true));
    // Junta estos con todo lo que ya estaba abierto y manda un solo mail.
    modal.querySelector('#btn-reclamo-guardar-todos')?.addEventListener('click', async () => {
        await guardar(false);
        await mailtoReclamoConsolidado();
    });
}

/** Un solo reclamo con TODOS los equipos abiertos, agrupado por motivo. */
async function mailtoReclamoConsolidado() {
    const abiertos = (await getReclamosGPS()).filter(r => r.estado !== 'cerrado');
    if (!abiertos.length) { alert('No hay reclamos abiertos para enviar.'); return; }

    // Agrupar por motivo: el proveedor lee mucho mejor "estos 7 por ralenti alto, estos 4 porque
    // no coinciden las dos fuentes" que una lista plana de once unidades.
    const porMotivo = new Map();
    abiertos.forEach(r => {
        const k = (r.motivo || 'Revision general').trim();
        if (!porMotivo.has(k)) porMotivo.set(k, []);
        porMotivo.get(k).push(r);
    });

    const bloques = [...porMotivo.entries()].map(([motivo, lista], i) => {
        const equipos = lista.map(r => `  - Unidad ${r.interno}${evidenciaReclamo(r.interno).replace(/\n/g, '\n  ')}`).join('\n\n');
        return `${i + 1}) ${motivo}\n   (${lista.length} unidad${lista.length === 1 ? '' : 'es'}: ${lista.map(r => r.interno).join(', ')})\n\n${equipos}`;
    }).join('\n\n');

    const internos = [...new Set(abiertos.map(r => r.interno))];
    const asunto = `Reclamo de revision GPS - ${internos.length} unidades - HSV Logistica`;
    const cuerpo = cuerpoReclamo(
        `Solicitamos la revision de los equipos GPS instalados en ${internos.length} unidades de nuestra flota. ` +
        `Los agrupamos por tipo de inconsistencia detectada. Todos los datos citados salen de sus propios reportes.`,
        bloques, ''
    );
    abrirMailto(asunto, cuerpo);
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
                    ${reclamos.filter(r => r.estado === 'abierto').length > 1 ? `
                    <div class="modal-note" style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;margin-bottom:0.75rem">
                        <span>Los ${reclamos.filter(r => r.estado === 'abierto').length} reclamos abiertos se pueden mandar juntos, agrupados por motivo (ralentí, camionetas, etc.), en un solo mail.</span>
                        <button class="btn-primary btn-sm btn-reclamo-consolidado" style="white-space:nowrap"><i class="fa-solid fa-layer-group"></i> Mail único con todos los abiertos</button>
                    </div>` : ''}
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
    modal.querySelector('.btn-reclamo-consolidado')?.addEventListener('click', () => mailtoReclamoConsolidado());
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
            ['Posible unidad distinta', 'La diferencia es de casi exactamente 100×. La meta está cargada en L/km y la app mide en L/100Km (o al revés). Se corrige la <em>unidad</em> en "Consumos Estimados", no el número.', { texto: 'Ver los equipos con este síntoma', modo: 'causa:unidad' }],
            ['Período fuera de servicio', 'Hay meses con actividad registrada por GPS y cero litros cargados: el promedio del período queda diluido y el consumo real da imposiblemente bajo. Si sacando esos meses la meta cierra, la meta está bien — lo que falta es explicar esos meses (equipo en taller, motor encendido sin operar, o cargas que nunca se registraron).', { texto: 'Ver el detalle mes a mes de estos equipos', modo: 'fuera_servicio' }],
            ['Meta lejos de sus pares', 'La meta está a más de 3× (o menos de un tercio) de lo que miden equipos iguales. Ahí sí: reemplazala por la mediana de pares o por el consumo real.', { texto: 'Ver equipos, meta actual y valor sugerido', modo: 'metas' }],
            ['Pocos datos', 'Una o dos cargas no alcanzan para afirmar nada. Dejalos para el final y confirmá primero que no falten cargas del período sin cargar en la planilla.', { texto: 'Ver los que apenas tienen datos', modo: 'pocos_datos' }]
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
            ['Usar la sugerencia', 'La app propone la mediana de sus pares medidos, o su propio consumo real si no hay pares suficientes. Es un punto de partida realista, no un valor definitivo.', { texto: 'Ver equipos y valor sugerido para cada uno', modo: 'metas' }],
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
            ['Mirar la meta, no la estimación', 'El número raro es la consecuencia, no la causa: hay que comparar la meta contra la mediana de sus pares.', { texto: 'Ver equipos, meta actual y valor sugerido', modo: 'metas' }],
            ['Usar la sugerencia de la tarjeta', 'En la ficha del equipo, el botón <strong>Usar sugerencia</strong> ya trae la mediana de sus pares medidos. Guardar con ese valor recalcula la estimación al instante.'],
            ['Chequear los litros también', 'Si la meta ya es razonable y el número sigue sin cerrar, el problema está del otro lado: una carga con litros mal tipeados (un cero de más) infla todo.', { texto: 'Ver las cargas de estos equipos', modo: 'cargas_equipos' }],
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
            ['Cargarles una meta', 'Es el primer paso: con meta, al menos se puede estimar la actividad por cálculo inverso.', { texto: 'Ver equipos y valor sugerido para cada uno', modo: 'metas' }],
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
            ['Reclamar el GPS cuando el número es imposible', 'Más horas de ralentí que horas del período, o ralentí sin ninguna hora de trabajo, es una falla de medición.', { texto: 'Ver los equipos de este hallazgo', modo: 'equipos' }]
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
            ['Cargas duplicadas', 'La misma carga cargada dos veces en la planilla, o un archivo del mismo mes subido dos veces. Es la causa más común.', { texto: 'Ver las cargas repetidas detectadas', modo: 'duplicadas' }],
            ['Interno mal asignado', 'Cargas de otro equipo imputadas a este por error de tipeo en el interno. Se ve mirando los importes y los sectores.', { texto: 'Ver las cargas agrupadas por sector y chofer', modo: 'sectores' }],
            ['Trabajo real fuera de días hábiles', 'Guardias, obra con plazo, o un feriado que en esta empresa se trabajó. Es legítimo, pero conviene confirmarlo.', { texto: 'Ver las cargas de sábado, domingo o feriado', modo: 'no_habiles' }],
            ['Ir a la tabla', 'Todas las cargas del equipo en el mes del problema, en la tabla de Base de Datos.', { texto: 'Abrir la tabla filtrada por ese mes', modo: 'tabla_mes' }]
        ],
        prevenir: [
            'Antes de subir un archivo de cargas, verificar que no se haya subido ya ese período: la app limpia los movimientos al iniciar, pero no dentro de la misma sesión.',
            'Normalizar los internos en la planilla de cargas (misma nomenclatura que el maestro) elimina la mayoría de las imputaciones cruzadas.'
        ]
    }
};
CONSEJOS.datos_parciales = {
    titulo: 'Equipos con datos de solo una parte del período',
    intro: 'Aparecen en las planillas de todos los meses pero solo tienen actividad real en uno o dos. Las filas del GPS en cero (0 km, 0 hs, 0 litros) ya no se cuentan como "trabajó cero" sino como "ese mes no hay dato" — no estiran el período ni bajan el promedio. Lo que queda es decidir por qué falta el resto.',
    pasos: [
        ['Pasó a la otra provincia', 'El caso más común: el equipo se fue a San Juan y por eso dejó de aparecer en el Resumen de Flota de estos archivos. No está fallando, no se lo está midiendo acá. Se marca la provincia en el maestro y se lo aparta del análisis.', { texto: 'Revisar y decidir equipo por equipo', modo: 'parciales' }],
        ['Salió de servicio o le sacaron el GPS', 'Baja, venta, reparación larga, alquiler a un tercero, o el equipo GPS desinstalado. Mismo tratamiento: apartarlo del análisis con el motivo escrito, para que dentro de tres meses se sepa por qué está afuera.', { texto: 'Revisar y decidir equipo por equipo', modo: 'parciales' }],
        ['Realmente trabajó solo esos meses', 'Equipo estacional o contratado para una obra puntual. Ahí los datos están bien: se marca como correcto y deja de figurar como pendiente.', { texto: 'Revisar y decidir equipo por equipo', modo: 'parciales' }],
        ['Falta subir un archivo', 'Antes de apartar nada, confirmá que estén cargadas las planillas de todos los meses del período: si falta un Resumen de Flota, medio parque va a aparecer acá.', { texto: 'Ver sus filas de GPS', modo: 'gps_equipos' }]
    ],
    prevenir: [
        'Cuando un equipo cambia de provincia, actualizar la UBICACIÓN en el maestro de Equipos en ese momento: es el dato que separa "no reporta" de "no anda".',
        'Escribir siempre el motivo al apartar un equipo. Un equipo afuera del análisis sin motivo es peor que uno adentro con datos flojos.',
        'Revisar la lista de apartados cada tanto: si el equipo volvió a reportar, hay que volver a incluirlo.'
    ]
};
CONSEJOS.meses_sin_gps = {
    titulo: 'Faltan Resumen de Flota de meses que sí tienen cargas',
    intro: 'Es el problema que más ruido genera en todo el diagnóstico. Sin el archivo de GPS de un mes no hay km ni horas, así que para ese mes no se puede calcular el consumo de ningún equipo: aparecen como "sin dato de actividad", con "períodos desalineados" y con cobertura baja — todos síntomas del mismo archivo que falta, no de problemas reales de los equipos.',
    pasos: [
        ['Subir el Resumen de Flota de cada mes que falta', 'Es un archivo por mes, el mismo formato que ya venís usando. Con eso solo, la mayoría de las alertas de esos equipos desaparecen sin tocar nada más.', { texto: 'Ir a Carga de Datos', modo: 'subir' }],
        ['Si el archivo no existe todavía', 'Puede que el proveedor de GPS no lo haya emitido aún para el mes en curso. En ese caso no hay nada que corregir: el mes se completa cuando llegue, y mientras tanto conviene analizar solo los meses cerrados.'],
        ['Si el proveedor no lo emite', 'Ahí sí es un reclamo: sin ese reporte no hay forma de controlar el combustible de ese período, y el gasto involucrado no es menor.']
    ],
    prevenir: [
        'Subir el Resumen de Flota junto con la planilla de cargas todos los meses, en el mismo momento: son el par que se cruza, uno solo no alcanza.',
        'Antes de analizar, mirar en Carga de Datos que estén los mismos meses de cargas y de GPS.'
    ]
};
CONSEJOS.cargas_sin_valorizar = {
    titulo: 'Cargas con precio o costo en cero',
    intro: 'El combustible salió del surtidor pero la planilla lo registra sin valor. No fueron gratis: falta el dato. Todo lo que la app muestra en pesos queda subestimado hasta que se completen.',
    pasos: [
        ['Ver cuáles son', 'Están listadas con fecha, equipo, lugar y chofer. Casi siempre se concentran en el último mes cargado.', { texto: 'Ver esas cargas en la tabla', modo: 'sin_valor' }],
        ['Completar el precio del período', 'Si el resto de las cargas de ese combustible en ese mes tienen precio, ese es el valor que corresponde. Se puede corregir carga por carga desde la tabla, haciendo click en la celda.'],
        ['Chequear si es un problema del sistema de origen', 'Si son todas del mismo mes y del mismo surtidor, probablemente el precio no se cargó en el sistema que emite la planilla, y conviene arreglarlo ahí antes de que se repita.']
    ],
    prevenir: [
        'Al recibir la planilla del mes, ordenar por costo total y mirar si hay ceros arriba: son diez segundos y evita cerrar un mes con el gasto mal.',
        'Si el precio del combustible es de contrato y no cambia, dejarlo cargado por defecto en el sistema de origen.'
    ]
};
CONSEJOS.calidad_planilla = {
    titulo: 'Inconsistencias de escritura y filas repetidas',
    intro: 'Errores de la planilla, no de los equipos. Son baratos de arreglar y ensucian totales que después se usan para decidir.',
    pasos: [
        ['Unificar la escritura del combustible', 'El mismo producto escrito de dos formas se cuenta como dos productos distintos. Buscar y reemplazar en la planilla de origen deja los totales por combustible correctos.'],
        ['Revisar las filas repetidas', 'Mismo equipo, misma fecha, mismos litros. Casi siempre es la misma carga cargada dos veces — pero puede ser real (dos cargas iguales el mismo día). Confirmá contra el comprobante antes de borrar.', { texto: 'Ver las cargas repetidas', modo: 'repetidas_tabla' }],
        ['Corregir en el origen, no acá', 'Si se arregla solo en la app, el mes que viene la planilla vuelve con el mismo error.']
    ],
    prevenir: [
        'Usar una lista desplegable en la planilla para el tipo de combustible, en vez de texto libre: elimina las variantes de escritura de raíz.',
        'Antes de subir un archivo, verificar que ese período no se haya subido ya.'
    ]
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
        <h4 class="consejo-sub"><i class="fa-solid fa-list-check"></i> Qué hacer con esto — tocá un paso para ir a los registros</h4>
        <ol class="consejo-lista">
            ${c.pasos.map(([t, d, accion]) => `<li class="${accion ? 'consejo-accionable' : ''}" ${accion ? `data-modo="${esc(accion.modo)}"` : ''}>
                <strong>${esc(t)}</strong><span>${d}</span>
                ${accion ? `<span class="consejo-cta"><i class="fa-solid fa-arrow-right-long"></i> ${esc(accion.texto)}</span>` : ''}
            </li>`).join('')}
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
    // Cada paso con acción lleva a los registros concretos que lo provocan, con varias formas
    // de corregirlo — el consejo deja de ser un texto y pasa a ser el punto de entrada.
    modal.querySelectorAll('.consejo-accionable').forEach(li => {
        li.addEventListener('click', () => {
            const modo = li.dataset.modo;
            modal.remove();
            abrirRegistrosConsejo(modo, hallazgoId);
        });
    });
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
                                <td>≈ ${nf(c.implicita.valor, 1)} ${esc(c.implicita.unidad)}<br><small style="color:var(--text-muted)">${esc(c.implicita.formula)}</small>${c.implicita.referencia ? `<br><small style="color:var(--text-muted)" title="${esc(c.implicita.referencia.formula)}">${c.implicita.referencia.respalda ? '✓' : '⚠'} jornada de referencia: ${nf(c.implicita.referencia.horas_min, 0)}-${nf(c.implicita.referencia.horas_max, 0)} hs esperadas</small>` : ''}</td>
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


/**
 * Registros concretos detrás de un consejo. Cada paso de la guía deja de ser un texto y pasa a
 * ser una puerta: abre las filas reales que lo provocan (las cargas repetidas, las de fin de
 * semana, los equipos con la meta lejos de sus pares) y ofrece varias formas de corregirlo —
 * abrir la tabla filtrada, entrar al equipo, mirar el maestro o dejarlo marcado como atendido.
 */
function abrirRegistrosConsejo(modo, hallazgoId) {
    const container = document.getElementById('modals-container');
    const analisis = ultimoAnalisis;
    if (!container || !analisis) return;

    // El modo "fuera_servicio" ya tiene su propia pantalla mes a mes: no se duplica acá.
    const h = generarDiagnostico(analisis.filas, analisis.totales, datosCrudos?.rawRecords || [], ralentiEstadosCache, noFlotaAceptadosCache, equiposExcluidosCache, extraDiag())
        .find(x => x.id === hallazgoId);
    const equiposH = (h && h.equipos) || [];
    if (modo === 'fuera_servicio') { abrirChequeoFueraServicio(analisis, equiposH.map(e => e.interno)); return; }
    if (modo === 'parciales') { abrirRevisionParciales(analisis, datosCrudos?.rawRecords || []); return; }
    if (modo === 'subir') { if (typeof window.irA === 'function') window.irA('upload'); else document.getElementById('nav-upload')?.click(); return; }
    if (modo === 'sin_valor') {
        if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', '', 'id', null, 'sin_valorizar');
        return;
    }
    if (modo === 'repetidas_tabla') {
        if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', '', 'id', null, 'repetidas');
        return;
    }
    if (modo === 'gps_equipos') {
        const e = equiposH[0];
        if (e && typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('gps', e.interno);
        return;
    }
    if (modo === 'tabla_mes') {
        const e = equiposH.find(x => x.anio && x.mes) || equiposH[0];
        if (e && typeof window.abrirTablaConBusqueda === 'function') {
            window.abrirTablaConBusqueda('carga', e.interno, 'id', e.anio ? { anio: e.anio, mes: e.mes } : null);
        }
        return;
    }

    const filaDe = (interno) => analisis.filas.find(f => f.equipo.interno === interno);
    const periodoDe = (fecha) => {
        const [a, m] = String(fecha || '').split('-');
        return { anio: a, mes: String(Number(m)) };
    };

    let titulo = 'Registros a corregir';
    let intro = '';
    let grupos = [];

    if (modo === 'duplicadas') {
        titulo = 'Cargas repetidas';
        intro = 'Se agrupan las cargas del mismo equipo con la <strong>misma fecha y los mismos litros</strong>. Dos filas iguales casi siempre son la misma carga cargada dos veces, o un archivo del mes subido dos veces. Confirmá contra el comprobante antes de borrar nada en la planilla.';
        equiposH.forEach(eq => {
            const f = filaDe(eq.interno);
            if (!f) return;
            const porClave = new Map();
            (f.cargas || []).forEach(c => {
                const k = `${c.fecha}|${Math.round((parseFloat(c.litros) || 0) * 10)}`;
                if (!porClave.has(k)) porClave.set(k, []);
                porClave.get(k).push(c);
            });
            const dups = [...porClave.values()].filter(v => v.length > 1);
            if (dups.length) grupos.push({ interno: eq.interno, denominacion: eq.denominacion, sub: `${dups.length} grupo${dups.length === 1 ? '' : 's'} de cargas idénticas`, filas: dups.flat(), marcarDup: true });
        });
    } else if (modo === 'no_habiles') {
        titulo = 'Cargas fuera de días hábiles';
        intro = 'Cargas registradas en <strong>sábado, domingo o feriado</strong>. Si el equipo realmente trabajó (guardia, obra con plazo), está bien y el hallazgo se puede ignorar; si no, la fecha de la carga está mal tipeada.';
        equiposH.forEach(eq => {
            const f = filaDe(eq.interno);
            if (!f) return;
            const raras = (f.cargas || []).filter(c => c.fecha && !esDiaHabil(c.fecha));
            if (raras.length) grupos.push({ interno: eq.interno, denominacion: eq.denominacion, sub: `${raras.length} carga${raras.length === 1 ? '' : 's'} en fin de semana o feriado`, filas: raras, marcarNoHabil: true });
        });
    } else if (modo === 'sectores') {
        titulo = 'Cargas por sector y chofer';
        intro = 'Si a un equipo le aparecen cargas de sectores o choferes que no son los suyos, lo más probable es que sean cargas de <strong>otro equipo imputadas acá por un error de tipeo en el interno</strong>. Comparalo contra el maestro.';
        equiposH.forEach(eq => {
            const f = filaDe(eq.interno);
            if (!f || !(f.cargas || []).length) return;
            grupos.push({ interno: eq.interno, denominacion: eq.denominacion, sub: `${f.cargas.length} cargas en el período`, filas: [...f.cargas].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))), verMaestro: true });
        });
    } else if (modo === 'cargas_equipos') {
        titulo = 'Cargas de estos equipos';
        intro = 'Todas las cargas registradas, para buscar litros mal tipeados: un cero de más en una sola fila alcanza para desarmar el promedio de todo el período.';
        equiposH.forEach(eq => {
            const f = filaDe(eq.interno);
            if (!f || !(f.cargas || []).length) return;
            const litros = f.cargas.map(c => parseFloat(c.litros) || 0);
            const max = Math.max(...litros);
            // mediana() importada de diagnostico.js, no una copia local: la carga "típica" que
            // se muestra acá se compara a ojo contra la mayor de la lista para detectar un
            // litraje mal tipeado, y tiene que ser la misma mediana que usa el resto de la app.
            const med = mediana(litros);
            grupos.push({ interno: eq.interno, denominacion: eq.denominacion, sub: `${f.cargas.length} cargas · mayor ${nf(max, 1)} L · típica ${nf(med, 1)} L`, filas: [...f.cargas].sort((a, b) => (parseFloat(b.litros) || 0) - (parseFloat(a.litros) || 0)) });
        });
    } else if (modo === 'metas' || modo === 'pocos_datos' || modo === 'equipos' || modo.startsWith('causa:')) {
        const causaFiltro = modo.startsWith('causa:') ? modo.split(':')[1] : null;
        titulo = modo === 'pocos_datos' ? 'Equipos con pocos datos'
            : causaFiltro ? 'Equipos con ese síntoma'
            : modo === 'equipos' ? 'Equipos de este hallazgo' : 'Metas: valor actual y sugerido';
        intro = modo === 'pocos_datos'
            ? 'Con una o dos cargas cualquier promedio es frágil. Antes de tocar la meta, confirmá que no falten cargas del período sin registrar en la planilla.'
            : causaFiltro ? 'Los equipos del hallazgo cuya causa probable coincide con ese síntoma.'
            : 'Para cada equipo: qué meta tiene cargada hoy y qué valor sugiere la app a partir de sus pares medidos o de su propio consumo real. El cambio se aplica desde la ficha del equipo.';
        const equipos = equiposH.filter(e => {
            if (causaFiltro) return e.causa === causaFiltro;
            if (modo === 'pocos_datos') return e.completitud === 'bajo' || e.causa === 'pocos_datos';
            return true;
        });
        grupos = [{ interno: null, filas: [], equipos }];
    }

    const modalId = 'modal-registros';
    document.getElementById(modalId)?.remove();

    const formasDeCorregir = (interno, periodo) => `
        <div class="reg-formas">
            <button class="btn-xs btn-reg-tabla" data-interno="${esc(interno)}" ${periodo ? `data-anio="${esc(periodo.anio)}" data-mes="${esc(periodo.mes)}"` : ''}><i class="fa-solid fa-table-list"></i> ${periodo ? 'Abrir la tabla en ese mes' : 'Ver sus cargas en la tabla'}</button>
            <button class="btn-xs btn-reg-equipo" data-interno="${esc(interno)}"><i class="fa-solid fa-id-card"></i> Abrir la ficha del equipo</button>
            <button class="btn-xs btn-reg-maestro" data-interno="${esc(interno)}"><i class="fa-solid fa-list"></i> Ver en el maestro</button>
            <button class="btn-xs btn-reg-atendido" data-interno="${esc(interno)}"><i class="fa-solid fa-check"></i> Marcar como atendido</button>
        </div>`;

    let cuerpo;
    if (modo === 'metas' || modo === 'pocos_datos' || modo === 'equipos' || modo.startsWith('causa:')) {
        const equipos = grupos[0] ? grupos[0].equipos : [];
        cuerpo = equipos.length ? equipos.map(e => {
            const f = filaDe(e.interno);
            const sug = f ? (sugerirMeta(f, analisis.filas) || metaDesdeConsumoRealLocal(f)) : null;
            const metaAct = f && f.confirmed && f.confirmed.valor ? `${nf(f.confirmed.valor, 2)} ${esc(f.metrics.tipo_calculo)}` : 'sin meta cargada';
            return `<div class="reg-grupo">
                <h4 class="reg-grupo-head"><strong style="color:var(--accent-cyan)">${esc(e.interno)}</strong> <small>${esc(e.denominacion || '')}</small></h4>
                <p class="reg-nota">${esc(e.texto || '')} — ${esc(e.sub || '')}</p>
                <p class="reg-nota">Meta cargada hoy: <strong>${metaAct}</strong>${sug ? ` · sugerido: <strong>${nf(sug.valor, 2)}</strong> <small>(${esc(sug.base)})</small>` : ''}</p>
                ${formasDeCorregir(e.interno, null)}
            </div>`;
        }).join('') : '<p class="reg-vacio">No quedan equipos en este hallazgo con ese síntoma: puede que ya se hayan corregido.</p>';
    } else {
        cuerpo = grupos.length ? grupos.map(g => `
            <div class="reg-grupo">
                <h4 class="reg-grupo-head"><strong style="color:var(--accent-cyan)">${esc(g.interno)}</strong> <small>${esc(g.denominacion || '')} · ${esc(g.sub || '')}</small></h4>
                <div class="table-responsive">
                    <table class="data-table reg-tabla">
                        <thead><tr><th>Fecha</th><th>Litros</th><th>Importe</th><th>Sector</th><th>Chofer</th><th>Lugar</th><th></th></tr></thead>
                        <tbody>
                            ${g.filas.slice(0, 40).map(c => {
                                const noHabil = c.fecha && !esDiaHabil(c.fecha);
                                const marca = g.marcarNoHabil && noHabil ? (esFeriado(c.fecha) ? 'feriado' : 'fin de semana') : '';
                                return `<tr class="${g.marcarDup ? 'reg-dup' : ''}">
                                    <td>${esc(c.fecha || '—')}</td>
                                    <td>${nf(parseFloat(c.litros) || 0, 1)}</td>
                                    <td>${c.importe ? '$' + nf(parseFloat(c.importe) || 0) : '—'}</td>
                                    <td>${esc(c.sector || '—')}</td>
                                    <td>${esc(c.chofer || '—')}</td>
                                    <td>${esc(c.lugar_carga || '—')}</td>
                                    <td>${marca ? `<span class="fs-flag">${esc(marca)}</span>` : ''}</td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
                ${g.filas.length > 40 ? `<p class="reg-nota">Se muestran las primeras 40 de ${g.filas.length}. El resto está en la tabla de cargas.</p>` : ''}
                ${formasDeCorregir(g.interno, g.filas[0] ? periodoDe(g.filas[0].fecha) : null)}
            </div>`).join('')
        : `<p class="reg-vacio">No se encontraron registros con ese patrón en los equipos de este hallazgo. Eso ya es información: descarta esa causa y conviene mirar las otras del listado de consejos.</p>`;
    }

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>${esc(titulo)}</h2>
                    <p class="modal-sub">Registros concretos y varias formas de corregirlos.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    ${intro ? `<p class="reg-intro">${intro}</p>` : ''}
                    ${cuerpo}
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });
    modal.querySelectorAll('.btn-reg-tabla').forEach(b => b.addEventListener('click', () => {
        cerrar();
        const { interno, anio, mes } = b.dataset;
        if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', interno, 'id', anio ? { anio, mes } : null);
    }));
    modal.querySelectorAll('.btn-reg-equipo').forEach(b => b.addEventListener('click', () => { cerrar(); buscarEquipo(b.dataset.interno); }));
    modal.querySelectorAll('.btn-reg-maestro').forEach(b => b.addEventListener('click', () => {
        cerrar();
        if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('maestro', b.dataset.interno);
    }));
    modal.querySelectorAll('.btn-reg-investigar').forEach(b => b.addEventListener('click', () => { cerrar(); abrirInvestigacionMeta(b.dataset.interno); }));
    modal.querySelectorAll('.btn-reg-atendido').forEach(b => b.addEventListener('click', () => {
        marcarAtendido(hallazgoId, b.dataset.interno, 'revisado desde consejos');
        b.innerHTML = '<i class="fa-solid fa-check-double"></i> Atendido';
        b.disabled = true;
        renderDiagnostico(analisis, datosCrudos?.rawRecords || []);
    }));
}

/** Meta implícita a partir del propio consumo real, sin depender de pares. */
function metaDesdeConsumoRealLocal(fila) {
    const m = fila.metrics;
    if (!m.consumo_real || m.consumo_real <= 0) return null;
    return { valor: Math.round(m.consumo_real * 100) / 100, base: `consumo real medido sobre ${m.cantidad_cargas} cargas` };
}


/**
 * "Revisar y decidir": la pantalla donde se resuelve, de una vez, qué pasa con un equipo que
 * tiene datos de solo una parte del período. Muestra mes a mes qué llegó (y qué llegó en cero,
 * que ya no se cuenta) y ofrece las tres salidas reales: era de la otra provincia y hay que
 * marcarlo como tal, hay que apartarlo del análisis por otro motivo, o está bien así.
 */
function abrirRevisionParciales(analisis, rawRecords) {
    const container = document.getElementById('modals-container');
    if (!container || !analisis) return;
    const modalId = 'modal-parciales';
    document.getElementById(modalId)?.remove();

    const periodo = { desde: analisis.totales.periodo_desde, hasta: analisis.totales.periodo_hasta };
    const items = (analisis.filas || [])
        .filter(f => f.metrics.cantidad_cargas > 0 || f.metrics.cantidad_gps > 0)
        .map(f => ({ fila: f, cob: coberturaMensual(f, periodo) }))
        .filter(x => x.cob.parcial)
        .sort((a, b) => a.cob.conDatos - b.cob.conDatos || b.fila.metrics.total_litros - a.fila.metrics.total_litros);

    // Cuántas filas en cero traía cada equipo: es la prueba de que el equipo figuraba en la
    // planilla pero sin nada adentro, que es distinto de no figurar.
    const vaciosPorInterno = new Map();
    (rawRecords || []).forEach(r => {
        if (!registroVacio(r)) return;
        const k = r.interno_key || r.interno;
        if (!k) return;
        vaciosPorInterno.set(k, (vaciosPorInterno.get(k) || 0) + 1);
    });

    const excluidosMap = new Map(equiposExcluidosCache.map(e => [e.interno, e]));

    const bloques = items.map(({ fila, cob }) => {
        const interno = fila.equipo.interno;
        const ex = excluidosMap.get(interno);
        const meses = evolucionMensual(fila);
        const esHora = fila.metrics.tipo_calculo === 'L/Hora';
        const vacios = vaciosPorInterno.get(interno) || vaciosPorInterno.get(fila.equipo.interno_key) || 0;
        return `
        <div class="par-bloque ${ex ? 'par-excluido' : ''}" data-interno="${esc(interno)}">
            <div class="par-head">
                <strong>${esc(interno)}</strong> <small>${esc(fila.equipo.denominacion || '')}</small>
                <span class="fs-chip">${cob.conDatos} de ${cob.mesesPeriodo} meses con datos</span>
                <label class="par-prov">
                    <span>Provincia:</span>
                    <select class="par-prov-sel" data-interno="${esc(interno)}" title="Se guarda en el maestro de equipos. Es el dato que separa 'no reporta porque se fue a la otra provincia' de 'no anda'.">
                        <option value="" ${!fila.equipo.provincia || fila.equipo.provincia === 'SIN DATO' ? 'selected' : ''}>sin asignar</option>
                        <option value="MENDOZA" ${fila.equipo.provincia === 'MENDOZA' ? 'selected' : ''}>MENDOZA</option>
                        <option value="SAN JUAN" ${fila.equipo.provincia === 'SAN JUAN' ? 'selected' : ''}>SAN JUAN</option>
                    </select>
                </label>
                ${vacios ? `<span class="fs-chip fs-chip-causa">${vacios} fila${vacios === 1 ? '' : 's'} en cero descartada${vacios === 1 ? '' : 's'}</span>` : ''}
                ${ex ? `<span class="par-chip-excluido"><i class="fa-solid fa-ban"></i> apartado: ${esc(ex.motivo || 'sin motivo')}</span>` : ''}
            </div>
            <div class="table-responsive">
                <table class="data-table fs-tabla">
                    <thead><tr><th>Mes</th><th>Litros</th><th>${esHora ? 'hs trabajadas' : 'km'}</th><th>hs parado</th><th>Cargas</th><th></th></tr></thead>
                    <tbody>
                        ${meses.length ? meses.map(m => `<tr>
                            <td>${esc(m.periodo)}</td>
                            <td>${nf(m.litros, 1)}</td>
                            <td>${nf(m.factor, 1)}</td>
                            <td>${nf(m.parado || 0, 1)}</td>
                            <td>${nf(m.cargas)}</td>
                            <td>${m.litros <= 0 && m.factor <= 0 ? `<span class="fs-flag">${(m.parado || 0) > 0 ? 'el GPS reportó: quieto' : 'sin dato'}</span>` : ''}</td>
                        </tr>`).join('') : '<tr><td colspan="6">Sin meses con datos útiles.</td></tr>'}
                    </tbody>
                </table>
            </div>
            <p class="reg-nota">${vacios
                ? `Figuraba en las planillas de los otros meses, pero esas filas venían en cero (0 km, 0 hs): eso no es "trabajó cero", es "no hay dato de ese mes". Ya no se cuentan.`
                : `En los meses que faltan directamente no aparece en las planillas.`}</p>
            <div class="par-acciones">
                ${ex
                    ? `<button class="btn-xs btn-par-reactivar" data-interno="${esc(interno)}"><i class="fa-solid fa-rotate-left"></i> Volver a incluirlo en el análisis</button>`
                    : `<button class="btn-xs btn-par-sanjuan" data-interno="${esc(interno)}" title="Marca la provincia del equipo como SAN JUAN en el maestro y lo aparta del análisis: no está fallando, no se lo está midiendo en estos archivos"><i class="fa-solid fa-location-dot"></i> Es de San Juan: marcar y apartar</button>
                       <button class="btn-xs btn-par-excluir" data-interno="${esc(interno)}" title="Apartarlo del análisis por otro motivo (baja, sin GPS, alquilado…)"><i class="fa-solid fa-ban"></i> Apartar por otro motivo</button>`}
                <button class="btn-xs btn-par-equipo" data-interno="${esc(interno)}"><i class="fa-solid fa-id-card"></i> Ver la ficha</button>
                <button class="btn-xs btn-par-gps" data-interno="${esc(interno)}"><i class="fa-solid fa-satellite-dish"></i> Ver sus filas de GPS</button>
                <button class="btn-xs btn-par-meta" data-interno="${esc(interno)}"><i class="fa-solid fa-magnifying-glass-chart"></i> Investigar su meta</button>
                <button class="btn-xs btn-par-seguir" data-interno="${esc(interno)}"><i class="fa-solid fa-eye"></i> Marcar para seguimiento</button>
                <button class="btn-xs btn-par-ok" data-interno="${esc(interno)}" title="Los datos son correctos: el equipo trabajó solo esos meses"><i class="fa-solid fa-check"></i> Está bien así</button>
            </div>
        </div>`;
    }).join('');

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Equipos con datos de solo una parte del período</h2>
                    <p class="modal-sub">Las filas del GPS en cero ya se descartan del cálculo. Lo que falta decidir es si el equipo dejó de reportar acá o si realmente trabajó solo esos meses.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    ${excluidosMap.size ? `<p class="reg-nota" style="margin-bottom:0.8rem">${excluidosMap.size} equipo${excluidosMap.size === 1 ? '' : 's'} ya apartado${excluidosMap.size === 1 ? '' : 's'} del análisis: ${[...excluidosMap.keys()].map(esc).join(', ')}.</p>` : ''}
                    ${bloques || '<p class="reg-vacio">Ningún equipo tiene datos parciales con el período cargado.</p>'}
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    const refrescar = async () => { equiposExcluidosCache = await getEquiposExcluidos(); cerrar(); await renderPanel(); abrirRevisionParciales(ultimoAnalisis, datosCrudos?.rawRecords || []); };
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });

    modal.querySelectorAll('.btn-par-sanjuan').forEach(b => b.addEventListener('click', async () => {
        const interno = b.dataset.interno;
        const fila = analisis.filas.find(f => f.equipo.interno === interno);
        if (fila) {
            const eq = { ...fila.equipo, ubicacion: 'SAN JUAN' };
            eq.editado_manual = [...new Set([...(eq.editado_manual || []), 'ubicacion'])];
            await updateEquipo(eq);
        }
        await setEquipoExcluido(interno, 'opera en San Juan: no reporta en estos archivos', 'SAN JUAN');
        await refrescar();
    }));
    modal.querySelectorAll('.btn-par-excluir').forEach(b => b.addEventListener('click', async () => {
        const motivo = prompt('¿Por qué se aparta este equipo del análisis?\n(ej. de baja, alquilado, sin GPS instalado, en reparación)', 'sin GPS reportando en estos archivos');
        if (motivo === null) return;
        await setEquipoExcluido(b.dataset.interno, motivo.trim() || 'apartado a mano', '');
        await refrescar();
    }));
    modal.querySelectorAll('.btn-par-reactivar').forEach(b => b.addEventListener('click', async () => {
        await quitarEquipoExcluido(b.dataset.interno);
        await refrescar();
    }));
    modal.querySelectorAll('.btn-par-ok').forEach(b => b.addEventListener('click', () => {
        marcarAtendido('datos_parciales', b.dataset.interno, 'datos correctos');
        b.innerHTML = '<i class="fa-solid fa-check-double"></i> Marcado';
        b.disabled = true;
        renderDiagnostico(analisis, rawRecords);
    }));
    modal.querySelectorAll('.btn-par-equipo').forEach(b => b.addEventListener('click', () => { cerrar(); buscarEquipo(b.dataset.interno); }));
    modal.querySelectorAll('.btn-par-gps').forEach(b => b.addEventListener('click', () => {
        cerrar();
        if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('gps', b.dataset.interno);
    }));
    modal.querySelectorAll('.btn-par-meta').forEach(b => b.addEventListener('click', () => { cerrar(); abrirInvestigacionMeta(b.dataset.interno); }));
    modal.querySelectorAll('.btn-par-seguir').forEach(b => b.addEventListener('click', async () => {
        const interno = b.dataset.interno;
        const per = periodoDeAnalisis(analisis);
        await setRalentiEstado(interno, 'seguimiento', '', per);
        ralentiEstadosCache = ralentiEstadosCache.filter(r => r.interno !== interno).concat([{ interno, estado: 'seguimiento', periodo: per }]);
        if (!diagSeguimiento.has('datos_parciales')) diagSeguimiento.set('datos_parciales', new Set());
        diagSeguimiento.get('datos_parciales').add(interno);
        marcarAtendido('datos_parciales', interno, 'en seguimiento');
        b.innerHTML = '<i class="fa-solid fa-check-double"></i> En seguimiento';
        b.disabled = true;
        renderDiagnostico(analisis, rawRecords);
    }));
    // Provincia editable ahí mismo: se avisaba "sin provincia en el padrón" y había que salir a
    // la tabla del maestro a cargarla, perdiendo el contexto de lo que se estaba decidiendo.
    modal.querySelectorAll('.par-prov-sel').forEach(sel => sel.addEventListener('change', async () => {
        const interno = sel.dataset.interno;
        const f = analisis.filas.find(x => x.equipo.interno === interno);
        if (!f) return;
        const eq = { ...f.equipo, ubicacion: sel.value || '' };
        eq.editado_manual = [...new Set([...(eq.editado_manual || []), 'ubicacion'])];
        await updateEquipo(eq);
        sel.classList.add('par-prov-guardada');
        sel.title = 'Guardado en el maestro de equipos.';
    }));
}


/**
 * "¿Cómo lo resuelvo?": para cada equipo del hallazgo, qué escenario es y qué corresponde hacer,
 * con la acción ya elegida. Se puede aplicar de a uno, o todo junto con "Aplicar lo sugerido"
 * — que es la corrección masiva que faltaba: en vez de un botón que hace lo mismo con todos,
 * aplica a cada equipo LO QUE LE CORRESPONDE (a uno aceptable, a otro reclamo, a otro seguimiento).
 */
function abrirResolucion(hallazgoId, analisis, rawRecords) {
    const container = document.getElementById('modals-container');
    if (!container || !analisis) return;
    const modalId = 'modal-resolucion';
    document.getElementById(modalId)?.remove();

    const h = generarDiagnostico(analisis.filas, analisis.totales, rawRecords, ralentiEstadosCache, noFlotaAceptadosCache, equiposExcluidosCache, extraDiag())
        .find(x => x.id === hallazgoId);
    if (!h) return;

    // Se resuelve sobre TODOS los equipos del hallazgo, no solo los 10 que la tarjeta lista:
    // "aplicar lo sugerido" sobre una décima parte del problema no es una corrección masiva.
    const porInterno = new Map((h.equipos || []).map(e => [e.interno, e]));
    const internos = (h.internos_todos && h.internos_todos.length) ? h.internos_todos : [...porInterno.keys()];
    const filas = internos.map(interno => {
        const f = analisis.filas.find(x => x.equipo.interno === interno);
        if (!f) return null;
        const eq = porInterno.get(interno) || { interno, denominacion: f.equipo.denominacion };
        return { eq, fila: f, res: resolverEquipo(hallazgoId, f, analisis.filas) };
    }).filter(x => x && x.res);

    const ICONO = { aceptar: 'fa-check', reclamo: 'fa-satellite-dish', seguimiento: 'fa-eye', meta: 'fa-bullseye', excluir: 'fa-ban', tabla: 'fa-table-list' };
    const porAccion = new Map();
    filas.forEach(x => porAccion.set(x.res.accion, (porAccion.get(x.res.accion) || 0) + 1));
    const resumen = [...porAccion.entries()].map(([a, n]) => `${n} → ${({ aceptar: 'marcar aceptable', reclamo: 'reclamo GPS', seguimiento: 'seguimiento', meta: 'cargar meta', excluir: 'apartar', tabla: 'revisar en la tabla' })[a] || a}`).join(' · ');

    const cuerpo = filas.length ? `
        <p class="reg-intro">Cada equipo se mira por separado y se propone <strong>lo que le corresponde a ese caso</strong>, no lo mismo para todos: ${esc(resumen)}.</p>
        <div class="table-responsive">
            <table class="data-table res-tabla">
                <thead><tr><th>Equipo</th><th>Situación</th><th>Qué corresponde hacer</th><th></th></tr></thead>
                <tbody>
                    ${filas.map(x => `<tr data-interno="${esc(x.eq.interno)}">
                        <td><strong style="color:var(--accent-cyan)">${esc(x.eq.interno)}</strong><br><small style="color:var(--text-muted)">${esc(x.eq.denominacion || '')}</small></td>
                        <td><span class="seg-badge ${x.res.accion === 'aceptar' ? 'seg-ok' : x.res.accion === 'reclamo' ? 'seg-alta' : 'seg-media'}">${esc(x.res.etiqueta)}</span></td>
                        <td>${esc(x.res.veredicto)}</td>
                        <td><button class="btn-xs btn-res-aplicar" data-interno="${esc(x.eq.interno)}" data-accion="${esc(x.res.accion)}"><i class="fa-solid ${ICONO[x.res.accion] || 'fa-play'}"></i> ${esc(x.res.textoAccion)}</button></td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>
        <div class="res-bulk">
            <button class="btn-xs btn-res-todos"><i class="fa-solid fa-wand-magic-sparkles"></i> Aplicar lo sugerido a los ${filas.length}</button>
            <span class="reg-nota">Se aplica a cada equipo su propia acción. Todo es reversible: lo aceptado se puede desmarcar y lo apartado se puede volver a incluir.</span>
        </div>`
        : '<p class="reg-vacio">No quedan equipos con acción pendiente en este hallazgo.</p>';

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Cómo resolver: ${esc(h.titulo)}</h2>
                    <p class="modal-sub">Un veredicto por equipo, con la acción que le corresponde.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">${cuerpo}</div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });

    const aplicar = async (interno, accion) => {
        const per = periodoDeAnalisis(analisis);
        if (accion === 'aceptar') {
            await setRalentiEstado(interno, 'aceptable', '', per);
            ralentiEstadosCache = ralentiEstadosCache.filter(r => r.interno !== interno).concat([{ interno, estado: 'aceptable', periodo: per }]);
            marcarAtendido(hallazgoId, interno, 'ralentí aceptable');
        } else if (accion === 'seguimiento') {
            await setRalentiEstado(interno, 'seguimiento', '', per);
            ralentiEstadosCache = ralentiEstadosCache.filter(r => r.interno !== interno).concat([{ interno, estado: 'seguimiento', periodo: per }]);
            if (!diagSeguimiento.has(hallazgoId)) diagSeguimiento.set(hallazgoId, new Set());
            diagSeguimiento.get(hallazgoId).add(interno);
            marcarAtendido(hallazgoId, interno, 'en seguimiento');
        } else if (accion === 'reclamo') {
            const x = filas.find(y => y.eq.interno === interno);
            await crearReclamoGPS({ interno, motivo: x ? x.res.veredicto : 'Revisión de equipo GPS' });
            marcarAtendido(hallazgoId, interno, 'reclamo GPS generado');
        } else if (accion === 'meta') {
            // Investigar de verdad: buscar el dato en las fuentes que existen, no solo llevar
            // al usuario a la ficha para que lo complete de memoria.
            cerrar(); abrirInvestigacionMeta(interno); return true;
        } else if (accion === 'tabla') {
            cerrar();
            if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', interno);
            return true;
        }
        return false;
    };

    modal.querySelectorAll('.btn-res-aplicar').forEach(b => b.addEventListener('click', async () => {
        const salio = await aplicar(b.dataset.interno, b.dataset.accion);
        if (salio) return;
        b.innerHTML = '<i class="fa-solid fa-check-double"></i> Hecho';
        b.disabled = true;
        renderDiagnostico(analisis, rawRecords);
    }));
    modal.querySelector('.btn-res-todos')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Aplicando…';
        for (const x of filas) {
            if (x.res.accion === 'meta' || x.res.accion === 'tabla') continue; // esos son navegación, no se pueden hacer en bloque
            await aplicar(x.eq.interno, x.res.accion);
        }
        cerrar();
        renderDiagnostico(analisis, rawRecords);
    });
}


/**
 * Completa los precios que quedaron en cero usando el precio del MISMO combustible en el MISMO
 * mes, comparando el nombre normalizado (sin espacios ni signos). Es exactamente lo que hace
 * falta cuando el cero viene de una diferencia de escritura: "YPF500" no matcheaba contra
 * "YPF 500" en la tabla de precios del sistema de origen y volvía en cero, pero el precio existe
 * y está en las otras cargas del mismo mes.
 *
 * No inventa nada: si para ese combustible y ese mes no hay ninguna carga con precio, la deja
 * como está y lo informa.
 */
async function completarPreciosFaltantes(analisis, rawRecords) {
    const soloLetras = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cargas = (rawRecords || []).filter(r => r.type === 'carga');
    const mesDe = (r) => r.periodo || (r.fecha ? String(r.fecha).slice(0, 7) : '');

    // Precio de referencia por (combustible normalizado + mes): la mediana de las cargas que sí
    // tienen precio. La mediana y no el promedio, para que una carga mal tipeada no lo mueva.
    const ref = new Map();
    cargas.forEach(c => {
        const pu = parseFloat(c.precio_unitario) || 0;
        if (pu <= 0) return;
        const k = `${soloLetras(c.combustible)}|${mesDe(c)}`;
        if (!ref.has(k)) ref.set(k, []);
        ref.get(k).push(pu);
    });
    // mediana() se importa de diagnostico.js: la copia local que había acá devolvía el valor
    // de arriba con una cantidad par de precios en vez del promedio de los dos del medio.

    const pendientes = cargas.filter(c => (parseFloat(c.litros) || 0) > 0 &&
        ((parseFloat(c.importe) || 0) <= 0 || (parseFloat(c.precio_unitario) || 0) <= 0));
    if (!pendientes.length) { alert('No quedan cargas sin valorizar.'); return; }

    const plan = [];
    const sinReferencia = [];
    pendientes.forEach(c => {
        const k = `${soloLetras(c.combustible)}|${mesDe(c)}`;
        const vals = ref.get(k);
        if (!vals || !vals.length) { sinReferencia.push(c); return; }
        const precio = mediana(vals);
        const litros = parseFloat(c.litros) || 0;
        plan.push({ registro: c, precio, importe: Math.round(precio * litros * 100) / 100, litros });
    });

    if (!plan.length) {
        alert(`No se pudo completar ninguna: para ese combustible y ese mes no hay ninguna otra carga con precio cargado.\n\n${sinReferencia.length} cargas quedan sin valorizar.`);
        return;
    }
    const totalNuevo = plan.reduce((s, x) => s + x.importe, 0);
    const detalle = [...new Set(plan.map(x => `${x.registro.combustible || 'sin tipo'} ${mesDe(x.registro)}: $${nf(x.precio, 2)}/L`))].slice(0, 6).join('\n');
    const ok = confirm(
        `Completar ${plan.length} carga${plan.length === 1 ? '' : 's'} sin valorizar (${nf(plan.reduce((s, x) => s + x.litros, 0), 1)} L).\n\n` +
        `Precio tomado de las otras cargas del mismo combustible y el mismo mes:\n${detalle}\n\n` +
        `Se van a sumar $${nf(totalNuevo)} al gasto del período.\n` +
        (sinReferencia.length ? `\n${sinReferencia.length} quedan sin completar por falta de referencia.\n` : '') +
        `\nLa corrección queda guardada y se vuelve a aplicar si reimportás el archivo.`
    );
    if (!ok) return;

    for (const x of plan) {
        await updateRawRecord(x.registro.id, { precio_unitario: x.precio, importe: x.importe, _precio_completado: true });
        // Y además como corrección persistente: los movimientos se limpian al iniciar la app, así
        // que sin esto el trabajo se perdía en cuanto se volvía a subir la planilla.
        await saveCorreccionCarga({
            huella: huellaCarga(x.registro), accion: 'valorizar',
            precio_unitario_correcto: x.precio, importe_correcto: x.importe,
            interno_original: x.registro.interno || '',
            fecha: x.registro.fecha, litros: x.registro.litros, importe: x.importe,
            observacion: `Precio completado desde otras cargas de ${x.registro.combustible || 'ese combustible'} del mismo mes`
        });
        await registrarEdicion({
            tabla: 'carga', registroId: x.registro.id,
            etiqueta: `${x.registro.fecha || ''} · ${x.registro.interno || ''} · precio completado`,
            campo: 'Precio unitario', valorAnterior: '0', valorNuevo: String(x.precio)
        });
    }
    alert(`Listo: ${plan.length} cargas valorizadas por $${nf(totalNuevo)}.\n\nSe recalcula el panel.`);
    await renderPanel();
}


/**
 * "Investigar la meta": va a buscar el dato a las fuentes que existen y muestra de dónde sale
 * cada candidato, en orden de autoridad — el estimado oficial primero, la mediana de pares
 * última. Cada fuente se puede aplicar como meta con un click, incluso en equipos sin GPS, que
 * es lo que habilita el cálculo inverso.
 */
function abrirInvestigacionMeta(interno) {
    const container = document.getElementById('modals-container');
    if (!container || !ultimoAnalisis) return;
    const fila = ultimoAnalisis.filas.find(f => f.equipo.interno === interno);
    if (!fila) return;
    const inv = investigarMeta(fila, ultimoAnalisis.filas, datosCrudos?.estimados || []);

    const modalId = 'modal-investigar-meta';
    document.getElementById(modalId)?.remove();
    const CONF = { alta: ['seg-ok', 'confiable'], media: ['seg-media', 'razonable'], baja: ['seg-alta', 'usar con cuidado'] };

    const cuerpo = inv.faltanDatos ? `
        <div class="reg-vacio">
            <p><strong>No hay ninguna fuente interna para este equipo.</strong></p>
            <p style="margin-top:.5rem">No figura en "Consumos Estimados", no hay ningún equipo del mismo tipo en el padrón con meta cargada, no tiene potencia declarada y sin GPS tampoco se puede medir su consumo real.</p>
            <p style="margin-top:.5rem">El dato hay que conseguirlo afuera: el manual del fabricante (${esc(fila.equipo.marca || '')} ${esc(fila.equipo.modelo || '')}) o el área técnica. Cuando lo tengas, se carga en la ficha del equipo o en la planilla de Consumos Estimados.</p>
            <p style="margin-top:.5rem" class="reg-nota">Cargó ${nf(fila.metrics.total_litros, 1)} L en el período sobre ${nf(fila.metrics.cantidad_cargas)} carga${fila.metrics.cantidad_cargas === 1 ? '' : 's'}. Con una meta cargada, esos litros alcanzan para estimar cuántas horas debería haber trabajado.</p>
        </div>` : `
        ${inv.respaldo ? `<p class="fs-veredicto fs-ok"><i class="fa-solid fa-circle-check"></i> La meta que ya tiene (<strong>${nf(inv.metaActual, 2)}</strong>) coincide con <strong>${esc(inv.respaldo.fuente)}</strong>. Está bien: no hace falta cambiarla.</p>` : ''}
        <p class="reg-intro">Fuentes encontradas para este equipo, de mayor a menor autoridad. ${inv.metaActual ? `Meta cargada hoy: <strong>${nf(inv.metaActual, 2)} ${esc(fila.metrics.tipo_calculo)}</strong>.` : '<strong>Hoy no tiene meta cargada.</strong>'}</p>
        <div class="table-responsive">
            <table class="data-table res-tabla">
                <thead><tr><th>Fuente</th><th>Valor</th><th>De dónde sale</th><th></th></tr></thead>
                <tbody>
                    ${inv.fuentes.map(f => {
                        const [cls, txt] = CONF[f.confianza] || CONF.media;
                        return `<tr>
                            <td><strong>${esc(f.fuente)}</strong><br><span class="seg-badge ${cls}">${esc(txt)}</span></td>
                            <td><strong style="color:var(--accent-cyan)">${nf(f.valor, 2)}</strong><br><small style="color:var(--text-muted)">${esc(f.unidad || '')}</small></td>
                            <td>${esc(f.detalle)}</td>
                            <td><button class="btn-xs btn-inv-aplicar" data-interno="${esc(interno)}" data-valor="${f.valor}" data-unidad="${esc(f.unidad || fila.metrics.tipo_calculo)}" data-fuente="${esc(f.fuente)}"><i class="fa-solid fa-check"></i> Usar como meta</button></td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
        <p class="reg-nota">Aplicar una meta acá habilita el <strong>cálculo inverso</strong>: aunque el equipo no tenga GPS, con la meta y los litros cargados se estima cuánta actividad debería haber tenido.</p>`;

    // Investigación PROFUNDA: no releer lo que la app ya tiene (eso es lo de arriba), sino ir a
    // buscar afuera — el Asistente de Flota tiene la tool real "web_search" de Anthropic para
    // esto. Tiene más sentido cuanto menos fuentes internas hay, pero se ofrece siempre: incluso
    // con una meta interna confiable, sirve para contrastarla contra ficha técnica del fabricante.
    const promptInvestigacion =
        `Necesito investigación externa (no repitas lo que ya sabés de esta app, no tengo acceso a esos datos ahora) sobre el consumo de combustible esperable del equipo ${interno}` +
        `${fila.equipo.denominacion ? `, un ${fila.equipo.denominacion.toLowerCase()}` : ''}${fila.equipo.marca ? `, marca ${fila.equipo.marca}${fila.equipo.modelo ? ` modelo ${fila.equipo.modelo}` : ''}` : ''}${inv.potencia ? `, ${inv.potencia.valor} ${inv.potencia.unidad}` : ''}. ` +
        `Buscá en fuentes públicas (ficha técnica del fabricante, manuales, foros técnicos o comparativas de la industria) un rango de consumo típico en L/hora o L/100km según corresponda al tipo de equipo, y citá de dónde sacaste cada dato.`;

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Investigar la meta de ${esc(interno)}</h2>
                    <p class="modal-sub">${esc(fila.equipo.denominacion || '')}${fila.equipo.marca ? ` · ${esc(fila.equipo.marca)} ${esc(fila.equipo.modelo || '')}` : ''}${inv.potencia ? ` · ${inv.potencia.valor} ${inv.potencia.unidad}` : ' · sin potencia declarada'}</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">${cuerpo}
                    <div class="reg-nota" style="margin-top:1rem; padding-top:1rem; border-top:1px solid var(--border-color, #333)">
                        <p><i class="fa-solid fa-magnifying-glass-chart"></i> Todo lo de arriba sale de <strong>datos que ya están en la app</strong>. Para ir a buscar el dato afuera (ficha técnica del fabricante, foros técnicos) usá el Asistente de Flota:</p>
                        <button class="btn-secondary btn-sm" id="btn-inv-preguntar-asistente" style="margin-top:.5rem"><i class="fa-solid fa-robot"></i> Investigación profunda con el Asistente</button>
                    </div>
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });
    modal.querySelectorAll('.btn-inv-aplicar').forEach(b => b.addEventListener('click', async () => {
        const valor = parseFloat(b.dataset.valor);
        const unidad = b.dataset.unidad;
        if (!(valor > 0)) return;
        const metaAnterior = fila.equipo.meta_texto || '';
        const eq = { ...fila.equipo, meta_valor: valor, meta_unidad: unidad, meta_texto: `${valor} ${unidad === 'L/Hora' ? 'L/hora' : 'L/100km'}` };
        eq.editado_manual = [...new Set([...(eq.editado_manual || []), 'meta_valor', 'meta_unidad', 'meta_texto'])];
        await updateEquipo(eq);
        // Mismo gap que el ajuste masivo: sin esto, "Investigar meta → Usar como meta" protegía
        // el campo contra reimportación pero no dejaba rastro de fecha ni de qué fuente se usó.
        await registrarEdicion({
            tabla: 'maestro', registroId: eq.interno, etiqueta: eq.interno,
            campo: 'meta_valor', valorAnterior: metaAnterior, valorNuevo: `${eq.meta_texto} (${b.dataset.fuente || 'investigar meta'})`
        });
        cerrar();
        await renderPanel();
    }));
    document.getElementById('btn-inv-preguntar-asistente')?.addEventListener('click', () => {
        cerrar();
        if (typeof window.preguntarAsistente === 'function') window.preguntarAsistente(promptInvestigacion);
    });
}

/**
 * "Unificar variantes": revisa cada grupo de valores que la app detectó como probable variante
 * de escritura del mismo dato (espacio, guion, mayúscula de más — ver auditarCalidadCargas()) y
 * deja elegir, uno por uno, bajo qué forma quedan todas las cargas. A propósito NO se aplica
 * nada solo: cada grupo se aplica con un click explícito, y "Dejar como están" existe para el
 * caso legítimo de dos valores parecidos que en realidad son distintos.
 */
/**
 * Resolver cargas repetidas, separando lo que se puede corregir solo de lo que no.
 *
 * EXACTO significa exacto: mismo equipo, fecha, litros, importe, precio unitario, combustible,
 * lugar de carga, centro de costo y chofer. Dos cargas reales del mismo equipo el mismo día no
 * coinciden hasta el centavo y el décimo de litro — eso es la misma fila entrada dos veces, y
 * corregirlo no es una decisión de criterio: es sacar una copia. Por eso acá SÍ se corrige, en
 * bloque, con un botón.
 *
 * POSIBLE es otra cosa: coincide equipo + fecha + litros pero difiere algún otro campo. Puede ser
 * legítimo (dos cargas del mismo día en surtidores distintos, un precio corregido a mano). Eso
 * se muestra con el campo que difiere y se decide fila por fila.
 *
 * La corrección se guarda como acción 'dedupe' y NO como 'eliminar', a propósito: las dos filas
 * de un duplicado exacto tienen la MISMA huella, así que un 'eliminar' saltearía las dos al
 * reimportar y se perdería también la carga buena. 'dedupe' conserva la primera y descarta las
 * copias, y se vuelve a aplicar solo cada vez que se reimporta el archivo.
 */
function abrirCorregirDuplicados(rawRecords) {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const cal = auditarCalidadCargas(rawRecords);
    const exactos = cal.duplicadosExactos || [];
    const posibles = cal.duplicadosPosibles || [];
    if (!exactos.length && !posibles.length) { alert('No hay cargas repetidas para resolver.'); return; }

    const litrosEx = exactos.reduce((s, d) => s + (parseFloat(d.repetida.litros) || 0), 0);
    const costoEx = exactos.reduce((s, d) => s + (parseFloat(d.repetida.importe) || 0), 0);

    const modalId = 'modal-duplicados';
    document.getElementById(modalId)?.remove();
    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Cargas repetidas</h2>
                    <p class="modal-sub">${exactos.length} duplicado${exactos.length === 1 ? '' : 's'} exacto${exactos.length === 1 ? '' : 's'} (se corrigen solos) · ${posibles.length} posible${posibles.length === 1 ? '' : 's'} a decidir a mano.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    ${exactos.length ? `
                    <h4 class="consejo-sub"><i class="fa-solid fa-check-double"></i> Duplicados exactos — ${nf(litrosEx, 1)} L y $${nf(costoEx)} contados de más</h4>
                    <p class="modal-note">Coinciden en <strong>todos</strong> los campos: equipo, fecha, litros, importe, precio, combustible, lugar, centro de costo y chofer. Se conserva una de cada par y se descarta la copia. Es reversible desde el historial de correcciones, y se vuelve a aplicar solo si reimportás el archivo.</p>
                    <div style="margin:0.5rem 0 1rem">
                        <button class="btn-primary btn-sm" id="btn-dup-corregir-todos"><i class="fa-solid fa-check-double"></i> Corregir los ${exactos.length} duplicados exactos</button>
                    </div>
                    <table class="data-table">
                        <thead><tr><th>Equipo</th><th>Fecha</th><th>Litros</th><th>Importe</th><th>Lugar</th><th></th></tr></thead>
                        <tbody>
                            ${exactos.slice(0, 40).map((d, i) => `<tr data-idx="${i}">
                                <td class="cell-key">${esc(d.repetida.interno || d.repetida.dominio || '—')}</td>
                                <td>${esc(formatFechaAR(d.repetida.fecha))}</td>
                                <td class="cell-num">${nf(parseFloat(d.repetida.litros) || 0, 2)}</td>
                                <td class="cell-num">$${nf(parseFloat(d.repetida.importe) || 0)}</td>
                                <td>${esc(d.repetida.lugar_carga || '—')}</td>
                                <td><button class="btn-xs btn-dup-una" data-idx="${i}"><i class="fa-solid fa-check"></i> Corregir esta</button></td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                    ${exactos.length > 40 ? `<p class="modal-note">Se muestran 40 de ${exactos.length}; el botón de arriba las corrige todas.</p>` : ''}
                    ` : '<p class="modal-note">No hay duplicados exactos.</p>'}

                    ${posibles.length ? `
                    <h4 class="consejo-sub" style="margin-top:1.5rem"><i class="fa-solid fa-circle-question"></i> Posibles repetidas — a decidir a mano</h4>
                    <p class="modal-note">Coinciden en equipo, fecha y litros, pero difieren en algún otro campo — incluida la <strong>hora</strong> cuando la planilla la trae: dos cargas del mismo día con horarios bien separados son casi siempre dos eventos reales, no una repetida. Puede ser una carga repetida con un dato mal tipeado, o dos cargas legítimas del mismo día. <strong>La app no las toca:</strong> mirá el campo que difiere y resolvé desde la tabla de cargas si corresponde.</p>
                    <table class="data-table">
                        <thead><tr><th>Equipo</th><th>Fecha</th><th>Litros</th><th>Difiere en</th><th>Original</th><th>Repetida</th><th></th></tr></thead>
                        <tbody>
                            ${posibles.slice(0, 30).map(d => `<tr>
                                <td class="cell-key">${esc(d.repetida.interno || d.repetida.dominio || '—')}</td>
                                <td>${esc(formatFechaAR(d.repetida.fecha))}</td>
                                <td class="cell-num">${nf(parseFloat(d.repetida.litros) || 0, 2)}</td>
                                <td><strong>${esc(d.difieren.join(', '))}</strong></td>
                                <td><small>${esc(d.difieren.map(c => String(d.original[c] ?? '—')).join(' · '))}</small></td>
                                <td><small>${esc(d.difieren.map(c => String(d.repetida[c] ?? '—')).join(' · '))}</small></td>
                                <td><button class="btn-xs btn-dup-ver" data-interno="${esc(d.repetida.interno || d.repetida.dominio || '')}"><i class="fa-solid fa-table-list"></i> Ver</button></td>
                            </tr>`).join('')}
                        </tbody>
                    </table>` : ''}
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });

    const corregirUno = async (d) => {
        // Se borra la COPIA (d.repetida) y se conserva d.original. La corrección persistente va
        // por huella con acción 'dedupe' + cuántas conservar, porque las dos filas comparten huella.
        await deleteRawRecord(d.repetida.id);
        await saveCorreccionCarga({
            huella: huellaCarga(d.repetida), accion: 'dedupe', conservar: 1,
            interno_original: (d.repetida._interno_original ?? d.repetida.interno) || '',
            fecha: d.repetida.fecha, litros: d.repetida.litros, importe: d.repetida.importe,
            nota: 'duplicado exacto: se conserva una y se descarta la copia'
        });
        await registrarEdicion({
            tabla: 'carga', registroId: d.repetida.id,
            etiqueta: `${formatFechaAR(d.repetida.fecha)} · ${d.repetida.interno || d.repetida.dominio || ''}`,
            campo: 'Duplicado exacto', valorAnterior: `${d.repetida.litros} L duplicados`, valorNuevo: 'copia descartada'
        });
    };

    modal.querySelector('#btn-dup-corregir-todos')?.addEventListener('click', async () => {
        if (!confirm(`Se van a descartar ${exactos.length} copias exactas (${nf(litrosEx, 1)} L, $${nf(costoEx)}). Queda una carga de cada par. ¿Confirmás?`)) return;
        for (const d of exactos) await corregirUno(d);
        cerrar();
        alert(`Listo: ${exactos.length} duplicados exactos corregidos.`);
        await renderPanel();
    });

    modal.querySelectorAll('.btn-dup-una').forEach(b => b.addEventListener('click', async () => {
        const d = exactos[parseInt(b.dataset.idx, 10)];
        if (!d) return;
        await corregirUno(d);
        cerrar();
        await renderPanel();
        abrirCorregirDuplicados(datosCrudos?.rawRecords || []);
    }));

    modal.querySelectorAll('.btn-dup-ver').forEach(b => b.addEventListener('click', () => {
        cerrar();
        if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', b.dataset.interno);
    }));
}

function abrirUnificarVariantes(rawRecords) {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const cal = auditarCalidadCargas(rawRecords || []);
    const cargas = (rawRecords || []).filter(r => r.type === 'carga');

    const todosLosGrupos = [
        ...cal.variantes.map(v => ({ campo: 'combustible', etiqueta: 'Tipo de combustible', clave: v.clave, formas: v.formas })),
        ...cal.variantesCampos
    ];
    const grupos = todosLosGrupos.filter(g => !variantesIgnoradasCache.has(`${g.campo}|${g.clave}`));

    const modalId = 'modal-unificar-variantes';
    document.getElementById(modalId)?.remove();

    const cuerpo = !grupos.length ? `
        <div class="reg-vacio"><p><strong>No queda ningún grupo por revisar.</strong></p>
        <p style="margin-top:.5rem">${todosLosGrupos.length ? 'Los que había quedaron marcados como "son distintos" en esta sesión.' : 'No se detectó ningún valor con más de una forma de escritura en combustible, lugar de carga, centro de costo o chofer.'}</p></div>`
        : `
        <p class="reg-intro">Cada grupo junta valores que, sacando espacios, guiones y mayúsculas, quedan igual. Elegí la forma correcta y aplicá — o dejalos como están si en realidad son dos cosas distintas.</p>
        <div class="table-responsive">
            <table class="data-table res-tabla">
                <thead><tr><th>Campo</th><th>Formas encontradas</th><th>Unificar bajo</th><th></th></tr></thead>
                <tbody>
                    ${grupos.map((g, i) => `<tr data-campo="${esc(g.campo)}" data-clave="${esc(g.clave)}" data-idx="${i}">
                        <td><strong>${esc(g.etiqueta)}</strong></td>
                        <td>${g.formas.map(([f, n]) => `"${esc(f)}" <small style="color:var(--text-muted)">(${n})</small>`).join('<br>')}</td>
                        <td><select class="var-elegir">${g.formas.map(([f]) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select></td>
                        <td>
                            <button class="btn-xs btn-var-aplicar"><i class="fa-solid fa-check"></i> Unificar</button>
                            <button class="btn-xs btn-var-dejar" title="Son valores distintos, no juntar"><i class="fa-solid fa-xmark"></i> Dejar así</button>
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>
        <p class="reg-nota">Unificar guarda la corrección: si reimportás la misma planilla, se vuelve a aplicar sola.</p>`;

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Unificar variantes de escritura</h2>
                    <p class="modal-sub">${grupos.length} grupo${grupos.length === 1 ? '' : 's'} para revisar</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">${cuerpo}</div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });

    modal.querySelectorAll('.btn-var-dejar').forEach(b => b.addEventListener('click', () => {
        const tr = b.closest('tr');
        variantesIgnoradasCache.add(`${tr.dataset.campo}|${tr.dataset.clave}`);
        cerrar();
        abrirUnificarVariantes(rawRecords);
    }));

    modal.querySelectorAll('.btn-var-aplicar').forEach(b => b.addEventListener('click', async () => {
        const tr = b.closest('tr');
        const campo = tr.dataset.campo;
        const grupo = grupos[parseInt(tr.dataset.idx, 10)];
        const elegido = tr.querySelector('.var-elegir').value;
        const formasAUnificar = grupo.formas.map(([f]) => f).filter(f => f !== elegido);
        const afectadas = cargas.filter(c => formasAUnificar.includes(String(c[campo] || '').trim()));
        if (!afectadas.length) { cerrar(); return; }
        if (!confirm(`¿Unificar ${afectadas.length} carga${afectadas.length === 1 ? '' : 's'} bajo "${elegido}"?\n\nQueda guardado como corrección: se reaplica solo si reimportás la planilla.`)) return;

        b.disabled = true;
        for (const c of afectadas) {
            const valorAnterior = String(c[campo] || '');
            await updateRawRecord(c.id, { [campo]: elegido, _corregido: true });
            await saveCorreccionCarga({
                huella: huellaCarga(c), accion: 'enriquecer',
                [`${campo}_correcto`]: elegido,
                interno_original: c._interno_original ?? c.interno ?? '',
                fecha: c.fecha, litros: c.litros, importe: c.importe,
                observacion: `Variante de escritura unificada: "${valorAnterior}" → "${elegido}"`
            });
            await registrarEdicion({
                tabla: 'carga', registroId: c.id,
                etiqueta: `${c.fecha || ''} · ${c.interno || ''} · variante unificada`,
                campo, valorAnterior, valorNuevo: elegido
            });
        }
        cerrar();
        await renderPanel();
        alert(`Listo: ${afectadas.length} cargas unificadas bajo "${elegido}".`);
    }));
}

/**
 * "Códigos nuevos de Mendoza": revisa los prefijos que la app no supo nombrar (ver
 * detectarPrefijosNuevos en diagnostico.js) y ofrece darlos de alta "en serio" en la base
 * oficial — con nombre propio, no solo silenciados — o ignorarlos por ahora. A propósito no
 * hay ninguna acción automática: el usuario escribe la denominación y confirma cada prefijo.
 */
function abrirRevisionPrefijosNuevos(analisis, rawRecords) {
    const container = document.getElementById('modals-container');
    if (!container || !analisis) return;
    const grupos = detectarPrefijosNuevos(analisis.totales.huerfanos || [], rawRecords || [], prefijosOficialesCache)
        .filter(g => g.esMendoza && !prefijosIgnoradosCache.includes(g.prefijo));

    const modalId = 'modal-prefijos-nuevos';
    document.getElementById(modalId)?.remove();

    const cuerpo = !grupos.length ? `
        <div class="reg-vacio"><p><strong>No queda ningún prefijo nuevo de Mendoza por revisar.</strong></p></div>`
        : `
        <p class="reg-intro">Códigos con un prefijo que la app todavía no reconoce, y que cargan combustible con centro de costo de Mendoza. No son equipos de flota (sin km ni horas), pero sí gasto real: ponerles nombre los saca de "sin identificar" en toda la app.</p>
        <div class="table-responsive">
            <table class="data-table res-tabla">
                <thead><tr><th>Prefijo</th><th>Códigos</th><th>Datos</th><th>Denominación</th><th></th></tr></thead>
                <tbody>
                    ${grupos.map(g => `<tr data-prefijo="${esc(g.prefijo)}">
                        <td><strong style="color:var(--accent-cyan)">${esc(g.prefijo)}</strong></td>
                        <td>${esc(g.codigos.join(', '))}</td>
                        <td>${nf(g.litros, 1)} L · $${nf(g.costo)} · ${g.cargas} carga${g.cargas === 1 ? '' : 's'}<br><small style="color:var(--text-muted)">centro de costo ${esc(g.centro_costo || '—')}</small></td>
                        <td><input type="text" class="pref-denom" placeholder="ej: CALDERA" style="width:100%"></td>
                        <td>
                            <button class="btn-xs btn-pref-agregar"><i class="fa-solid fa-check"></i> Agregar</button>
                            <button class="btn-xs btn-pref-ignorar" title="No preguntar por este prefijo por ahora"><i class="fa-solid fa-xmark"></i> Ignorar</button>
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>
        <p class="reg-nota">Al agregar, TODOS los códigos de ese prefijo (los de hoy y los que aparezcan después) quedan con esa denominación en vez de figurar como "sin identificar".</p>`;

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Códigos nuevos de Mendoza</h2>
                    <p class="modal-sub">${grupos.length} prefijo${grupos.length === 1 ? '' : 's'} para revisar</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">${cuerpo}</div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });

    modal.querySelectorAll('.btn-pref-ignorar').forEach(b => b.addEventListener('click', () => {
        const prefijo = b.closest('tr').dataset.prefijo;
        prefijosIgnoradosCache = [...prefijosIgnoradosCache, prefijo];
        cerrar();
        abrirRevisionPrefijosNuevos(analisis, rawRecords);
    }));

    modal.querySelectorAll('.btn-pref-agregar').forEach(b => b.addEventListener('click', async () => {
        const tr = b.closest('tr');
        const prefijo = tr.dataset.prefijo;
        const denom = tr.querySelector('.pref-denom').value.trim().toUpperCase();
        if (!denom) { alert('Escribí una denominación antes de agregar (ej: CALDERA, LIMPIEZA).'); return; }
        await agregarPrefijoNoFlota(prefijo, denom, 'MENDOZA');
        prefijosOficialesCache = [...prefijosOficialesCache.filter(p => p.prefijo !== prefijo), { prefijo, denominacion: denom, provincia: 'MENDOZA' }];
        cerrar();
        await renderPanel();
        abrirRevisionPrefijosNuevos(ultimoAnalisis, datosCrudos?.rawRecords || []);
    }));
}

/**
 * Declarar a mano los km u horas de un equipo que no reporta GPS.
 *
 * Es la pieza que faltaba para cerrar el cálculo de los equipos "sin actividad medida": los
 * litros ya los tenemos (están en la planilla de cargas), lo que no tenemos es contra qué
 * dividirlos. Sin esto, un equipo con cargas y sin GPS mostraba "0,00 L/100km", que no es un
 * consumo bajo: es la ausencia de dato haciéndose pasar por una medición.
 *
 * Tres decisiones a propósito:
 *  - Se declara un RANGO (mínimo–máximo), no un número exacto. Nadie sabe los km de memoria; un
 *    rango honesto es más útil que una precisión inventada, y el cálculo usa el punto medio.
 *  - Se puede declarar por MES además de para todo el período, que es como se representa
 *    "temporada baja": enero-febrero 400 km, el resto 1.200, sin tener que promediar a mano.
 *  - Acepta VARIOS equipos de una (por grupo), porque la actividad típica de una camioneta o de
 *    un grupo electrógeno se estima igual para todos los de esa clase.
 */
function abrirActividadEstimada(internos, analisis) {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const lista = (Array.isArray(internos) ? internos : [internos]).filter(Boolean);
    if (!lista.length) { alert('No hay equipos para declarar actividad.'); return; }

    const filas = lista.map(i => (analisis?.filas || []).find(f => f.equipo.interno === i)).filter(Boolean);
    const unidadSugerida = filas.length && filas.every(f => f.metrics.tipo_calculo === 'L/Hora') ? 'horas' : 'km';
    const meses = rangoMesesPeriodo(analisis);

    const modalId = 'modal-actividad-estimada';
    document.getElementById(modalId)?.remove();
    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Declarar actividad estimada</h2>
                    <p class="modal-sub">${lista.length === 1 ? `Equipo <strong>${esc(lista[0])}</strong>` : `<strong>${lista.length} equipos</strong>: ${lista.slice(0, 8).map(esc).join(', ')}${lista.length > 8 ? '…' : ''}`}. Los litros ya están; lo que falta son los km u horas para poder calcular el consumo.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    <div class="act-form">
                        <label class="correc-field-label">Unidad</label>
                        <select id="act-unidad">
                            <option value="km" ${unidadSugerida === 'km' ? 'selected' : ''}>Kilómetros (da L/100km)</option>
                            <option value="horas" ${unidadSugerida === 'horas' ? 'selected' : ''}>Horas de motor (da L/hora)</option>
                        </select>
                        <label class="correc-field-label">Período</label>
                        <select id="act-periodo">
                            <option value="TODO">Todo el período analizado${meses.length ? ` (${meses.length} meses)` : ''}</option>
                            ${meses.map(m => `<option value="${m.k}">${esc(m.label)}</option>`).join('')}
                        </select>
                        <label class="correc-field-label">Temporada</label>
                        <select id="act-temporada">
                            <option value="normal">Normal</option>
                            <option value="baja">Temporada baja / baja producción</option>
                            <option value="alta">Temporada alta / pico</option>
                        </select>
                        <label class="correc-field-label" title="Declarar el total del semestre de memoria es imposible; lo natural es decir cuánto por día o por mes, y que la app lo multiplique">Cómo lo declarás</label>
                        <select id="act-base">
                            <option value="dia">Por día hábil (ej. trabaja 10 a 12 hs por día)</option>
                            <option value="mes" selected>Por mes (ej. carga 1 vez por mes, ~70 L)</option>
                            <option value="total">Total del período completo</option>
                        </select>
                        <label class="correc-field-label">Actividad estimada</label>
                        <div class="act-rango">
                            <input type="number" id="act-min" placeholder="mínimo" min="0" step="any">
                            <span>a</span>
                            <input type="number" id="act-max" placeholder="máximo" min="0" step="any">
                            <span id="act-unidad-txt">${unidadSugerida === 'horas' ? 'hs' : 'km'}</span>
                            <span class="act-por" id="act-por">por mes</span>
                        </div>
                        <label class="correc-field-label" title="Para equipos que cargan fuera de la empresa: la planilla solo ve algunas cargas, así que los litros registrados quedan cortos">Litros que carga <small>(opcional)</small></label>
                        <div class="act-rango">
                            <input type="number" id="act-lmin" placeholder="mínimo" min="0" step="any">
                            <span>a</span>
                            <input type="number" id="act-lmax" placeholder="máximo" min="0" step="any">
                            <span>L</span>
                            <span class="act-por" id="act-por-l">por mes</span>
                        </div>
                        <label class="correc-field-label">Nota (opcional)</label>
                        <input type="text" id="act-nota" placeholder="ej: recorrido fijo planta-obra, ida y vuelta diario">
                    </div>
                    ${lista.length > 1 ? `
                    <h4 class="consejo-sub" style="margin-top:1rem"><i class="fa-solid fa-sliders"></i> Por equipo <small>(no siempre es el mismo valor para todos)</small></h4>
                    <p class="modal-note">El rango de arriba se usa como valor por defecto. Completá una fila solo para el equipo que trabaja distinto — ej. <strong>GE04 con 6 hs/día</strong> mientras el resto del grupo hace 10.</p>
                    <table class="data-table">
                        <thead><tr><th>Equipo</th><th>Mínimo</th><th>Máximo</th></tr></thead>
                        <tbody>
                            ${lista.map(i => `<tr data-interno="${esc(i)}">
                                <td class="cell-key">${esc(i)}</td>
                                <td><input type="number" class="act-min-eq" min="0" step="any" placeholder="usar el de arriba"></td>
                                <td><input type="number" class="act-max-eq" min="0" step="any" placeholder="usar el de arriba"></td>
                            </tr>`).join('')}
                        </tbody>
                    </table>` : ''}
                    <p class="modal-note" id="act-preview"></p>
                    <div class="modal-actions" style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.75rem">
                        <button class="btn-secondary btn-sm" data-close>Cancelar</button>
                        <button class="btn-primary btn-sm" id="btn-act-guardar"><i class="fa-solid fa-floppy-disk"></i> Guardar para ${lista.length === 1 ? 'este equipo' : `los ${lista.length} equipos`}</button>
                    </div>
                    ${(() => {
                        const previas = actividadEstimadaCache.filter(a => lista.includes(a.interno));
                        if (!previas.length) return '';
                        return `<h4 class="consejo-sub" style="margin-top:1rem"><i class="fa-solid fa-clock-rotate-left"></i> Ya declarado</h4>
                        <table class="data-table"><thead><tr><th>Equipo</th><th>Período</th><th>Rango</th><th>Base</th><th></th></tr></thead><tbody>
                        ${previas.map(a => `<tr><td class="cell-key">${esc(a.interno)}</td><td>${esc(a.periodo)}</td>
                            <td class="cell-num">${a.valor_min > 0 ? `${nf(a.valor_min)}-${nf(a.valor_max)} ${esc(a.unidad === 'horas' ? 'hs' : 'km')}` : '—'}${a.litros_min > 0 ? `<br><small>${nf(a.litros_min)}-${nf(a.litros_max)} L</small>` : ''}</td>
                            <td>${esc(a.base === 'dia' ? 'por día hábil' : (a.base === 'mes' ? 'por mes' : 'total'))}<br><small>${esc(a.temporada || 'normal')}</small></td>
                            <td><button class="btn-xs btn-act-quitar" data-interno="${esc(a.interno)}" data-periodo="${esc(a.periodo)}"><i class="fa-solid fa-trash"></i></button></td></tr>`).join('')}
                        </tbody></table>`;
                    })()}
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });

    // Vista previa en vivo: muestra qué consumo daría con lo tecleado, para un equipo concreto.
    // Sirve de control de cordura antes de guardar — si da 45 L/100km en una camioneta, el
    // rango está mal y se ve en el momento, no tres pantallas después.
    const leerForm = () => ({
        unidad: modal.querySelector('#act-unidad').value,
        base: modal.querySelector('#act-base').value,
        periodo: modal.querySelector('#act-periodo').value,
        temporada: modal.querySelector('#act-temporada').value,
        valor_min: parseFloat(modal.querySelector('#act-min').value) || 0,
        valor_max: parseFloat(modal.querySelector('#act-max').value) || 0,
        litros_min: parseFloat(modal.querySelector('#act-lmin').value) || 0,
        litros_max: parseFloat(modal.querySelector('#act-lmax').value) || 0,
        nota: modal.querySelector('#act-nota').value.trim()
    });

    // Vista previa en vivo: corre EXACTAMENTE el mismo cálculo que después se va a guardar
    // (consumoDesdeActividadDeclarada, con la misma expansión por día/mes), no una fórmula
    // paralela. Si la vista previa y el resultado guardado pudieran diferir, la vista previa
    // no serviría para nada. Es el control de cordura: si una camioneta da 45 L/100km, el
    // rango está mal y se ve en el momento, no tres pantallas después.
    const preview = () => {
        const v = leerForm();
        modal.querySelector('#act-unidad-txt').textContent = v.unidad === 'horas' ? 'hs' : 'km';
        const porTxt = v.base === 'dia' ? 'por día hábil' : (v.base === 'mes' ? 'por mes' : 'en total');
        modal.querySelector('#act-por').textContent = porTxt;
        modal.querySelector('#act-por-l').textContent = porTxt;
        const f = filas[0];
        const el = modal.querySelector('#act-preview');
        if (!f || (v.valor_min <= 0 && v.valor_max <= 0 && v.litros_min <= 0 && v.litros_max <= 0)) {
            el.textContent = 'Cargá la actividad estimada (y los litros, si la planilla no ve todas las cargas) para ver qué consumo daría.';
            return;
        }
        const per = analisis?.totales ? { desde: analisis.totales.periodo_desde, hasta: analisis.totales.periodo_hasta } : null;
        const r = consumoDesdeActividadDeclarada(f, [{ interno: f.equipo.interno, ...v }], per);
        if (!r) { el.textContent = 'Con estos valores todavía no alcanza para calcular un consumo.'; return; }
        el.innerHTML =
            `Con esto, <strong>${esc(f.equipo.interno)}</strong> daría <strong>${nf(r.valor, 2)} ${r.unidad === 'L/Hora' ? 'L/hora' : 'L/100km'}</strong> — ${esc(r.base)}.` +
            (f.confirmed && f.confirmed.valor > 0
                ? ` Su meta actual es ${nf(f.confirmed.valor, 2)}${Math.abs(r.valor - f.confirmed.valor) / f.confirmed.valor > 0.5 ? ' <strong>— la diferencia es grande, revisá el rango antes de guardar.</strong>' : '.'}`
                : ' Todavía no tiene meta cargada.') +
            (r.litros_declarados ? `<br><small>Los litros declarados (${nf(r.litros, 1)} L) reemplazan a los ${nf(r.litros_registrados, 1)} L que ve la planilla: es el caso del equipo que carga fuera de la empresa.</small>` : '');
    };
    ['#act-unidad', '#act-base', '#act-periodo', '#act-min', '#act-max', '#act-lmin', '#act-lmax'].forEach(sel => {
        modal.querySelector(sel).addEventListener('input', preview);
        modal.querySelector(sel).addEventListener('change', preview);
    });
    preview();

    modal.querySelector('#btn-act-guardar').addEventListener('click', async () => {
        const v = leerForm();
        if (v.valor_min <= 0 && v.valor_max <= 0 && v.litros_min <= 0 && v.litros_max <= 0) {
            alert('Cargá al menos la actividad estimada, o los litros que carga.'); return;
        }
        const reg = {
            periodo: v.periodo, unidad: v.unidad, base: v.base, temporada: v.temporada, nota: v.nota,
            valor_min: v.valor_min, valor_max: v.valor_max || v.valor_min,
            litros_min: v.litros_min, litros_max: v.litros_max || v.litros_min
        };
        // Cada equipo puede tener su propia fila con un valor distinto (ver tabla "Por equipo"):
        // si la tiene y trae algo cargado, pisa el rango general SOLO para ese equipo — el resto
        // de campos (unidad, período, temporada, litros, nota) sí se comparten entre todos.
        for (const interno of lista) {
            const fila = modal.querySelector(`tr[data-interno="${CSS.escape(interno)}"]`);
            const minEq = parseFloat(fila?.querySelector('.act-min-eq')?.value) || 0;
            const maxEq = parseFloat(fila?.querySelector('.act-max-eq')?.value) || 0;
            const regEquipo = (minEq > 0 || maxEq > 0)
                ? { ...reg, valor_min: minEq || maxEq, valor_max: maxEq || minEq }
                : reg;
            await setActividadEstimada({ interno, ...regEquipo });
        }
        const porTxt = v.base === 'dia' ? '/día hábil' : (v.base === 'mes' ? '/mes' : ' en total');
        await registrarEdicion({
            tabla: 'equipo', registroId: lista.join(','), etiqueta: `actividad declarada · ${v.periodo}`,
            campo: v.unidad === 'horas' ? 'Horas estimadas' : 'Km estimados', valorAnterior: '',
            valorNuevo: `${v.valor_min}-${v.valor_max || v.valor_min}${porTxt}` +
                (v.litros_min > 0 ? ` · ${v.litros_min}-${v.litros_max || v.litros_min} L${porTxt}` : '') + ` (${v.temporada})`
        });
        cerrar();
        await renderPanel();
    });

    modal.querySelectorAll('.btn-act-quitar').forEach(b => b.addEventListener('click', async () => {
        await quitarActividadEstimada(b.dataset.interno, b.dataset.periodo);
        cerrar();
        await renderPanel();
        abrirActividadEstimada(lista, ultimoAnalisis);
    }));
}

/** Los meses del período analizado, como opciones para declarar actividad mes a mes. */
function rangoMesesPeriodo(analisis) {
    const d = analisis?.totales?.periodo_desde, h = analisis?.totales?.periodo_hasta;
    if (!d || !h) return [];
    const [a1, m1] = d.slice(0, 7).split('-').map(Number);
    const [a2, m2] = h.slice(0, 7).split('-').map(Number);
    const out = [];
    let a = a1, m = m1;
    while (a < a2 || (a === a2 && m <= m2)) {
        out.push({ k: `${a}-${String(m).padStart(2, '0')}`, label: `${MESES[m - 1]} ${a}` });
        m++; if (m > 12) { m = 1; a++; }
        if (out.length > 36) break;
    }
    return out;
}

/**
 * Alta REAL de códigos huérfanos como equipos "fuera de flota".
 *
 * El bug que resuelve: hasta ahora "Dar de alta en maestro" solo navegaba a la tabla con el
 * código buscado, y asignar un interno a una carga desde la tabla de Cargas escribía el interno
 * en el registro pero NO creaba la ficha en el maestro. Como analizarFlota() resuelve cada
 * registro contra el maestro (ver resolverEquipo/indexarMaestro en analyzer.js), un interno que
 * no existe como equipo no resuelve nunca: el código seguía contando como huérfano por más veces
 * que se lo asignara. Eso es lo que se veía como "no se normaliza aunque asignemos interno".
 *
 * Acá se crea la ficha de verdad, en el mismo store `equipos`, con las dos claves (interno y
 * dominio) cuando el huérfano trae las dos — que es el caso de un préstamo como "DEMO SCANIA"
 * con patente AH685WR: si se diera de alta por una sola, las cargas indexadas por la otra
 * seguirían huérfanas.
 *
 * Se marcan `no_flota: true`, lo que hace tres cosas a propósito (ver generarDiagnostico):
 *  - salen de todos los hallazgos de consumo (no tienen ni pueden tener meta de L/100km o L/hora),
 *  - su gasto se reporta aparte, agrupado por centro de costo, que es para lo que se los da de alta,
 *  - dejan de figurar como "código sin padrón".
 */
function abrirAltaNoFlota(hallazgoId, analisis, rawRecords) {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const h = generarDiagnostico(analisis.filas, analisis.totales, rawRecords, ralentiEstadosCache, noFlotaAceptadosCache, equiposExcluidosCache, extraDiag())
        .find(x => x.id === hallazgoId);
    const items = h?.nofl_items || [];
    if (!items.length) { alert('No quedan códigos para dar de alta en este grupo.'); return; }

    // Clase sugerida según de qué grupo viene: un huérfano con patente es casi siempre una unidad
    // ajena que carga con nuestra cuenta (préstamo/demo/alquiler); uno del grupo "planta" es
    // caldera/limpieza/caloventor. Es solo el valor por defecto del desplegable: se cambia por fila.
    const claveSugerida = h.nofl_grupo === 'vehiculo_sin_interno' ? 'prestamo'
        : (h.nofl_grupo === 'planta' ? 'servicio' : 'herramienta');

    const modalId = 'modal-alta-noflota';
    document.getElementById(modalId)?.remove();
    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Dar de alta como equipo fuera de flota</h2>
                    <p class="modal-sub">${items.length} código${items.length === 1 ? '' : 's'} de "${esc(h.titulo.split(':')[0])}". Al darlos de alta dejan de contar como código sin padrón y su gasto se imputa al centro de costo — <strong>no</strong> se les calcula consumo ni meta.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    <table class="data-table">
                        <thead><tr>
                            <th>Código</th><th>Gasto</th><th>Qué es</th><th>Denominación</th>
                            <th title="Obligatorio: es a quién se le imputa el gasto">Centro de costo</th>
                            <th title="Opcional: para préstamos y alquileres con fecha de fin">Vigencia</th>
                            <th></th>
                        </tr></thead>
                        <tbody>
                            ${items.map(i => `<tr data-codigo="${esc(i.codigo)}" data-dominio="${esc(i.dominio || '')}">
                                <td class="cell-key">${esc(i.codigo)}${i.dominio && i.dominio !== i.codigo ? `<br><small>${esc(i.dominio)}</small>` : ''}</td>
                                <td class="cell-num">${nf(i.litros)} L<br><small>$${nf(i.costo)} · ${i.cargas} cargas</small></td>
                                <td><select class="nofl-clase">
                                    ${Object.entries(CLASES_NO_FLOTA).map(([k, v]) => `<option value="${k}" ${k === claveSugerida ? 'selected' : ''}>${esc(v)}</option>`).join('')}
                                </select></td>
                                <td><input type="text" class="nofl-denom" placeholder="${esc(CLASES_NO_FLOTA[claveSugerida])}" style="width:100%"></td>
                                <td><input type="text" class="nofl-cc" value="${esc(i.centro_costo === '—' ? '' : i.centro_costo)}" placeholder="ej. PMZA" style="width:90px"></td>
                                <td style="white-space:nowrap">
                                    <input type="date" class="nofl-desde" style="width:130px" title="Vigente desde">
                                    <input type="date" class="nofl-hasta" style="width:130px" title="Vigente hasta">
                                </td>
                                <td><button class="btn-xs btn-nofl-alta"><i class="fa-solid fa-plus"></i> Dar de alta</button></td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                    <p class="modal-note">El centro de costo viene propuesto desde el que más aparece en las cargas de ese código; corregilo si no corresponde. Si dejás la denominación vacía se usa la de la categoría elegida. La vigencia es opcional y solo informativa: sirve para saber después por qué un préstamo dejó de cargar.</p>
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });

    modal.querySelectorAll('.btn-nofl-alta').forEach(b => b.addEventListener('click', async () => {
        const tr = b.closest('tr');
        const codigo = tr.dataset.codigo;
        const dominio = tr.dataset.dominio;
        const clase = tr.querySelector('.nofl-clase').value;
        const denom = tr.querySelector('.nofl-denom').value.trim().toUpperCase() || CLASES_NO_FLOTA[clase];
        const cc = tr.querySelector('.nofl-cc').value.trim().toUpperCase();
        const desde = tr.querySelector('.nofl-desde').value;
        const hasta = tr.querySelector('.nofl-hasta').value;
        if (!cc && !confirm('Sin centro de costo el gasto de este equipo no se le imputa a nadie. ¿Darlo de alta igual?')) return;

        // Las DOS claves cuando el huérfano trae las dos: si el código es la patente, se usa
        // también como interno para que la ficha tenga una clave propia estable.
        const interno = codigo;
        const dom = dominio && dominio !== codigo ? dominio : (codigo.match(/^[A-Z]{2,3}\d{3}[A-Z]{0,2}$/) ? codigo : '');
        await updateEquipo({
            interno, interno_key: normalizeEquipoKey(interno),
            dominio: dom, dominio_key: normalizeEquipoKey(dom),
            denominacion: denom, marca: '', modelo: '',
            no_flota: true, clase_no_flota: clase,
            centro_costo: cc,
            vigencia_desde: desde || '', vigencia_hasta: hasta || '',
            // "No Aplica" a propósito: sin esto, el equipo recién dado de alta caería de inmediato
            // en el hallazgo "sin meta" — que para una caldera o un préstamo no significa nada.
            meta_valor: 0, meta_unidad: 'No Aplica', meta_texto: '', meta_origen: '',
            extra: {}, origen: [`Alta como fuera de flota (${CLASES_NO_FLOTA[clase]})`],
            editado_manual: ['interno', 'denominacion', 'no_flota', 'centro_costo', 'meta_unidad']
        });
        await registrarEdicion({
            tabla: 'equipo', registroId: interno, etiqueta: `${interno} · alta fuera de flota`,
            campo: 'Alta', valorAnterior: 'código sin padrón', valorNuevo: `${denom}${cc ? ` · CC ${cc}` : ''}`
        });
        tr.remove();
        await renderPanel();
        // El modal se rearma con lo que quedó: así se ve avanzar la lista en vez de tener que
        // reabrirlo desde la tarjeta después de cada alta.
        const quedan = document.querySelectorAll(`#${modalId} tbody tr`).length;
        cerrar();
        if (quedan) abrirAltaNoFlota(hallazgoId, ultimoAnalisis, datosCrudos?.rawRecords || []);
    }));
}

/**
 * "Marcar estado (selección)": marca en bloque el estado (backup, taller, sin chofer…)
 * de varios equipos a la vez, con un valor por defecto + override por fila.
 * El mismo patrón que "Declarar actividad estimada": categoría global arriba, tabla con
 * una columna de override por equipo para los que trabajan distinto.
 */
function abrirEstadoEquipoBulk(internos, hallazgoId = '') {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const lista = [...new Set(internos)].filter(Boolean);
    if (!lista.length) return;

    const modalId = 'modal-estado-eq-bulk';
    document.getElementById(modalId)?.remove();

    const opcionesCategoria = (incluirVacia = false) =>
        (incluirVacia ? '<option value="">— usar el de arriba —</option>' : '') +
        CATEGORIAS_SEGUIMIENTO.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('');

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div><h2>Marcar estado — ${lista.length} equipo${lista.length === 1 ? '' : 's'}</h2>
                    <p class="modal-sub">Anotar el motivo por el que tienen poca base de datos. No los excluye del análisis.<br>
                    Los períodos fuera de servicio se cargan equipo por equipo desde "Estado" en cada tarjeta.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    <div style="display:flex;gap:1rem;align-items:flex-end;margin-bottom:1rem;flex-wrap:wrap">
                        <div style="flex:1;min-width:200px">
                            <label class="correc-field-label" style="display:block;margin-bottom:0.3rem">Categoría por defecto (todos)</label>
                            <select id="bulk-cat-defecto" style="width:100%">
                                ${opcionesCategoria(false)}
                            </select>
                        </div>
                        <div style="flex:2;min-width:200px">
                            <label class="correc-field-label" style="display:block;margin-bottom:0.3rem">Detalle por defecto (opcional)</label>
                            <input type="text" id="bulk-motivo-defecto" style="width:100%" placeholder="Ej: baja producción temporaria">
                        </div>
                    </div>
                    <p class="modal-note" style="margin-bottom:0.5rem">Completá una fila solo para el equipo con una situación distinta — el resto usa el valor de arriba.</p>
                    <table class="data-table">
                        <thead><tr>
                            <th>Equipo</th>
                            <th>Categoría (override)</th>
                            <th>Detalle (override)</th>
                        </tr></thead>
                        <tbody>
                            ${lista.map(i => {
                                const act = seguimientoEquiposCache.get(i);
                                return `<tr data-interno="${esc(i)}">
                                    <td class="cell-key">${esc(i)}</td>
                                    <td><select class="bulk-cat-eq" style="width:100%;font-size:0.82rem">${opcionesCategoria(true)}</select></td>
                                    <td><input type="text" class="bulk-motivo-eq" style="width:100%;font-size:0.82rem" placeholder="usar el de arriba" value="${esc(act?.motivo || '')}"></td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                    <div class="modal-actions" style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem">
                        <button class="btn-secondary btn-sm" data-close>Cancelar</button>
                        <button class="btn-primary btn-sm" id="btn-bulk-eq-guardar"><i class="fa-solid fa-floppy-disk"></i> Guardar para los ${lista.length} equipos</button>
                    </div>
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });

    modal.querySelector('#btn-bulk-eq-guardar').addEventListener('click', async () => {
        const catDefecto = modal.querySelector('#bulk-cat-defecto').value || 'otro';
        const motivoDefecto = modal.querySelector('#bulk-motivo-defecto').value.trim();
        const filas = [...modal.querySelectorAll('tbody tr[data-interno]')];
        for (const fila of filas) {
            const interno = fila.dataset.interno;
            const catOverride = fila.querySelector('.bulk-cat-eq').value;
            const motivoOverride = fila.querySelector('.bulk-motivo-eq').value.trim();
            const cat = catOverride || catDefecto;
            const motivo = motivoOverride || motivoDefecto;
            const actual = seguimientoEquiposCache.get(interno);
            const rangos = actual?.rangos || [];
            await setSeguimientoEquipo(interno, motivo, cat, rangos);
            seguimientoEquiposCache.set(interno, { interno, motivo, categoria: cat, fecha: new Date().toISOString(), rangos });
            if (hallazgoId) marcarAtendido(hallazgoId, interno, CATEGORIA_SEGUIMIENTO_LABEL[cat] || cat);
        }
        cerrar();
        renderDiagnostico(ultimoAnalisis, datosCrudos?.rawRecords || []);
    });
}

/**
 * "Estado del equipo": modal chico para anotar por qué un equipo tiene poca base o datos raros
 * (fuera de servicio, taller, temporada baja, sin chofer, backup) sin excluirlo del análisis —
 * mismo store `seguimientoEquipos` que usa Consumo Real en Base de Datos, para no duplicar el
 * mecanismo. Se abre desde cualquier tarjeta de hallazgo (ralentí, GPS vs ignición, sin
 * actividad, estimación no creíble): es la manera de "investigar y dejar constancia" en un
 * solo lugar, en vez de tener un botón distinto por cada tipo de problema.
 */
function abrirEstadoEquipo(interno) {
    const container = document.getElementById('modals-container');
    if (!container) return;
    const actual = seguimientoEquiposCache.get(interno);
    // Rangos de fechas fuera de servicio: se editan en vivo (sin necesidad de guardar).
    let rangos = [...(actual?.rangos || [])];

    const modalId = 'modal-estado-equipo';
    document.getElementById(modalId)?.remove();

    const opcionesCategoria = CATEGORIAS_SEGUIMIENTO.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('');

    const renderRangos = () => {
        const tbody = modal.querySelector('#tabla-rangos-body');
        if (!tbody) return;
        if (!rangos.length) {
            tbody.innerHTML = `<tr><td colspan="4" style="color:var(--text-muted);font-size:0.8rem;padding:0.4rem 0">Sin períodos marcados — los días hábiles del período analizado se usan íntegros como denominador.</td></tr>`;
            return;
        }
        tbody.innerHTML = rangos.map((r, i) => `
            <tr>
                <td><input type="date" class="rango-desde" data-idx="${i}" value="${esc(r.desde || '')}" style="font-size:0.8rem;padding:2px 4px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-card);color:var(--text-primary)"></td>
                <td><input type="date" class="rango-hasta" data-idx="${i}" value="${esc(r.hasta || '')}" style="font-size:0.8rem;padding:2px 4px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-card);color:var(--text-primary)"></td>
                <td><select class="rango-cat" data-idx="${i}" style="font-size:0.8rem;padding:2px 4px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-card);color:var(--text-primary)">${CATEGORIAS_SEGUIMIENTO.map(c => `<option value="${c.id}" ${r.categoria === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></td>
                <td><button class="btn-icon rango-borrar" data-idx="${i}" title="Quitar rango"><i class="fa-solid fa-trash"></i></button></td>
            </tr>`).join('');
        // Edición inline en la tabla
        tbody.querySelectorAll('.rango-desde').forEach(inp => inp.addEventListener('change', e => { rangos[+e.target.dataset.idx].desde = e.target.value; }));
        tbody.querySelectorAll('.rango-hasta').forEach(inp => inp.addEventListener('change', e => { rangos[+e.target.dataset.idx].hasta = e.target.value; }));
        tbody.querySelectorAll('.rango-cat').forEach(sel => sel.addEventListener('change', e => { rangos[+e.target.dataset.idx].categoria = e.target.value; }));
        tbody.querySelectorAll('.rango-borrar').forEach(btn => btn.addEventListener('click', e => {
            rangos.splice(+e.currentTarget.dataset.idx, 1);
            renderRangos();
        }));
    };

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content" style="max-width:600px">
                <div class="modal-header">
                    <div><h2>Estado de ${esc(interno)}</h2>
                    <p class="modal-sub">No excluye al equipo del análisis — solo queda anotado por qué tiene poca base o datos raros, para no reinvestigarlo la próxima vez.</p></div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    <label class="correc-field-label" style="display:block;text-align:left;margin-bottom:0.3rem">Categoría general</label>
                    <select class="estado-eq-categoria" style="width:100%;margin-bottom:0.75rem">
                        <option value="">— Sin anotar —</option>
                        ${CATEGORIAS_SEGUIMIENTO.map(c => `<option value="${c.id}" ${actual?.categoria === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
                    </select>
                    <label class="correc-field-label" style="display:block;text-align:left;margin-bottom:0.3rem">Detalle (opcional)</label>
                    <textarea class="estado-eq-motivo" rows="2" placeholder="Ej: en taller marzo-abril, cambio de sucursal a San Juan en mayo...">${esc(actual?.motivo || '')}</textarea>

                    <div style="margin-top:1.2rem;border-top:1px solid var(--border-color);padding-top:1rem">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
                            <label class="correc-field-label" style="margin:0">Períodos fuera de servicio</label>
                            <button class="btn-secondary btn-sm" id="btn-agregar-rango"><i class="fa-solid fa-plus"></i> Agregar período</button>
                        </div>
                        <p style="font-size:0.78rem;color:var(--text-muted);margin-bottom:0.5rem">
                            Cada rango descuenta sus días hábiles del denominador de cobertura — la tarjeta mostrará
                            "X de Y <em>días trabajados</em>" en lugar de "X de Y días hábiles".
                        </p>
                        <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
                            <thead><tr>
                                <th style="text-align:left;padding:0 4px 4px;color:var(--text-muted);font-weight:500">Desde</th>
                                <th style="text-align:left;padding:0 4px 4px;color:var(--text-muted);font-weight:500">Hasta</th>
                                <th style="text-align:left;padding:0 4px 4px;color:var(--text-muted);font-weight:500">Motivo</th>
                                <th></th>
                            </tr></thead>
                            <tbody id="tabla-rangos-body"></tbody>
                        </table>
                    </div>

                    <div class="modal-actions" style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.75rem">
                        <button class="btn-secondary btn-sm" data-close>Cancelar</button>
                        ${actual ? '<button class="btn-secondary btn-sm" id="btn-estado-eq-quitar"><i class="fa-solid fa-trash"></i> Quitar anotación</button>' : ''}
                        <button class="btn-primary btn-sm" id="btn-estado-eq-guardar"><i class="fa-solid fa-floppy-disk"></i> Guardar</button>
                    </div>
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    renderRangos();

    const cerrar = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });

    modal.querySelector('#btn-agregar-rango').addEventListener('click', () => {
        rangos.push({ desde: '', hasta: '', categoria: 'fuera_servicio' });
        renderRangos();
        // Dar foco al input de fecha del nuevo rango
        modal.querySelectorAll('.rango-desde').forEach((el, i, arr) => { if (i === arr.length - 1) el.focus(); });
    });

    modal.querySelector('#btn-estado-eq-guardar').addEventListener('click', async () => {
        const categoria = modal.querySelector('.estado-eq-categoria').value;
        const motivo = modal.querySelector('.estado-eq-motivo').value.trim();
        // Validar rangos: si hay alguno incompleto, avisar
        const rangosValidos = rangos.filter(r => r.desde && r.hasta);
        const rangosIncompletos = rangos.filter(r => !r.desde || !r.hasta);
        if (rangosIncompletos.length) {
            if (!confirm(`Hay ${rangosIncompletos.length} período(s) sin fecha de inicio o fin. Se descartarán. ¿Continuar?`)) return;
        }
        if (!categoria && !motivo && !rangosValidos.length) {
            alert('Elegí una categoría, escribí un detalle o agregá al menos un período fuera de servicio.');
            return;
        }
        await setSeguimientoEquipo(interno, motivo, categoria || 'otro', rangosValidos);
        seguimientoEquiposCache.set(interno, { interno, motivo, categoria: categoria || 'otro', fecha: new Date().toISOString(), rangos: rangosValidos });
        cerrar();
        renderPanel();
    });

    modal.querySelector('#btn-estado-eq-quitar')?.addEventListener('click', async () => {
        await quitarSeguimientoEquipo(interno);
        seguimientoEquiposCache.delete(interno);
        cerrar();
        renderPanel();
    });
}

/** Ejecuta la acción propuesta para un hallazgo: abrir comparativa, ajustar metas, etc. */
function ejecutarAccionPropuesta(accion, hallazgoId, analisis) {
    // Con los rawRecords de verdad, no con un array vacío: hay hallazgos que solo existen si se
    // pueden leer los movimientos (los de calidad del dato, el cruce contra el Informe de
    // Ignición). Con [] esos hallazgos no aparecían acá y sus acciones no hacían nada.
    const h = generarDiagnostico(analisis.filas, analisis.totales, datosCrudos?.rawRecords || [], ralentiEstadosCache, noFlotaAceptadosCache, equiposExcluidosCache, extraDiag()).find(x => x.id === hallazgoId);
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
        case 'declarar_actividad':
            // Todos los equipos del hallazgo de una: la actividad típica de un grupo (camionetas,
            // grupos electrógenos) se estima igual para todos, y declararla uno por uno es lo que
            // hace que nunca se termine de completar.
            abrirActividadEstimada(internos.length ? internos : [], ultimoAnalisis);
            break;
        case 'alta_no_flota':
            abrirAltaNoFlota(hallazgoId, ultimoAnalisis, datosCrudos?.rawRecords || []);
            break;
        case 'ver_maestro_no_flota':
            if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('maestro', '');
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
        case 'investigar_meta':
            if (internos.length) abrirInvestigacionMeta(internos[0]);
            break;
        case 'revisar_parciales':
            abrirRevisionParciales(ultimoAnalisis, datosCrudos?.rawRecords || []);
            break;
        case 'resolver':
            abrirResolucion(hallazgoId, ultimoAnalisis, datosCrudos?.rawRecords || []);
            break;
        case 'ir_a_carga':
            // Los meses que faltan no se arreglan dentro del Panel: hay que subir el archivo.
            if (typeof window.irA === 'function') window.irA('upload');
            else document.getElementById('nav-upload')?.click();
            break;
        case 'completar_precios':
            completarPreciosFaltantes(ultimoAnalisis, datosCrudos?.rawRecords || []);
            break;
        case 'ver_cargas_sin_valor':
            // La tabla filtrada a las cargas sin valorizar, no a un equipo suelto: antes abría
            // las 154 cargas de TR32 y las 38 que importaban había que encontrarlas a ojo.
            if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', '', 'id', null, 'sin_valorizar');
            break;
        case 'ver_cargas_repetidas':
            if (typeof window.abrirTablaConBusqueda === 'function') window.abrirTablaConBusqueda('carga', '', 'id', null, 'repetidas');
            break;
        case 'corregir_duplicados':
            abrirCorregirDuplicados(datosCrudos?.rawRecords || []);
            break;
        case 'unificar_variantes':
            abrirUnificarVariantes(datosCrudos?.rawRecords || []);
            break;
        case 'revisar_prefijos_nuevos':
            abrirRevisionPrefijosNuevos(ultimoAnalisis, datosCrudos?.rawRecords || []);
            break;
        default:
            if (internos.length) buscarEquipo(internos[0]);
    }
}

/**
 * Fuerza el filtro de meses del panel a un conjunto dado (vacío = auto-selección).
 * Llamado desde upload.js después de procesar archivos con período explícito.
 */
export function setMesesFiltro(periodos) {
    view.meses.clear();
    periodos.forEach(p => view.meses.add(p));
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

/**
 * Valor normalizado de una spec del padrón, para agrupar y filtrar.
 *
 * La planilla de Equipos trae estos campos como texto libre y la misma spec aparece escrita
 * de varias formas: "260 HP" y "260HP", "320HP" y "320 HP", "6X4" y "6x4". Sin normalizar, el
 * desplegable listaba las dos variantes como si fueran potencias distintas y filtrar por una
 * escondía los equipos escritos de la otra forma.
 *
 * La potencia se normaliza con potenciaEquipo() — el mismo parser que usa el diagnóstico para
 * comparar equipos por tamaño — así que el filtro y el análisis agrupan igual.
 */
function specNormalizada(equipo, key) {
    const bruto = equipo[key];
    if (bruto === null || bruto === undefined || bruto === '') return null;
    if (key === 'potencia') {
        const p = potenciaEquipo(equipo);
        if (p) return `${p.valor} ${p.unidad}`;
    }
    // Capacidad y cualquier otro texto libre: espacios colapsados y mayúsculas.
    return String(bruto).trim().replace(/\s+/g, ' ').toUpperCase();
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
        let valores = [...new Set(filas.map(f => specNormalizada(f.equipo, key)).filter(v => v !== null && v !== ''))];
        valores.sort(ordenNum
            ? (a, b) => Number(b) - Number(a)
            : (a, b) => {
                // Las potencias ordenan por número ("90 HP" antes que "440 HP"), no alfabéticamente.
                const na = parseFloat(a), nb = parseFloat(b);
                if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
                return String(a).localeCompare(String(b));
            });
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
    // Se compara contra el valor NORMALIZADO (ver specNormalizada): filtrar por "260 HP" tiene
    // que traer también los equipos que el Excel escribió "260HP".
    if (view.potencia !== 'ALL') out = out.filter(f => specNormalizada(f.equipo, 'potencia') === view.potencia);
    if (view.capacidad !== 'ALL') out = out.filter(f => specNormalizada(f.equipo, 'capacidad') === view.capacidad);
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
        card.querySelector('.btn-card-actividad')?.addEventListener('click', (e) => {
            e.stopPropagation();
            abrirActividadEstimada([interno], analisis);
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
/**
 * Franja de utilización: cuántas horas por día hábil trabajó el equipo contra la jornada de
 * referencia que informa la operación (10-12 hs en áridos y en mixers).
 *
 * Es el contexto que le falta a un consumo bajo: sin esto, un equipo que casi no trabajó
 * aparece igual que uno eficiente. Con esto se distingue "rindió mejor" de "estuvo parado"
 * — el caso de los equipos de áridos durante la obra de la ripiera.
 */
function utilizacionHTML(f, periodoFlota) {
    const u = utilizacion(f, periodoFlota);
    if (!u) return '';
    if (u.estado === 'no_representativa') {
        return `<div class="card-util util-dudosa" title="El GPS reporta ${nf(u.horas, 0)} hs en ${u.diasHabiles} días hábiles: más de 24 hs por día. O el equipo trabajó también fines de semana y feriados, o el GPS está reportando horas de más."><i class="fa-solid fa-circle-question"></i> ${nf(u.hsPorDia, 1)} hs/día hábil — fuera de escala, revisar el dato de GPS</div>`;
    }
    const cls = u.estado === 'muy_baja' ? 'util-muy-baja' : u.estado === 'baja' ? 'util-baja' : u.estado === 'alta' ? 'util-alta' : 'util-ok';
    const icono = u.estado === 'normal' ? 'fa-circle-check' : u.estado === 'alta' ? 'fa-arrow-up' : 'fa-arrow-down';
    const txt = u.estado === 'normal' ? 'en la jornada esperada'
        : u.estado === 'alta' ? 'por encima de la jornada esperada'
        : 'por debajo de la jornada esperada';
    return `<div class="card-util ${cls}" title="${nf(u.horas, 0)} hs de GPS en ${u.diasHabiles} días hábiles (${u.desde} → ${u.hasta}). Referencia: ${u.esperadoMin}-${u.esperadoMax} hs por día hábil (${esc(u.nota)}, ${esc(u.base)}). Un consumo bajo con utilización baja no es eficiencia: es un equipo que trabajó menos.">
        <i class="fa-solid ${icono}"></i> <strong>${nf(u.hsPorDia, 1)}</strong> hs/día hábil · esperado ${u.esperadoMin}-${u.esperadoMax} — ${txt}
    </div>`;
}

/**
 * Actividad que efectivamente entró en el cálculo del consumo: la de los meses que tienen
 * cargas Y GPS (ver alinearCargasYGps() en analyzer.js). Cuando los períodos están alineados
 * es igual al total del período.
 *
 * La tarjeta tiene que mostrar ESTE número y no el total: es el que está dividiendo a los
 * litros, y poner el total al lado de un consumo calculado con otra base es lo que hacía que
 * la cuenta no cerrara a ojo. Vive acá, en una sola función, para que la tarjeta chica y el
 * overlay de detalle no puedan volver a desincronizarse.
 */
function actividadDelCalculo(m) {
    const esHora = m.tipo_calculo === 'L/Hora';
    const total = esHora ? m.total_horas : m.total_km;
    const alineada = esHora ? (m.horas_alineadas || 0) : (m.km_alineados || 0);
    const usaAlineada = m.consumo_real > 0 && alineada > 0;
    return {
        esHora,
        valor: usaAlineada ? alineada : total,
        total,
        parcial: usaAlineada && alineada < total,
        unidad: esHora ? 'hs' : 'km',
        litros: m.litros_alineados > 0 ? m.litros_alineados : m.total_litros
    };
}

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

    // Cobertura: DÍAS DISTINTOS con carga sobre los días hábiles del período analizado de la
    // flota — coberturaEquipo() en diagnostico.js, la misma función y el mismo denominador que
    // usan la vista de Seguimiento, el modal de detalle y el aviso de confiabilidad de
    // "Ajustar metas". Antes cada lugar contaba una cosa distinta (esta tarjeta contaba
    // CARGAS contra el rango propio del equipo, el modal contaba DÍAS contra el período de la
    // flota) y el mismo equipo aparecía con dos porcentajes distintos según dónde se lo mirara.
    //
    // OJO: a propósito NO se recorta a 100%. Cargar en más días hábiles de los que tuvo el
    // período no es "cobertura completa": es una señal de datos mal cruzados (cargas
    // duplicadas, interno reciclado, período mal recortado) — ver también el hallazgo
    // "cargas_exceden_dias_habiles" del diagnóstico automático.
    let coberturaHtml = '';
    const periodoFlota = ultimoAnalisis ? { desde: ultimoAnalisis.totales.periodo_desde, hasta: ultimoAnalisis.totales.periodo_hasta } : null;
    const seguimientoEq = seguimientoEquiposCache.get(f.equipo.interno);
    const rangosEq = seguimientoEq?.rangos || [];
    const cob = coberturaEquipo(f, periodoFlota, rangosEq);
    if (cob) {
        const { pct, diasHabiles: dias, diasTrabajados, diasFueraServicio, totalCorridos, completo, diasConCarga, cargas } = cob;
        const cls = pct > 100 ? 'cobertura-exceso' : (pct >= 40 ? 'cobertura-ok' : (pct >= 20 ? 'cobertura-media' : 'cobertura-baja'));
        const tituloExceso = pct > 100 ? ` · ⚠ cargó en más días trabajados de los que tuvo el período: revisar duplicados o el período` : '';
        const notaCargas = cargas > diasConCarga ? ` (${cargas} cargas en total: hubo días con más de una)` : '';
        // Cuando hay días marcados fuera de servicio, el denominador es "días trabajados";
        // si no, se muestra "días hábiles" (la misma cifra, sin la distinción que no aporta nada).
        const denominador = diasFueraServicio > 0 ? diasTrabajados : dias;
        const labelDenom = diasFueraServicio > 0
            ? `días trabajados`
            : `días hábiles`;
        const notaFuera = diasFueraServicio > 0
            ? ` · ${diasFueraServicio} días fuera de servicio descontados de ${dias} hábiles`
            : '';
        coberturaHtml = `<div class="card-cobertura ${cls}" title="Cargó combustible en ${diasConCarga} de ${denominador} ${labelDenom} del período analizado${completo ? '' : ' (sin feriados móviles confirmados)'}, sobre ${totalCorridos} días corridos${notaFuera}${notaCargas ? ' · ' + notaCargas.slice(2) : ''} → ${pct}%${tituloExceso}">
            <span class="cobertura-num"><i class="fa-solid fa-gas-pump"></i> ${diasConCarga}</span>
            <span class="cobertura-sep">de</span>
            <span class="cobertura-num"><i class="fa-solid fa-calendar-days"></i> ${denominador} ${labelDenom}</span>
            <span class="cobertura-pct">${pct > 100 ? `<i class="fa-solid fa-triangle-exclamation"></i> ${pct}%` : `${pct}%`}</span>
        </div>`;
    }

    const desalineado = desalineadoInfo(f).html;

    // Tooltip detallado para GPS (el dato en sí ahora se ve chico, abajo)
    const tooltipG = mesesG.length ? `${m.cantidad_gps} reportes de Resumen de Flota en ${mesesG.length} mes${mesesG.length > 1 ? 'es' : ''}: ${mesesG.map(m => MESES_CORTO[parseInt(m.slice(5), 10) - 1] + ' ' + m.slice(0, 4)).join(', ')}` : '';

    return `
        ${coberturaHtml}
        ${utilizacionHTML(f, periodoFlota)}
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
    const act = actividadDelCalculo(m);
    const factor = act.valor;
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
                ${implicita && implicita.referencia ? `<span class="stat-nota" title="${esc(implicita.referencia.formula)}"><i class="fa-solid ${implicita.referencia.respalda ? 'fa-check' : 'fa-triangle-exclamation'}"></i> ${implicita.referencia.respalda ? 'confirmado' : 'no confirmado'} por jornada de referencia (${esc(implicita.referencia.jornada.nota)}: ${nf(implicita.referencia.horas_min, 0)}-${nf(implicita.referencia.horas_max, 0)} hs esperadas)</span>` : ''}
                ${!implicita && act.parcial ? `<span class="stat-nota" title="Solo se usan los meses que tienen cargas Y GPS: dividir todos los litros por la actividad de menos meses daría un consumo inflado.">de ${nf(act.total, esHora ? 1 : 0)} ${uf} del período · meses con las dos fuentes</span>` : ''}
            </div>
            <div class="stat stat-clickable" ${attrsConsumo} role="button" tabindex="0">
                <span class="stat-label">Consumo real <i class="fa-solid fa-calculator"></i></span>
                <span class="stat-value ${m.consumo_real > 0 ? 'stat-highlight' : 'stat-muted'}">${m.consumo_real > 0 ? `${nf(m.consumo_real, 2)} <small class="stat-unit">${esc(unidadConsumoLabel(m.tipo_calculo))}</small>` : '—'}</span>
                ${m.consumo_real > 0 && m.alineacion && m.alineacion.meses.length < m.alineacion.meses_cargas.length ? `<span class="stat-nota" title="El consumo se calcula sobre ${m.alineacion.meses.length} mes${m.alineacion.meses.length !== 1 ? 'es' : ''} con datos de Cargas Y GPS a la vez. El equipo cargó en ${m.alineacion.meses_cargas.length} mes${m.alineacion.meses_cargas.length !== 1 ? 'es' : ''} en total.">${m.alineacion.meses.length} de ${m.alineacion.meses_cargas.length} meses</span>` : ''}
            </div>
        </div>
        ${m.consumo_l_hora > 0 && m.consumo_l_100km > 0 ? `<div class="card-cross-check" title="Las dos unidades, calculadas sobre la misma base (${nf(m.litros_alineados || m.total_litros, 1)} L, ${nf(m.horas_alineadas || m.total_horas, 1)} hs, ${nf(m.km_alineados || m.total_km)} km). No son alternativas: donde las distancias son largas pero además hay ralentí en obra —Tunuyán es el caso típico— hace falta mirar las dos para entender el consumo.">
            <i class="fa-solid fa-arrows-left-right"></i>
            <span>Medido de las dos formas: <strong${m.tipo_calculo === 'L/Hora' ? ' class="unidad-principal"' : ''}>${nf(m.consumo_l_hora, 2)} L/Hora</strong> · <strong${m.tipo_calculo === 'L/100Km' ? ' class="unidad-principal"' : ''}>${nf(m.consumo_l_100km, 2)} L/100Km</strong></span>
            <small>(${nf(m.horas_alineadas || m.total_horas, 1)} hs y ${nf(m.km_alineados || m.total_km)} km)</small>
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
                    <button class="btn-icon btn-card-actividad" title="Declarar km/horas estimados (ej. '10-12 hs/día para Áridos') — no hace falta esperar a que aparezca un hallazgo"><i class="fa-solid fa-gauge-high"></i></button>
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
    const act = actividadDelCalculo(m);
    const factor = act.valor;
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
                ${implicita && implicita.referencia ? `<span class="stat-nota" title="${esc(implicita.referencia.formula)}"><i class="fa-solid ${implicita.referencia.respalda ? 'fa-check' : 'fa-triangle-exclamation'}"></i> ${implicita.referencia.respalda ? 'confirmado' : 'no confirmado'} por jornada de referencia (${esc(implicita.referencia.jornada.nota)}: ${nf(implicita.referencia.horas_min, 0)}-${nf(implicita.referencia.horas_max, 0)} hs esperadas)</span>` : ''}
                ${!implicita && act.parcial ? `<span class="stat-nota">de ${nf(act.total, esHora ? 1 : 0)} ${uf} del período — el consumo se mide solo sobre los meses que tienen cargas y GPS (${esc((m.alineacion?.meses || []).join(', '))})</span>` : ''}
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
            ${m.consumo_l_hora > 0 && m.consumo_l_100km > 0 ? `<div class="card-cross-check" style="margin-top:8px" title="Las dos unidades sobre la misma base alineada. Donde las distancias son largas y además hay ralentí en obra (Tunuyán), hace falta mirar las dos."><i class="fa-solid fa-arrows-left-right"></i> Medido de las dos formas: <strong${m.tipo_calculo === 'L/Hora' ? ' class="unidad-principal"' : ''}>${nf(m.consumo_l_hora, 2)} L/Hora</strong> · <strong${m.tipo_calculo === 'L/100Km' ? ' class="unidad-principal"' : ''}>${nf(m.consumo_l_100km, 2)} L/100Km</strong> <small>(${nf(m.horas_alineadas || m.total_horas, 1)} hs · ${nf(m.km_alineados || m.total_km)} km)</small></div>` : ''}
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
              <button class="btn-secondary btn-sm btn-overlay-actividad" title="Declarar km/horas estimados a mano (ej. '10-12 hs/día', '6 hs/día para este en particular') — no hace falta esperar a que aparezca un hallazgo">
                <i class="fa-solid fa-gauge-high"></i> Declarar horas/km estimados
              </button>
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

    // Declarar horas/km estimados a mano, sin tener que pasar por un hallazgo de diagnóstico —
    // mismo modal que ya usa el ícono de la tarjeta chica y las acciones en bloque, ahora también
    // accesible desde la vista de detalle de un solo equipo.
    overlay.querySelector('.btn-overlay-actividad')?.addEventListener('click', () => {
        cerrar();
        abrirActividadEstimada([eq.interno], analisis);
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
