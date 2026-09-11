/**
 * Auditoría de COHERENCIA de los cálculos, contra los datos reales.
 *
 * `verificar-datos-reales.mjs` responde "¿los totales siguen dando lo mismo que ayer?".
 * Este arnés responde una pregunta distinta y complementaria: "¿los números que la app
 * muestra son coherentes ENTRE SÍ y con la fórmula que ella misma dice estar usando?".
 *
 * No compara contra un archivo de invariantes: cada chequeo recalcula el número por su
 * definición y lo confronta con el que produjo el pipeline. Un invariante congelado no
 * detecta una fórmula mal escrita — solo detecta que cambió; esto detecta que está mal.
 *
 * Uso:  node tools/auditar-calculos.mjs [--verboso]
 * Sale con código 1 si hay alguna incoherencia.
 */
import 'fake-indexeddb/auto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ARCHIVOS = path.resolve(REPO, '..', '..', 'ARCHIVOS');

globalThis.XLSX = require(path.join(REPO, 'xlsx.full.min.js'));
class FileReaderShim {
    readAsArrayBuffer(file) {
        const buf = file.__buffer;
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        queueMicrotask(() => this.onload && this.onload({ target: { result: ab } }));
    }
}
globalThis.FileReader = FileReaderShim;

const { parseXLSX } = await import('../js/parsers/xlsx-parser.js');
const { initDB, getAllEquipos, getAllRawRecords, getAllEstimados, getRalentiEstados, getNoFlotaAceptados, getEquiposExcluidos, getAccionesAutomaticas } = await import('../js/data/database.js');
const { analizarFlota, mesesDeRegistro, alinearCargasYGps, jornadaDelMes, jornadaEsperada, sectorDe } = await import('../js/data/analyzer.js');
const { normalizeEquipoKey: normKey } = await import('../js/data/normalizer.js');
const { generarDiagnostico, coberturaEquipo, utilizacion, calcularExceso, actividadImplicita } = await import('../js/data/diagnostico.js');
const { aplicarCorreccionesAutomaticas } = await import('../js/data/autocorreccion.js');
const { normalizeEquipoKey } = await import('../js/data/normalizer.js');

const VERBOSO = process.argv.includes('--verboso');

const fallas = [];
const avisos = [];
let chequeos = 0;

/** Compara dos números con tolerancia relativa (y absoluta para los cercanos a cero). */
function casi(a, b, tolRel = 1e-9, tolAbs = 1e-6) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const d = Math.abs(a - b);
    return d <= tolAbs || d <= tolRel * Math.max(Math.abs(a), Math.abs(b));
}
function check(grupo, nombre, ok, detalle) {
    chequeos++;
    if (!ok) fallas.push({ grupo, nombre, detalle });
    else if (VERBOSO) console.log(`  ok . ${grupo} . ${nombre}`);
}
function aviso(grupo, nombre, detalle) { avisos.push({ grupo, nombre, detalle }); }

/** Lee un número escrito en formato es-AR ("1.234,56") desde el texto de un paso. */
function numEsAR(s) {
    if (s == null) return NaN;
    const m = String(s).replace(/\s/g, '').match(/-?[\d.]+(?:,\d+)?/);
    if (!m) return NaN;
    return parseFloat(m[0].replace(/\./g, '').replace(',', '.'));
}

async function cargarTodo() {
    await initDB();
    const archivos = readdirSync(ARCHIVOS).filter(f => /\.xlsx$/i.test(f));
    for (const nombre of archivos) {
        const buf = readFileSync(path.join(ARCHIVOS, nombre));
        await parseXLSX({ name: nombre, __buffer: buf });
    }
    let [equipos, rawRecords, estimados, ralentiEstados, noFlotaAceptados, equiposExcluidos] = await Promise.all([
        getAllEquipos(), getAllRawRecords(), getAllEstimados(), getRalentiEstados(), getNoFlotaAceptados(), getEquiposExcluidos()
    ]);
    let analisis = analizarFlota({ equipos, rawRecords, estimados, filtro: { anio: null, periodos: [] } });
    const aplicado = await aplicarCorreccionesAutomaticas({
        equipos, huerfanos: analisis.totales.huerfanos, filas: analisis.filas,
        codigosAceptados: new Set(noFlotaAceptados.map(n => n.codigo))
    });
    if (aplicado.altas || aplicado.aceptados || aplicado.metas) {
        [equipos, noFlotaAceptados] = await Promise.all([getAllEquipos(), getNoFlotaAceptados()]);
        analisis = analizarFlota({ equipos, rawRecords, estimados, filtro: { anio: null, periodos: [] } });
    }
    const accionesAutomaticas = await getAccionesAutomaticas();
    const hallazgos = generarDiagnostico(analisis.filas, analisis.totales, rawRecords, ralentiEstados, noFlotaAceptados, equiposExcluidos, { accionesRecientes: accionesAutomaticas });
    return { equipos, rawRecords, analisis, hallazgos };
}

