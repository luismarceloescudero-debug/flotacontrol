/**
 * Buscador de cargas fila por fila, con la referencia exacta para ir a corregirlas.
 *
 * Responde la pregunta que ni el panel ni `reporte-mensual.mjs` contestan: *cuál* carga está mal.
 * El panel agrega por equipo y por mes; el reporte mensual agrega por mes. Cuando un equipo
 * aparece en un centro de costo que no le corresponde ("TR35 en MIXER"), lo que hace falta es la
 * fila: fecha, hora, litros, importe, lugar, chofer, archivo y **número de fila de Excel**, que es
 * lo único con lo que se puede abrir la planilla y editarla.
 *
 * No reimplementa nada: corre el pipeline real (xlsx-parser → database) igual que
 * `reporte-mensual.mjs`, así que lo que imprime es exactamente lo que la app leyó — incluidos los
 * duplicados exactos que el import aparta, que se marcan pero no se ocultan.
 *
 * Solo carga Cargas + Equipos: ni GPS ni Loop intervienen, así que corre en segundos.
 *
 *   node tools/buscar-cargas.mjs TR35 --centro MIXER     # la carga que no corresponde
 *   node tools/buscar-cargas.mjs TR35                    # todas las de un equipo, con su reparto
 *   node tools/buscar-cargas.mjs TR --lugar TUNUYAN      # todos los tractores en un lugar
 *   node tools/buscar-cargas.mjs --centro ALTAMIRA       # gasto de un tercero
 *   node tools/buscar-cargas.mjs --sin-centro            # cargas sin centro de costo
 *   node tools/buscar-cargas.mjs VL11 --mes 2026-02      # un equipo en un mes
 *   node tools/buscar-cargas.mjs --csv <ruta>            # además, CSV (OJO: son datos de flota)
 *
 * Los filtros de texto son "contiene", sin acentos y sin distinguir mayúsculas (normalizeString),
 * y se combinan con Y. El filtro de equipo es por prefijo de clave normalizada, así que "TR"
 * agarra todos los tractores y "TR35" agarra TR-35, TR 35 y TR035 por igual.
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
const { normalizeEquipoKey, normalizeString } = await import('../js/data/normalizer.js');

// ---------------------------------------------------------------- argumentos
const argv = process.argv.slice(2);
const opciones = {};
const sueltos = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { sueltos.push(a); continue; }
    const nombre = a.slice(2);
    if (nombre === 'sin-centro' || nombre === 'incluir-duplicados') opciones[nombre] = true;
    else opciones[nombre] = argv[++i] || '';
}

const equipoFiltro = sueltos[0] || null;
const equipoKey = equipoFiltro ? normalizeEquipoKey(equipoFiltro) : null;

const TEXTO = { centro: 'centro_costo', lugar: 'lugar_carga', sector: 'sector', chofer: 'chofer', combustible: 'combustible', tipo: 'tipo', dominio: 'dominio' };

const nf = (v, d = 1) => (v || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Reparto de un campo entre las filas encontradas, de mayor a menor. Es lo que convierte
 *  "TR35 tiene una carga rara" en "TR35: 168 en ARIDOS, 1 en MIXER" — sin ese contraste, una
 *  fila suelta no se distingue de un equipo que realmente trabaja en dos lados. */
function reparto(filas, campo) {
    const c = new Map();
    for (const f of filas) {
        const v = f[campo] || '(vacío)';
        if (!c.has(v)) c.set(v, { n: 0, litros: 0, importe: 0 });
        const g = c.get(v);
        g.n++; g.litros += f.litros || 0; g.importe += f.importe || 0;
    }
    return [...c.entries()].sort((a, b) => b[1].n - a[1].n);
}

