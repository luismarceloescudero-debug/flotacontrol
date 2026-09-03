/**
 * Arnés de verificación contra datos reales.
 *
 * No reimplementa el parseo ni el análisis: corre el pipeline REAL de la app —
 * js/parsers/xlsx-parser.js → js/data/database.js (IndexedDB en memoria) → js/data/analyzer.js
 * → js/data/diagnostico.js — sobre los Excel reales de ../../ARCHIVOS/, exactamente como lo haría
 * el navegador al subirlos. La única pieza que se reemplaza es el almacenamiento: IndexedDB no
 * existe en Node, así que se usa `fake-indexeddb` (misma API, en memoria) en vez del navegador.
 * Todo lo que se mide entre esa capa y el resultado final es código real de la app, sin atajos.
 *
 * Uso:
 *   node tools/verificar-datos-reales.mjs            # corre y compara contra invariantes.json
 *   node tools/verificar-datos-reales.mjs --actualizar  # corre y REESCRIBE invariantes.json
 *
 * Sale con código 1 si algo no coincide con lo esperado (para usar en un hook o en CI).
 */
import 'fake-indexeddb/auto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ARCHIVOS = path.resolve(REPO, '..', '..', 'ARCHIVOS');
const INVARIANTES_PATH = path.join(__dirname, 'invariantes.json');

// La app carga xlsx.full.min.js como <script> global en index.html: acá se hace lo mismo a mano.
globalThis.XLSX = require(path.join(REPO, 'xlsx.full.min.js'));

// Shim mínimo de FileReader: xlsx-parser.js llama reader.readAsArrayBuffer(file) y espera
// reader.onload({target:{result: ArrayBuffer}}). Nada más de FileReader se usa en el proyecto.
class FileReaderShim {
    readAsArrayBuffer(file) {
        const buf = file.__buffer;
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        queueMicrotask(() => this.onload && this.onload({ target: { result: ab } }));
    }
}
globalThis.FileReader = FileReaderShim;

const { parseXLSX } = await import('../js/parsers/xlsx-parser.js');
const {
    initDB, getAllEquipos, getAllRawRecords, getAllEstimados,
    getRalentiEstados, getNoFlotaAceptados, getEquiposExcluidos, getAccionesAutomaticas
} = await import('../js/data/database.js');
const { analizarFlota } = await import('../js/data/analyzer.js');
const { generarDiagnostico, mediana } = await import('../js/data/diagnostico.js');
const { aplicarCorreccionesAutomaticas } = await import('../js/data/autocorreccion.js');

const ACTUALIZAR = process.argv.includes('--actualizar');

function num(v) { return Math.round(v * 10) / 10; }