const { equipos, rawRecords, analisis, hallazgos } = await cargarTodo();
const { filas, totales } = analisis;
const periodo = { desde: totales.periodo_desde, hasta: totales.periodo_hasta };

console.log(`\n=== AUDITORIA DE COHERENCIA . ${filas.length} equipos . periodo ${periodo.desde} -> ${periodo.hasta} ===\n`);

// ============================================================ A. MAESTRO / CLAVES
{
    const porInterno = new Map(), porDominio = new Map();
    equipos.forEach(e => {
        const ik = e.interno_key || normalizeEquipoKey(e.interno);
        const dk = e.dominio_key || normalizeEquipoKey(e.dominio);
        if (ik) { if (!porInterno.has(ik)) porInterno.set(ik, []); porInterno.get(ik).push(e.interno); }
        if (dk) { if (!porDominio.has(dk)) porDominio.set(dk, []); porDominio.get(dk).push(e.interno); }
    });
    const colInterno = [...porInterno.entries()].filter(([, v]) => v.length > 1);
    const colDominio = [...porDominio.entries()].filter(([, v]) => v.length > 1);
    check('maestro', 'ningun interno_key repetido (indexarMaestro pisaria uno)', colInterno.length === 0,
        colInterno.map(([k, v]) => `${k}: ${v.join(', ')}`).join(' | '));
    check('maestro', 'ningun dominio_key repetido entre dos equipos', colDominio.length === 0,
        colDominio.map(([k, v]) => `${k}: ${v.join(', ')}`).join(' | '));
    const choque = [...porDominio.keys()].filter(k => porInterno.has(k) && porInterno.get(k)[0] !== porDominio.get(k)[0]);
    check('maestro', 'ningun dominio choca con el interno de otro equipo', choque.length === 0, choque.join(', '));
}