async function main() {
    if (!existsSync(ARCHIVOS)) {
        console.error(`No existe ${ARCHIVOS}. Este buscador necesita las planillas reales al lado del repo (ver CLAUDE.md).`);
        process.exit(1);
    }
    await initDB();

    const QUIERO = /^(Cargas_Combustible_|Equipos HSV)/i;
    const archivos = readdirSync(ARCHIVOS).filter(f => /\.xlsx$/i.test(f) && QUIERO.test(f));
    if (!archivos.length) {
        console.error(`No hay planillas de Cargas en ${ARCHIVOS}.`);
        process.exit(1);
    }
    for (const nombre of archivos) {
        const buf = readFileSync(path.join(ARCHIVOS, nombre));
        await parseXLSX({ name: nombre, __buffer: buf });
    }

    const [equipos, rawRecords] = await Promise.all([getAllEquipos(), getAllRawRecords()]);
    const porKey = new Map(equipos.map(e => [e.interno_key, e]));

    let filas = rawRecords.filter(r => r.type === 'carga');
    // Los duplicados exactos están apartados del análisis, pero siguen siendo filas de la planilla:
    // si una de ellas es la que hay que editar, esconderla sería justamente lo contrario de lo que
    // este buscador existe para hacer. Se marcan y se listan aparte del total.
    if (!opciones['incluir-duplicados']) filas = filas.filter(r => !r._dupe_exacta);

    if (equipoKey) filas = filas.filter(r => (r.interno_key || r.dominio_key || '').startsWith(equipoKey));
    for (const [op, campo] of Object.entries(TEXTO)) {
        if (!opciones[op]) continue;
        const buscado = normalizeString(opciones[op]);
        filas = filas.filter(r => normalizeString(r[campo]).includes(buscado));
    }
    if (opciones['sin-centro']) filas = filas.filter(r => !normalizeString(r.centro_costo));
    if (opciones.mes) filas = filas.filter(r => (r.periodo || '') === opciones.mes);

    filas.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || String(a.hora || '').localeCompare(String(b.hora || '')));

    const criterios = [
        equipoFiltro ? `equipo ${equipoFiltro}` : null,
        ...Object.keys(TEXTO).filter(o => opciones[o]).map(o => `${o} contiene "${opciones[o]}"`),
        opciones['sin-centro'] ? 'sin centro de costo' : null,
        opciones.mes ? `mes ${opciones.mes}` : null
    ].filter(Boolean);

    console.log(`\n=== CARGAS ENCONTRADAS ===`);
    console.log(criterios.length ? `Filtro: ${criterios.join(' · ')}` : 'Sin filtro: todas las cargas');
    console.log('');

    if (!filas.length) {
        console.log('Ninguna carga cumple ese filtro.');
        return;
    }

    for (const f of filas) {
        const eq = porKey.get(f.interno_key) || {};
        const ident = `${f.interno || '(sin interno)'} / ${f.dominio || eq.dominio || 's/dominio'}`;
        console.log(
            `fila ${String(f.fila_excel ?? '?').padStart(5)}  ${f.source_file}` +
            (f._dupe_exacta ? '   [DUPLICADO EXACTO: apartado del análisis]' : '')
        );
        console.log(
            `   ${f.fecha || 's/fecha'} ${(f.hora || '--:--').padEnd(5)}  ${ident.padEnd(22)}` +
            ` ${nf(f.litros).padStart(9)} L   $ ${nf(f.importe, 2).padStart(13)}` +
            (f.precio_unitario ? `   ($ ${nf(f.precio_unitario, 2)}/L)` : '')
        );
        console.log(
            `   combustible ${f.combustible || '-'} · lugar ${f.lugar_carga || '-'}` +
            ` · centro ${f.centro_costo || '(vacío)'} · sector ${f.sector || '-'}` +
            ` · tipo ${f.tipo || '-'} · chofer ${f.chofer || '-'}`
        );
        console.log('');
    }

    const litros = filas.reduce((s, f) => s + (f.litros || 0), 0);
    const importe = filas.reduce((s, f) => s + (f.importe || 0), 0);
    console.log(`TOTAL: ${filas.length} carga(s) · ${nf(litros)} L · $ ${nf(importe, 2)}`);

    // El reparto contrasta lo encontrado contra el resto de las cargas del mismo equipo: es lo que
    // distingue "una fila mal cargada" de "este equipo trabaja en dos centros de costo".
    if (equipoKey) {
        const todas = rawRecords.filter(r => r.type === 'carga' && !r._dupe_exacta &&
            (r.interno_key || r.dominio_key || '').startsWith(equipoKey));
        for (const [campo, titulo] of [['centro_costo', 'CENTRO DE COSTO'], ['lugar_carga', 'LUGAR DE CARGA']]) {
            const r = reparto(todas, campo);
            if (r.length < 2) continue;
            console.log(`\n${equipoFiltro} — reparto de sus ${todas.length} cargas por ${titulo}:`);
            for (const [v, g] of r) {
                console.log(`   ${String(v).padEnd(28)} ${String(g.n).padStart(4)} carga(s)  ${nf(g.litros).padStart(10)} L  $ ${nf(g.importe, 2).padStart(13)}`);
            }
        }
    }

    if (opciones.csv) {
        const cab = 'FILA_EXCEL;ARCHIVO;FECHA;HORA;INTERNO;DOMINIO;LITROS;IMPORTE;PRECIO_UNITARIO;COMBUSTIBLE;LUGAR_CARGA;CENTRO_COSTO;SECTOR;TIPO;CHOFER;DUPLICADO_EXACTO';
        const lineas = filas.map(f => [
            f.fila_excel ?? '', f.source_file, f.fecha || '', f.hora || '', f.interno || '', f.dominio || '',
            nf(f.litros), nf(f.importe, 2), nf(f.precio_unitario, 2), f.combustible || '', f.lugar_carga || '',
            f.centro_costo || '', f.sector || '', f.tipo || '', f.chofer || '', f._dupe_exacta ? 'SI' : ''
        ].join(';'));
        writeFileSync(opciones.csv, [cab, ...lineas].join('\n'), 'utf8');
        console.log(`\nCSV: ${opciones.csv}  (${filas.length} filas - son datos de flota, no commitear)`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