async function main() {
    console.log(`Leyendo Excel reales desde ${ARCHIVOS}`);
    if (!existsSync(ARCHIVOS)) {
        console.error(`No existe ${ARCHIVOS}. Este arnés necesita las planillas reales al lado del repo (ver CLAUDE.md).`);
        process.exit(1);
    }

    await initDB();

    const archivos = readdirSync(ARCHIVOS).filter(f => /\.xlsx$/i.test(f));
    const resultadosArchivo = [];
    for (const nombre of archivos) {
        const buf = readFileSync(path.join(ARCHIVOS, nombre));
        const file = { name: nombre, __buffer: buf };
        try {
            const meta = await parseXLSX(file);
            resultadosArchivo.push({ archivo: nombre, tipo: meta.tipo, filas: meta.filas, etiqueta: meta.etiqueta });
            console.log(`  [${meta.tipo}] ${nombre}: ${meta.filas} filas`);
        } catch (e) {
            resultadosArchivo.push({ archivo: nombre, tipo: 'ERROR', filas: 0, error: e.message });
            console.error(`  [ERROR] ${nombre}: ${e.message}`);
        }
    }

    let [equipos, rawRecords, estimados, ralentiEstados, noFlotaAceptados, equiposExcluidos] = await Promise.all([
        getAllEquipos(), getAllRawRecords(), getAllEstimados(), getRalentiEstados(), getNoFlotaAceptados(), getEquiposExcluidos()
    ]);

    let analisis = analizarFlota({ equipos, rawRecords, estimados, filtro: { anio: null, periodos: [] } });

    // Diagnóstico automático (autocorreccion.js): mismo paso que hace renderPanel() antes de
    // mostrar nada — se ejercita acá para que el arnés detecte si alguna vez se onboardea un
    // interno de más, o se acepta un código que en realidad sí tenía que quedar para revisión
    // manual (patente real sin interno, que autocorreccion.js nunca debe tocar).
    const codigosAceptadosSet = new Set(noFlotaAceptados.map(n => n.codigo));
    const aplicado = await aplicarCorreccionesAutomaticas({
        equipos, huerfanos: analisis.totales.huerfanos, filas: analisis.filas, codigosAceptados: codigosAceptadosSet
    });
    if (aplicado.altas || aplicado.aceptados || aplicado.metas) {
        [equipos, noFlotaAceptados] = await Promise.all([getAllEquipos(), getNoFlotaAceptados()]);
        analisis = analizarFlota({ equipos, rawRecords, estimados, filtro: { anio: null, periodos: [] } });
    }
    const accionesAutomaticas = await getAccionesAutomaticas();

    const hallazgos = generarDiagnostico(analisis.filas, analisis.totales, rawRecords, ralentiEstados, noFlotaAceptados, equiposExcluidos, { accionesRecientes: accionesAutomaticas });

    const cargas = rawRecords.filter(r => r.type === 'carga');
    const gps = rawRecords.filter(r => r.type === 'gps');
    const entregas = rawRecords.filter(r => r.type === 'entrega');
    const conflictoRemito = entregas.filter(r => r._conflicto_remito);
    const dupExactas = rawRecords.filter(r => r._dupe_exacta);

    // Cobertura de GPS por mes: cuántas unidades tienen dato de km ese mes, sobre el total de
    // equipos activos en el maestro. Esto es lo que la Fase 3 va a mostrar como semáforo; acá
    // sirve para que el arnés detecte un mes que se cayó a la mitad, como pasó con julio.
    const porMes = new Map();
    gps.forEach(r => {
        if (!r.periodo) return;
        if (!porMes.has(r.periodo)) porMes.set(r.periodo, new Set());
        porMes.get(r.periodo).add(r.interno_key || r.interno);
    });
    // equiposExcluidos es un store separado (apartados a mano por el usuario), no un campo del
    // maestro — en una corrida en limpio como esta viene siempre vacío, así que el total activo
    // es el maestro completo menos lo que el propio usuario haya excluido en esta sesión.
    const excluidosSet = new Set(equiposExcluidos.map(e => e.interno));
    const totalEquiposActivos = equipos.filter(e => !excluidosSet.has(e.interno)).length;
    const coberturaGpsPorMes = [...porMes.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([mes, set]) => ({ mes, unidades: set.size, pct: totalEquiposActivos ? Math.round(set.size / totalEquiposActivos * 100) : null }));

    const litrosTotales = num(cargas.reduce((s, c) => s + (parseFloat(c.litros) || 0), 0));
    const volumenLoop = num(entregas.reduce((s, r) => s + (parseFloat(r.volumen) || 0), 0));

    const medido = {
        generado: new Date().toISOString(),
        archivos: resultadosArchivo,
        equipos_maestro: equipos.length,
        cargas: { filas: cargas.length, litros_totales: litrosTotales, sin_fecha: cargas.filter(c => !c.fecha).length, sin_litros: cargas.filter(c => !(parseFloat(c.litros) > 0)).length },
        gps: { filas_equipo_mes: gps.length, cobertura_por_mes: coberturaGpsPorMes },
        entregas_loop: { registros_finales: entregas.length, volumen_total_m3: volumenLoop, remitos_en_conflicto: new Set(conflictoRemito.map(r => r.remito)).size, filas_en_conflicto: conflictoRemito.length },
        duplicados_exactos_detectados: dupExactas.length,
        equipos_analizados: analisis.filas.length,
        hallazgos_generados: hallazgos.length,
        hallazgos_por_id: Object.fromEntries(hallazgos.map(h => [h.id, (hallazgos.filter(x => x.id === h.id).length)])),
        autocorreccion: { altas_interno: aplicado.altas, aceptados_no_flota: aplicado.aceptados, metas_alineadas: aplicado.metas },
        huerfanos_restantes: analisis.totales.huerfanos.length
    };

    console.log('\n=== REPORTE DE FUENTES ===');
    console.log(`Equipos en el maestro: ${medido.equipos_maestro}`);
    console.log(`Cargas: ${medido.cargas.filas} filas · ${medido.cargas.litros_totales.toLocaleString('es-AR')} L · sin fecha: ${medido.cargas.sin_fecha} · sin litros: ${medido.cargas.sin_litros}`);
    console.log(`GPS: ${medido.gps.filas_equipo_mes} filas equipo-mes`);
    medido.gps.cobertura_por_mes.forEach(m => {
        const alerta = m.pct !== null && m.pct < 70 ? '  <-- cobertura baja' : '';
        console.log(`  ${m.mes}: ${m.unidades} unidades${m.pct !== null ? ` (${m.pct}% del maestro activo)` : ''}${alerta}`);
    });
    console.log(`Entregas Loop: ${medido.entregas_loop.registros_finales} registros finales · ${medido.entregas_loop.volumen_total_m3.toLocaleString('es-AR')} m³ · ${medido.entregas_loop.remitos_en_conflicto} remitos en conflicto`);
    console.log(`Duplicados exactos detectados y excluidos automáticamente: ${medido.duplicados_exactos_detectados}`);
    console.log(`Diagnóstico: ${medido.equipos_analizados} equipos analizados, ${medido.hallazgos_generados} hallazgos generados`);
    console.log(`Autocorrección: ${medido.autocorreccion.altas_interno} interno(s) nuevo(s) dado(s) de alta · ${medido.autocorreccion.aceptados_no_flota} código(s) aceptado(s) automáticamente · ${medido.autocorreccion.metas_alineadas} meta(s) alineada(s) al real · ${medido.huerfanos_restantes} huérfanos siguen para revisión manual (patente sin interno)`);

    if (ACTUALIZAR || !existsSync(INVARIANTES_PATH)) {
        writeFileSync(INVARIANTES_PATH, JSON.stringify(medido, null, 2) + '\n');
        console.log(`\n${ACTUALIZAR ? 'Actualizadas' : 'Creadas'} las invariantes en tools/invariantes.json`);
        return;
    }

    console.log('\n=== COMPARANDO CONTRA tools/invariantes.json ===');
    const esperado = JSON.parse(readFileSync(INVARIANTES_PATH, 'utf8'));
    const fallas = [];

    const checar = (nombre, actual, esp, tolerancia = 0) => {
        const diff = Math.abs(actual - esp);
        if (diff > tolerancia) fallas.push(`${nombre}: esperado ${esp}, midió ${actual} (diferencia ${diff > 0 ? '+' : ''}${num(actual - esp)})`);
    };

    checar('equipos en el maestro', medido.equipos_maestro, esperado.equipos_maestro);
    checar('filas de cargas', medido.cargas.filas, esperado.cargas.filas);
    checar('litros totales de cargas', medido.cargas.litros_totales, esperado.cargas.litros_totales, 1);
    checar('cargas sin fecha', medido.cargas.sin_fecha, esperado.cargas.sin_fecha);
    checar('cargas sin litros', medido.cargas.sin_litros, esperado.cargas.sin_litros);
    checar('registros finales de entregas Loop', medido.entregas_loop.registros_finales, esperado.entregas_loop.registros_finales);
    checar('volumen total Loop (m³)', medido.entregas_loop.volumen_total_m3, esperado.entregas_loop.volumen_total_m3, 0.1);
    checar('remitos Loop en conflicto', medido.entregas_loop.remitos_en_conflicto, esperado.entregas_loop.remitos_en_conflicto);
    checar('equipos analizados', medido.equipos_analizados, esperado.equipos_analizados);
    checar('internos dados de alta automáticamente', medido.autocorreccion.altas_interno, esperado.autocorreccion.altas_interno);
    checar('códigos aceptados automáticamente', medido.autocorreccion.aceptados_no_flota, esperado.autocorreccion.aceptados_no_flota);
    checar('metas alineadas automáticamente', medido.autocorreccion.metas_alineadas, esperado.autocorreccion.metas_alineadas);
    checar('huérfanos restantes (patente sin interno)', medido.huerfanos_restantes, esperado.huerfanos_restantes);

    if (fallas.length) {
        console.error('\nFALLÓ LA VERIFICACIÓN:');
        fallas.forEach(f => console.error('  - ' + f));
        console.error('\nSi el cambio de número es intencional (subiste una planilla nueva, corregiste');
        console.error('una regla de cálculo a propósito), corré con --actualizar para fijar el nuevo');
        console.error('valor como esperado. Si NO lo es, hay un bug: no sigas.');
        process.exit(1);
    }
    console.log('OK — todo coincide con tools/invariantes.json');
}

main().catch(e => { console.error('Error corriendo el arnés:', e); process.exit(1); });