// ============================================================ B. MÉTRICAS POR EQUIPO
let conConsumo = 0, desalineados = 0;
for (const f of filas) {
    const m = f.metrics;
    const id = f.equipo.interno;

    // B1 - nada infinito ni NaN
    const numericos = ['total_litros', 'total_costo', 'total_km', 'total_horas', 'horas_ralenti',
        'horas_movimiento', 'litros_alineados', 'km_alineados', 'horas_alineadas',
        'consumo_l_hora', 'consumo_l_100km', 'consumo_real'];
    const rotos = numericos.filter(k => !Number.isFinite(m[k]));
    check('metricas', `${id}: todos los numeros son finitos`, rotos.length === 0, rotos.join(', '));

    // B2 - la base alineada nunca puede superar al total del período
    check('alineacion', `${id}: litros alineados <= litros totales`, m.litros_alineados <= m.total_litros + 1e-6,
        `${m.litros_alineados} > ${m.total_litros}`);
    check('alineacion', `${id}: km alineados <= km totales`, m.km_alineados <= m.total_km + 1e-6,
        `${m.km_alineados} > ${m.total_km}`);
    check('alineacion', `${id}: horas alineadas <= horas totales`, m.horas_alineadas <= m.total_horas + 1e-6,
        `${m.horas_alineadas} > ${m.total_horas}`);

    // B3 - los meses alineados son exactamente la intersección declarada
    const a = m.alineacion || {};
    const inter = (a.meses_cargas || []).filter(x => (a.meses_gps || []).includes(x)).sort();
    check('alineacion', `${id}: meses usados = interseccion(cargas, GPS)`,
        JSON.stringify(a.meses || []) === JSON.stringify(inter), `usados ${JSON.stringify(a.meses)} vs interseccion ${JSON.stringify(inter)}`);
    if (a.meses_cargas?.length && a.meses_gps?.length && !a.alineado) desalineados++;

    // B4 - consumo_real reproduce su propia fórmula sobre la base alineada
    if (m.consumo_real > 0) {
        conConsumo++;
        const esperado = m.tipo_calculo === 'L/100Km'
            ? (m.litros_alineados / m.km_alineados) * 100
            : m.litros_alineados / m.horas_alineadas;
        check('consumo', `${id}: consumo_real = litros_alin / actividad_alin`, casi(m.consumo_real, esperado, 1e-9),
            `${m.consumo_real} vs ${esperado} (${m.tipo_calculo})`);
        check('consumo', `${id}: con consumo calculado no queda motivo_sin_calculo`, !m.motivo_sin_calculo,
            String(m.motivo_sin_calculo));
    }

    // B5 - las dos unidades salen de la MISMA base alineada
    if (m.horas_alineadas > 0 && m.litros_alineados > 0) {
        check('consumo', `${id}: consumo_l_hora = litros_alin / horas_alin`,
            casi(m.consumo_l_hora, m.litros_alineados / m.horas_alineadas), `${m.consumo_l_hora}`);
    } else check('consumo', `${id}: sin horas alineadas => consumo_l_hora en 0`, m.consumo_l_hora === 0, `${m.consumo_l_hora}`);
    if (m.km_alineados > 0 && m.litros_alineados > 0) {
        check('consumo', `${id}: consumo_l_100km = litros_alin / km_alin * 100`,
            casi(m.consumo_l_100km, (m.litros_alineados / m.km_alineados) * 100), `${m.consumo_l_100km}`);
    } else check('consumo', `${id}: sin km alineados => consumo_l_100km en 0`, m.consumo_l_100km === 0, `${m.consumo_l_100km}`);

    // B6 - desvío contra la meta
    if (m.desvio_pct !== null) {
        const meta = f.confirmed?.valor;
        check('meta', `${id}: desvio = (real / meta - 1) * 100`,
            meta > 0 && casi(m.desvio_pct, ((m.consumo_real / meta) - 1) * 100), `${m.desvio_pct} con meta ${meta}`);
    }

    // B7 - el desglose de horas cierra
    const gpsList = f.gps || [];
    let r = 0, mo = 0, p = 0, t = 0;
    gpsList.forEach(g => {
        if (g.horas && typeof g.horas === 'object') { r += g.horas.ralenti || 0; mo += g.horas.movimiento || 0; p += g.horas.parado || 0; t += g.horas.total || 0; }
    });
    check('horas', `${id}: ralenti + movimiento + parado = total`, casi(t, r + mo + p, 1e-6, 0.05),
        `${t} vs ${r}+${mo}+${p}=${r + mo + p}`);
    check('horas', `${id}: total_horas de las metricas = suma del GPS`, casi(m.total_horas, t, 1e-6, 0.05),
        `${m.total_horas} vs ${t}`);
    if (p > 0.05) aviso('horas', `${id}: el GPS reporta ${p.toFixed(1)} hs "parado"`,
        `total_horas (${t.toFixed(1)}) las incluye; el paso mostrado al usuario solo nombra ralenti + movimiento (${(r + mo).toFixed(1)})`);

    // B8 - el PASO que se le muestra al usuario reproduce el número que la app publica
    if (m.consumo_real > 0) {
        const pasoDiv = (m.pasos || []).find(x => /^Dividir litros por/.test(x.texto));
        if (pasoDiv) {
            const mostrado = numEsAR(pasoDiv.resultado);
            check('trazabilidad', `${id}: el paso "${pasoDiv.texto}" muestra el consumo publicado`,
                casi(mostrado, Math.round(m.consumo_real * 100) / 100, 1e-9, 0.011), `paso dice ${mostrado}, metrica ${m.consumo_real}`);
            const ops = String(pasoDiv.calculo).split('÷').map(numEsAR);
            check('trazabilidad', `${id}: el numerador del paso son los litros alineados`,
                casi(ops[0], m.litros_alineados, 1e-9, 0.06), `paso ${ops[0]} vs ${m.litros_alineados}`);
            const denomEsperado = m.tipo_calculo === 'L/100Km' ? m.km_alineados : m.horas_alineadas;
            check('trazabilidad', `${id}: el denominador del paso es la actividad alineada`,
                casi(ops[1], denomEsperado, 1e-9, 0.6), `paso ${ops[1]} vs ${denomEsperado}`);
        }
        const pasoHoras = (m.pasos || []).find(x => x.texto === 'Sumar las horas del GPS');
        if (pasoHoras) {
            const partes = String(pasoHoras.calculo).split('+').map(numEsAR);
            const suma = partes.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
            const resultado = numEsAR(pasoHoras.resultado);
            check('trazabilidad', `${id}: el paso de horas suma lo que dice sumar`,
                casi(suma, resultado, 1e-9, 0.11), `"${pasoHoras.calculo}" = ${suma} pero muestra ${resultado}`);
        }
    }

    // B9 - cantidades alineadas <= cantidades totales
    check('alineacion', `${id}: cargas alineadas <= cargas`, m.cantidad_cargas_alineadas <= m.cantidad_cargas, '');
    check('alineacion', `${id}: GPS alineados <= GPS`, m.cantidad_gps_alineados <= m.cantidad_gps, '');
}

