/**
 * Reporte mensual por INTERNO + DOMINIO: litros, cargas y días trabajados.
 *
 * Responde la pregunta que el usuario hace todo el tiempo — "19 cargas / 23 días hábiles" — que
 * la app hoy solo contesta por equipo y por período completo, nunca mes a mes.
 *
 * No reimplementa nada: corre el pipeline real (xlsx-parser → database) igual que
 * `verificar-datos-reales.mjs`, y los días hábiles salen de `diasHabiles()` (feriados.js), que es
 * la única definición del repo — escribir un conteo de días acá sería violar la invariante 2.
 *
 * Solo carga las tres planillas que el reporte necesita (Cargas, Consumos Estimados, Equipos).
 * GPS y Loop no intervienen: este reporte es de litros y cargas, no de consumo. Por eso corre en
 * segundos y no en minutos.
 *
 *   node tools/reporte-mensual.mjs                 # toda la flota
 *   node tools/reporte-mensual.mjs TR18            # un equipo
 *   node tools/reporte-mensual.mjs TR              # todos los tractores
 *   node tools/reporte-mensual.mjs --csv <ruta>    # además, CSV (OJO: son datos de flota)
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
const { initDB, getAllEquipos, getAllRawRecords } = await import('../js/data/database.js');
const { diasHabiles } = await import('../js/data/feriados.js');
const { normalizeEquipoKey } = await import('../js/data/normalizer.js');

const MESES = ['', 'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
               'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

const args = process.argv.slice(2);
const csvIdx = args.indexOf('--csv');
const csvPath = csvIdx >= 0 ? args[csvIdx + 1] : null;
const filtro = args.filter((a, i) => !a.startsWith('--') && !(csvIdx >= 0 && i === csvIdx + 1))[0] || null;
const filtroKey = filtro ? normalizeEquipoKey(filtro) : null;

const nf = (v, d = 1) => v.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

/** El valor más frecuente de un campo entre las cargas del mes. Un equipo puede cambiar de centro
 *  de costo dentro del mes; el mayoritario es el que describe dónde estuvo trabajando. */
function moda(valores) {
    const c = new Map();
    for (const v of valores) { if (v) c.set(v, (c.get(v) || 0) + 1); }
    let mejor = '', max = 0;
    for (const [v, n] of c) if (n > max) { max = n; mejor = v; }
    return mejor;
}