// ============================================================ C. AGREGACIÓN DE FLOTA
{
    const sum = (fn) => filas.reduce((s, f) => s + fn(f.metrics), 0);
    const litrosHuerfanos = totales.huerfanos.reduce((s, h) => s + (h.litros || 0), 0);
    check('flota', 'suma de litros por equipo + huerfanos = total de la flota',
        casi(sum(m => m.total_litros) + litrosHuerfanos, totales.total_litros, 1e-9, 0.05),
        `${sum(m => m.total_litros) + litrosHuerfanos} vs ${totales.total_litros}`);
    const sinAsig = totales.sin_asignar || { litros: 0, km: 0, horas: 0 };
    check('flota', 'suma de km por equipo + km sin asignar = total de km de la flota',
        casi(sum(m => m.total_km) + sinAsig.km, totales.total_km, 1e-9, 0.05), `${sum(m => m.total_km) + sinAsig.km} vs ${totales.total_km}`);
    check('flota', 'suma de horas por equipo + horas sin asignar = total de horas de la flota',
        casi(sum(m => m.total_horas) + sinAsig.horas, totales.total_horas, 1e-9, 0.05), `${sum(m => m.total_horas) + sinAsig.horas} vs ${totales.total_horas}`);
    check('flota', 'lo sin asignar coincide con la suma de los huerfanos',
        casi(sinAsig.litros, litrosHuerfanos, 1e-9, 0.05), `${sinAsig.litros} vs ${litrosHuerfanos}`);
    // Km y horas sin asignar dejaron de ser invisibles: tiene que existir el hallazgo que los nombra.
    if (sinAsig.km > 0 || sinAsig.horas > 0) {
        check('diagnostico', 'los km/horas sin asignar producen el hallazgo huerfanos_gps',
            hallazgos.some(h => h.id === 'huerfanos_gps'), `sin_asignar = ${sinAsig.km} km / ${sinAsig.horas} hs y no hay hallazgo`);
    }
    check('flota', 'suma de cargas por equipo + huerfanas = cantidad de cargas',
        sum(m => m.cantidad_cargas) + totales.huerfanos.reduce((s, h) => s + h.cargas, 0) === totales.cantidad_cargas,
        `${sum(m => m.cantidad_cargas)} + huerfanas vs ${totales.cantidad_cargas}`);

    const desgComb = totales.combustible_desglose.reduce((s, b) => s + b.litros, 0);
    check('flota', 'el desglose por combustible suma los litros de la flota',
        casi(desgComb, totales.total_litros, 1e-9, 0.05), `${desgComb} vs ${totales.total_litros}`);
    const desgCombCosto = totales.combustible_desglose.reduce((s, b) => s + b.costo, 0);
    check('flota', 'el desglose por combustible suma el costo de la flota',
        casi(desgCombCosto, totales.total_costo, 1e-9, 0.05), `${desgCombCosto} vs ${totales.total_costo}`);
    const desgLugar = totales.lugar_desglose.reduce((s, b) => s + b.litros, 0);
    check('flota', 'el desglose por lugar suma los litros de la flota',
        casi(desgLugar, totales.total_litros, 1e-9, 0.05), `${desgLugar} vs ${totales.total_litros}`);
    const desgLugarCosto = totales.lugar_desglose.reduce((s, b) => s + b.costo, 0);
    check('flota', 'el desglose por lugar suma el costo de la flota',
        casi(desgLugarCosto, totales.total_costo, 1e-9, 0.05), `${desgLugarCosto} vs ${totales.total_costo}`);
    check('flota', 'los dos desgloses (combustible y lugar) coinciden entre si',
        casi(desgComb, desgLugar, 1e-9, 0.05), `${desgComb} vs ${desgLugar}`);
    totales.lugar_desglose.forEach(l => {
        const dentro = l.combustibles.reduce((s, c) => s + c.litros, 0);
        check('flota', `lugar "${l.lugar}": el detalle por combustible suma sus litros`,
            casi(dentro, l.litros, 1e-9, 0.05), `${dentro} vs ${l.litros}`);
    });
    // Reconciliacion total contra la planilla: nada de lo importado puede desaparecer sin
    // que algun campo publicado lo explique (dentro del periodo, fuera del periodo, o excluido).
    const fp = totales.fuera_de_periodo || { litros: 0, costo: 0 };
    const cargasUtiles = rawRecords.filter(r => r.type === 'carga' && !r._dupe_exacta && !((parseFloat(r.litros) || 0) === 0 && (parseFloat(r.importe) || 0) === 0));
    const litrosPlanilla = cargasUtiles.reduce((s, c) => s + (parseFloat(c.litros) || 0), 0);
    check('flota', 'litros del periodo + litros fuera del periodo = litros de la planilla',
        casi(totales.total_litros + fp.litros, litrosPlanilla, 1e-9, 0.05),
        `${totales.total_litros} + ${fp.litros} vs ${litrosPlanilla}`);
    const costoPlanilla = cargasUtiles.reduce((s, c) => s + (parseFloat(c.importe) || 0), 0);
    check('flota', 'costo del periodo + costo fuera del periodo = costo de la planilla',
        casi(totales.total_costo + fp.costo, costoPlanilla, 1e-9, 0.05),
        `${totales.total_costo} + ${fp.costo} vs ${costoPlanilla}`);
    // Los litros fuera del periodo tienen que estar dichos en alguna parte: el hallazgo
    // meses_sin_gps los nombra y ademas explica que no entran en los KPI.
    if (fp.litros > 0) {
        const h = hallazgos.find(x => x.id === 'meses_sin_gps');
        check('diagnostico', 'los litros fuera del periodo se avisan en meses_sin_gps', !!h, 'no hay hallazgo');
        if (h) check('diagnostico', 'meses_sin_gps menciona las cargas fuera del periodo y el KPI',
            (/fuera de los KPI/.test(String(h.detalle)) || /fuera del per[ií]odo analizado/.test(String(h.detalle))) && /KPI/.test(String(h.detalle)),
            String(h.detalle).slice(0, 120));
    }

    check('flota', 'costo por litro = costo total / litros totales',
        casi(totales.costo_por_litro, totales.total_costo / totales.total_litros), '');
    check('flota', 'horas de flota: ralenti + movimiento <= total',
        totales.horas_ralenti + totales.horas_movimiento <= totales.total_horas + Math.max(0.05, totales.cantidad_gps * 0.01),
        `${totales.horas_ralenti} + ${totales.horas_movimiento} vs ${totales.total_horas}`);
}

// ============================================================ D. CAPA DE DIAGNÓSTICO
for (const f of filas) {
    const id = f.equipo.interno;
    const m = f.metrics;

    const cob = coberturaEquipo(f, periodo);
    if (cob) {
        // diasPonderados: Lun-Vie=1, Sab=0.5 (jornada confirmada por operaciones)
        const denomCob = cob.diasPonderados ?? cob.diasHabiles;
        check('cobertura', `${id}: pct = dias con carga / dias habiles ponderados`,
            cob.pct === Math.round((cob.diasConCarga / Math.max(0.5, cob.diasTrabajados ?? denomCob)) * 100), `${cob.pct}`);
        if (cob.exceso) aviso('cobertura', `${id}: cobertura ${cob.pct}% (>100%)`,
            `${cob.diasConCarga} dias con carga sobre ${Math.round(denomCob)} dias habiles ponderados`);
    }

    const uti = utilizacion(f, periodo, f.ubicacion);
    if (uti) {
        // diasPonderados: Lun-Vie=1, Sab=0.5 (denominador correcto cuando GPS incluye sábados)
        const denomUti = uti.diasPonderados ?? uti.diasHabiles;
        check('utilizacion', `${id}: hs/dia = horas / dias habiles ponderados del MISMO tramo`,
            casi(uti.hsPorDia, uti.horas / denomUti), `${uti.hsPorDia}`);
        if (uti.hsPorDia > 24) check('utilizacion', `${id}: >24 hs/dia queda marcado como no representativo`,
            uti.estado === 'no_representativa', `${uti.hsPorDia.toFixed(1)} hs/dia con estado ${uti.estado}`);
    }

    // El exceso de litros contra la meta: sus dos lados tienen que salir del mismo tramo,
    // igual que el consumo.
    const exc = calcularExceso(f);
    if (exc) {
        const meta = f.confirmed.valor;
        // Invariante 1: los dos lados de la resta salen del MISMO tramo de meses.
        const actEsperada = m.tipo_calculo === 'L/100Km' ? m.km_alineados : m.horas_alineadas;
        const esperadoAlin = m.tipo_calculo === 'L/100Km' ? (meta * m.km_alineados) / 100 : meta * m.horas_alineadas;
        check('exceso', `${id}: litros esperados = meta * actividad ALINEADA`, casi(exc.litros_esperados, esperadoAlin), 
            `${exc.litros_esperados} vs ${esperadoAlin}`);
        check('exceso', `${id}: exceso = litros alineados - litros esperados`,
            casi(exc.exceso_litros, m.litros_alineados - esperadoAlin, 1e-9, 1e-6), `${exc.exceso_litros}`);
        check('exceso', `${id}: la actividad usada es la alineada`, casi(exc.actividad, actEsperada), `${exc.actividad} vs ${actEsperada}`);
        check('exceso', `${id}: los litros fuera de base son los del periodo menos la base`,
            casi(exc.litros_fuera_de_base, Math.max(0, m.total_litros - m.litros_alineados), 1e-9, 1e-6), `${exc.litros_fuera_de_base}`);
    }

    const imp = actividadImplicita(f);
    if (imp) {
        check('estimacion', `${id}: actividad implicita finita y positiva`, Number.isFinite(imp.valor) && imp.valor >= 0, `${imp.valor}`);
        const meta = f.confirmed.valor;
        const esperado = imp.unidad === 'horas' ? m.total_litros / meta : (m.total_litros / meta) * 100;
        check('estimacion', `${id}: actividad implicita = litros / meta`, casi(imp.valor, esperado), `${imp.valor} vs ${esperado}`);
    }
}