async function main() {
    if (!existsSync(ARCHIVOS)) {
        console.error(`No existe ${ARCHIVOS}. Este reporte necesita las planillas reales al lado del repo (ver CLAUDE.md).`);
        process.exit(1);
    }
    await initDB();

    // Solo las tres que aportan al reporte. Cargar GPS y Loop acá costaría minutos y no cambiaría
    // un solo número de los que se imprimen.
    const QUIERO = /^(Cargas_Combustible_|Consumos Estimados|Equipos HSV)/i;
    const archivos = readdirSync(ARCHIVOS).filter(f => /\.xlsx$/i.test(f) && QUIERO.test(f));
    for (const nombre of archivos) {
        const buf = readFileSync(path.join(ARCHIVOS, nombre));
        await parseXLSX({ name: nombre, __buffer: buf });
    }

    const [equipos, rawRecords] = await Promise.all([getAllEquipos(), getAllRawRecords()]);
    const porKey = new Map(equipos.map(e => [e.interno_key, e]));

    // Un registro marcado como duplicado exacto ya fue apartado en el import: contarlo acá haría
    // que el reporte y el panel discrepen sobre los mismos litros.
    const cargas = rawRecords.filter(r => r.type === 'carga' && !r._dupe_exacta && r.periodo);

    // Agrupado por equipo + mes. La clave es interno_key (normalizeEquipoKey), nunca el string
    // crudo: las cuatro planillas escriben el mismo equipo de formas distintas.
    const grupos = new Map();
    for (const c of cargas) {
        const key = c.interno_key || c.dominio_key;
        if (!key) continue;
        if (filtroKey && !key.startsWith(filtroKey)) continue;
        const gk = `${key}|${c.periodo}`;
        if (!grupos.has(gk)) {
            grupos.set(gk, {
                key, periodo: c.periodo, interno: c.interno || '', dominio: c.dominio || '',
                litros: 0, importe: 0, cargas: 0, dias: new Set(),
                centros: [], sectores: [], combustibles: []
            });
        }
        const g = grupos.get(gk);
        g.litros += c.litros || 0;
        g.importe += c.importe || 0;
        g.cargas++;
        if (c.fecha) g.dias.add(c.fecha);
        if (!g.interno && c.interno) g.interno = c.interno;
        if (!g.dominio && c.dominio) g.dominio = c.dominio;
        g.centros.push(c.centro_costo);
        g.sectores.push(c.sector);
        g.combustibles.push(c.combustible);
    }

    // Días hábiles del mes: una sola vez por período, no por equipo.
    const cacheDH = new Map();
    function dhDe(ym) {
        if (!cacheDH.has(ym)) {
            const [anio, mes] = ym.split('-').map(Number);
            const ultimo = new Date(anio, mes, 0).getDate();
            cacheDH.set(ym, diasHabiles(`${ym}-01`, `${ym}-${String(ultimo).padStart(2, '0')}`));
        }
        return cacheDH.get(ym);
    }

    const filas = [...grupos.values()].map(g => {
        const dh = dhDe(g.periodo);
        const eq = porKey.get(g.key) || {};
        const mesNum = Number(g.periodo.split('-')[1]);
        return {
            ...g,
            diasConCarga: g.dias.size,
            dh,
            mesNombre: MESES[mesNum],
            anio: g.periodo.slice(0, 4),
            denominacion: eq.denominacion || '',
            dominioMaestro: eq.dominio || '',
            meta: eq.meta_valor || null,
            metaUnidad: eq.meta_unidad || '',
            centro: moda(g.centros),
            sector: moda(g.sectores),
            combustible: moda(g.combustibles)
        };
    }).sort((a, b) => (a.interno || '~' + a.key).localeCompare(b.interno || '~' + b.key) || a.periodo.localeCompare(b.periodo));

    if (!filas.length) {
        console.log(filtro ? `Sin cargas para "${filtro}".` : 'Sin cargas.');
        return;
    }

    console.log(`\n=== CARGAS MENSUALES POR INTERNO + DOMINIO ===`);
    console.log(`Jornada de referencia: Lun-Vie 8-12 hs (cuenta 1 dia) - Sab 4-6 hs (cuenta 0,5)`);
    if (filtro) console.log(`Filtro: ${filtro}`);
    console.log('');

    let equipoActual = null;
    for (const f of filas) {
        if (f.key !== equipoActual) {
            equipoActual = f.key;
            const dom = f.dominio || f.dominioMaestro || 's/dominio';
            const meta = f.meta ? ` - meta ${nf(f.meta, 2)} ${f.metaUnidad}` : ' - sin meta';
            console.log(`\n${f.interno || '(sin interno)'}  ${dom}   ${f.denominacion}${meta}`);
        }
        const d = f.dh;
        const pct = d.diasPonderados ? (f.diasConCarga / d.diasPonderados * 100) : 0;
        console.log(
            `   ${f.mesNombre.padEnd(10)} ${nf(f.litros).padStart(10)} L` +
            ` - ${String(f.cargas).padStart(3)} cargas / ${nf(d.diasPonderados, 1).padStart(5)} dias trabajados` +
            ` (${d.dias} habiles + ${d.sabados} sab x0,5)` +
            ` - cargo ${f.diasConCarga} dia${f.diasConCarga === 1 ? '' : 's'} (${nf(pct, 0)}%)` +
            (f.centro ? ` - ${f.centro}` : '')
        );
    }

    // Totales por mes, para leer de un vistazo un mes que se cayó.
    console.log(`\n\n=== TOTAL FLOTA POR MES ===`);
    const porMes = new Map();
    for (const f of filas) {
        if (!porMes.has(f.periodo)) porMes.set(f.periodo, { litros: 0, cargas: 0, equipos: new Set(), dh: f.dh, mesNombre: f.mesNombre });
        const m = porMes.get(f.periodo);
        m.litros += f.litros; m.cargas += f.cargas; m.equipos.add(f.key);
    }
    for (const [ym, m] of [...porMes.entries()].sort()) {
        console.log(`${m.mesNombre.padEnd(10)} ${ym}  ${nf(m.litros).padStart(11)} L - ${String(m.cargas).padStart(4)} cargas - ${String(m.equipos.size).padStart(3)} equipos - ${nf(m.dh.diasPonderados, 1)} dias trabajados`);
    }

    if (csvPath) {
        const cab = 'INTERNO;DOMINIO;DENOMINACION;ANIO;MES;PERIODO;LITROS;IMPORTE;CARGAS;DIAS_CON_CARGA;DIAS_HABILES;SABADOS;DIAS_TRABAJADOS;META;META_UNIDAD;CENTRO_COSTO;SECTOR;COMBUSTIBLE';
        const lineas = filas.map(f => [
            f.interno, f.dominio || f.dominioMaestro, f.denominacion, f.anio, f.mesNombre, f.periodo,
            nf(f.litros), nf(f.importe, 2), f.cargas, f.diasConCarga,
            f.dh.dias, f.dh.sabados, nf(f.dh.diasPonderados, 1),
            f.meta != null ? nf(f.meta, 2) : '', f.metaUnidad, f.centro, f.sector, f.combustible
        ].join(';'));
        writeFileSync(csvPath, [cab, ...lineas].join('\n'), 'utf8');
        console.log(`\nCSV: ${csvPath}  (${filas.length} filas - son datos de flota, no commitear)`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