// ============================================================ E. HALLAZGOS
{
    const ids = hallazgos.map(h => h.id);
    check('diagnostico', 'ningun hallazgo duplicado por id', new Set(ids).size === ids.length,
        ids.filter((x, i) => ids.indexOf(x) !== i).join(', '));
    hallazgos.forEach(h => {
        check('diagnostico', `hallazgo "${h.id}": tiene titulo y severidad`, !!h.titulo && !!h.severidad, JSON.stringify({ t: h.titulo, s: h.severidad }));
        const txt = String(h.detalle || '');
        check('diagnostico', `hallazgo "${h.id}": el detalle no imprime NaN/undefined/Infinity`,
            !/\b(NaN|undefined|Infinity)\b/.test(txt), txt.slice(0, 160));
    });
    const conNaN = filas.filter(f => (f.metrics.pasos || []).some(p => /\b(NaN|undefined|Infinity)\b/.test(`${p.calculo} ${p.resultado} ${p.nota || ''}`)));
    check('diagnostico', 'ningun paso de calculo imprime NaN/undefined/Infinity',
        conNaN.length === 0, conNaN.map(f => f.equipo.interno).join(', '));
}

// ============================================================ F. INTEGRIDAD DE REGISTROS
{
    const cargas = rawRecords.filter(r => r.type === 'carga' && !r._dupe_exacta);
    const negL = cargas.filter(c => (parseFloat(c.litros) || 0) < 0);
    check('registros', 'ninguna carga con litros negativos', negL.length === 0, negL.length + ' filas');
    const negI = cargas.filter(c => (parseFloat(c.importe) || 0) < 0);
    check('registros', 'ninguna carga con importe negativo', negI.length === 0, negI.length + ' filas');
    const gps = rawRecords.filter(r => r.type === 'gps' && !r._dupe_exacta);
    const negKm = gps.filter(g => (parseFloat(g.distancia) || 0) < 0);
    check('registros', 'ningun GPS con km negativos', negKm.length === 0, negKm.length + ' filas');
    const horasImposibles = gps.filter(g => {
        const ms = mesesDeRegistro(g).length || 1;
        return (g.horas?.total || 0) > ms * 31 * 24 + 1;
    });
    check('registros', 'ningun GPS con mas horas que las que tiene su propio periodo',
        horasImposibles.length === 0, horasImposibles.map(g => `${g.interno}:${(g.horas?.total || 0).toFixed(0)}h`).slice(0, 8).join(', '));
    const sinFecha = cargas.filter(c => !c.fecha);
    check('registros', 'ninguna carga sin fecha', sinFecha.length === 0, sinFecha.length + ' filas');
    const desfasadas = cargas.filter(c => {
        const l = parseFloat(c.litros) || 0, i = parseFloat(c.importe) || 0, p = parseFloat(c.precio_unitario) || 0;
        if (l <= 0 || i <= 0 || p <= 0) return false;
        return Math.abs((i / l) - p) / p > 0.02;
    });
    if (desfasadas.length) aviso('registros', `${desfasadas.length} carga(s) donde importe / litros no coincide con el precio unitario declarado (>2%)`,
        desfasadas.slice(0, 5).map(c => `${c.interno} ${c.fecha}: ${(parseFloat(c.importe) / parseFloat(c.litros)).toFixed(2)} vs ${c.precio_unitario}`).join(' | '));
}

// ============================================================ G. ALINEACIÓN, RECALCULADA A MANO
for (const f of filas.filter(x => (x.cargas || []).length && (x.gps || []).length)) {
    const rec = alinearCargasYGps(f.cargas, f.gps);
    const m = f.metrics;
    check('alineacion', `${f.equipo.interno}: alinearCargasYGps es determinista y coincide con lo publicado`,
        JSON.stringify(rec.meses) === JSON.stringify(m.alineacion.meses), `${JSON.stringify(rec.meses)} vs ${JSON.stringify(m.alineacion.meses)}`);
    const litros = rec.cargas.reduce((s, c) => s + (parseFloat(c.litros) || 0), 0);
    check('alineacion', `${f.equipo.interno}: litros alineados recalculados coinciden`,
        casi(litros, m.litros_alineados, 1e-9, 0.05), `${litros} vs ${m.litros_alineados}`);
}

// ============================================================ H. ROSTER DE ARIDOS Y JORNADA
// La jornada extendida de feb-jun se decide por el SECTOR que resuelve la app, y ese sector sale
// de las cargas del equipo, no del maestro. Un equipo que cargo esporadicamente en otro sector
// puede cambiar de lado sin que nadie lo note: la excepcion dejaria de aplicarle, su umbral
// volveria a 10-12 y aparecerian o desapareceria del hallazgo de subutilizacion en silencio.
//
// Esto no lo puede ver auditar-declarados.mjs, que arma sus equipos a mano y nunca toca los
// archivos reales. Aca el roster se fija contra los datos de verdad.
//
// La lista la declaro el usuario. Las mezclas de sector son reales y estan medidas: TR32 tiene 38
// cargas en CEMENTO sobre 179, TR23 tiene 2 en TUNUYAN, CF37 una en ALTAMIRA. La mayoria manda, y
// ese es justamente el comportamiento que hay que congelar.
{
    const RIPIERA = ['CF25', 'CF27', 'CF37', 'EX01', 'TP01', 'VL09', 'VL10', 'MX102', 'MX83', 'MX89', 'CM42'];
    const BATEAS = ['TR14', 'TR18', 'TR20', 'TR21', 'TR23', 'TR32', 'TR35'];
    const SIN_JORNADA_ARIDOS = ['GE01', 'GE02', 'GE03'];
    const filaDe = interno => filas.find(x => x.equipo.interno_key === normKey(interno));

    for (const interno of [...RIPIERA, ...BATEAS, ...SIN_JORNADA_ARIDOS]) {
        const f = filaDe(interno);
        check('roster_aridos', `${interno}: sigue estando en el analisis`, !!f, 'no aparece');
        if (!f) continue;
        check('roster_aridos', `${interno}: la app lo sigue resolviendo al sector ARIDOS`,
            String(sectorDe(f.equipo, f.ubicacion)).includes('ARIDOS'), sectorDe(f.equipo, f.ubicacion));
    }

    // Los de la ripiera toman la jornada extendida en el tramo, y solo en el tramo.
    for (const interno of RIPIERA) {
        const f = filaDe(interno); if (!f) continue;
        const feb = jornadaDelMes(f.equipo, f.ubicacion, '2026-02');
        const ago = jornadaDelMes(f.equipo, f.ubicacion, '2026-08');
        check('roster_aridos', `${interno}: jornada extendida en feb (dentro del tramo)`,
            feb && feb.min === 12 && feb.max === 13, `${feb && feb.min}-${feb && feb.max}`);
        check('roster_aridos', `${interno}: jornada habitual en ago (fuera del tramo)`,
            ago && ago.min === 10 && ago.max === 12, `${ago && ago.min}-${ago && ago.max}`);
    }

    // Las bateas NO la toman en ningun mes: se midio que sus horas de motor por dia habil se
    // mantuvieron entre 8,5 y 9,9 todo el año.
    for (const interno of BATEAS) {
        const f = filaDe(interno); if (!f) continue;
        const feb = jornadaDelMes(f.equipo, f.ubicacion, '2026-02');
        const base = jornadaEsperada(f.equipo, f.ubicacion);
        check('roster_aridos', `${interno}: la batea NO toma la jornada extendida`,
            feb && base && feb.min === base.min && feb.max === base.max,
            `${feb && feb.min}-${feb && feb.max} vs base ${base && base.min}-${base && base.max}`);
    }

    // Los grupos electrogenos de ARIDOS no tienen jornada y la excepcion no puede darles una:
    // un GE puede quedar encendido de corrido, medirlo en horas por dia habil no significa nada.
    for (const interno of SIN_JORNADA_ARIDOS) {
        const f = filaDe(interno); if (!f) continue;
        check('roster_aridos', `${interno}: sigue sin jornada pese a estar en ARIDOS`,
            jornadaDelMes(f.equipo, f.ubicacion, '2026-02') === null,
            JSON.stringify(jornadaDelMes(f.equipo, f.ubicacion, '2026-02')));
    }
}

// ============================================================ REPORTE
console.log(`Chequeos corridos: ${chequeos}`);
console.log(`Equipos con consumo calculable: ${conConsumo} . con periodos desalineados: ${desalineados}`);

if (avisos.length) {
    console.log(`\n--- AVISOS (${avisos.length}) - no rompen una regla, pero merecen decision ---`);
    const porGrupo = new Map();
    avisos.forEach(a => { if (!porGrupo.has(a.grupo)) porGrupo.set(a.grupo, []); porGrupo.get(a.grupo).push(a); });
    for (const [g, lista] of porGrupo) {
        console.log(`\n[${g}] ${lista.length} aviso(s)`);
        lista.slice(0, 12).forEach(a => console.log(`  . ${a.nombre}\n      ${a.detalle}`));
        if (lista.length > 12) console.log(`  ... y ${lista.length - 12} mas`);
    }
}

if (fallas.length) {
    console.error(`\n=== ${fallas.length} INCOHERENCIA(S) ===`);
    const porGrupo = new Map();
    fallas.forEach(a => { if (!porGrupo.has(a.grupo)) porGrupo.set(a.grupo, []); porGrupo.get(a.grupo).push(a); });
    for (const [g, lista] of porGrupo) {
        console.error(`\n[${g}] ${lista.length} falla(s)`);
        lista.slice(0, 15).forEach(a => console.error(`  X ${a.nombre}\n      ${a.detalle}`));
        if (lista.length > 15) console.error(`  ... y ${lista.length - 15} mas`);
    }
    process.exit(1);
}
console.log('\nOK - todos los calculos son coherentes entre si y con sus formulas.');
