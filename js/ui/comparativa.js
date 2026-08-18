/**
 * Comparativa entre dos o más equipos.
 *
 * Responde a "¿cuánto más cargó / estuvo en ralentí / gastó este equipo que aquel otro,
 * en el mismo período?" poniendo lado a lado las métricas que ya calcula analizarFlota
 * (por eso respeta el filtro de período activo en el panel: años, meses o el rango manual).
 *
 * Se abre desde el botón "Comparar equipos" de la barra de herramientas (vacío) o desde el
 * ícono de comparar de una tarjeta (con ese equipo ya cargado); el resto se agrega a mano
 * buscando por interno, dominio o denominación.
 */
const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let filasRef = [];
let seleccion = [];   // internos, en el orden en que se agregaron
let overlay = null;

/**
 * Métricas mostradas, una fila por cada una. `get` saca el valor numérico de una fila de
 * analisis.filas (o null si no aplica a ese equipo). `mejorEsMenor` decide qué valor se
 * resalta como mejor/peor cuando hay al menos dos equipos con dato: true = menor es mejor
 * (ralentí, desvío, precio/L, consumo), null = no se juzga (litros, cargas, km: más actividad
 * no es ni bueno ni malo por sí solo).
 */
const METRICAS = [
    { key: 'litros', label: 'Litros reales', unidad: 'L', dec: 1, get: f => f.metrics.total_litros, mejorEsMenor: null },
    { key: 'costo', label: 'Costo total', unidad: '', dec: 0, money: true, get: f => f.metrics.total_costo, mejorEsMenor: null },
    { key: 'precio_litro', label: 'Precio por litro', unidad: '$/L', dec: 0, money: true, get: f => f.metrics.total_litros > 0 ? f.metrics.total_costo / f.metrics.total_litros : null, mejorEsMenor: true },
    { key: 'cargas', label: 'Cantidad de cargas', unidad: '', dec: 0, get: f => f.metrics.cantidad_cargas, mejorEsMenor: null },
    { key: 'gps', label: 'Registros GPS', unidad: '', dec: 0, get: f => f.metrics.cantidad_gps, mejorEsMenor: null },
    { key: 'km', label: 'Kilómetros', unidad: 'km', dec: 0, get: f => f.metrics.total_km > 0 ? f.metrics.total_km : null, mejorEsMenor: null },
    { key: 'horas', label: 'Horas totales (GPS)', unidad: 'hs', dec: 1, get: f => f.metrics.total_horas > 0 ? f.metrics.total_horas : null, mejorEsMenor: null },
    { key: 'ralenti', label: 'Horas en ralentí', unidad: 'hs', dec: 1, get: f => f.metrics.horas_ralenti, mejorEsMenor: true },
    { key: 'ralenti_pct', label: '% del tiempo en ralentí', unidad: '%', dec: 0, get: f => f.metrics.total_horas > 0 ? (f.metrics.horas_ralenti / f.metrics.total_horas * 100) : null, mejorEsMenor: true },
    { key: 'consumo', label: 'Consumo real', unidad: '', dec: 2, sufijo: f => f.metrics.tipo_calculo, get: f => f.metrics.consumo_real > 0 ? f.metrics.consumo_real : null, mejorEsMenor: true, unidadDe: f => f.metrics.tipo_calculo },
    { key: 'meta', label: 'Meta', unidad: '', dec: 2, get: f => f.confirmed && f.confirmed.valor > 0 ? f.confirmed.valor : null, mejorEsMenor: null, unidadDe: f => f.metrics.tipo_calculo },
    { key: 'desvio', label: 'Desvío vs meta', unidad: '%', dec: 1, signo: true, get: f => f.metrics.desvio_pct, mejorEsMenor: true }
];

/** Resumen en frases de las diferencias más relevantes, solo tiene sentido con exactamente 2 equipos. */
const RESUMEN_ITEMS = [
    { label: 'cargas', unidad: '', dec: 0, verbo: 'hizo', get: f => f.metrics.cantidad_cargas },
    { label: 'litros cargados', unidad: 'L', dec: 0, verbo: 'cargó', get: f => f.metrics.total_litros },
    { label: 'horas de ralentí', unidad: 'hs', dec: 0, verbo: 'acumuló', get: f => f.metrics.horas_ralenti },
    { label: 'costo de combustible', unidad: '', dec: 0, money: true, verbo: 'gastó', get: f => f.metrics.total_costo },
    { label: 'consumo real', unidad: '', dec: 2, verbo: 'consumió', sufijo: f => ` ${f.metrics.tipo_calculo}`, get: f => f.metrics.consumo_real > 0 ? f.metrics.consumo_real : null, unidadDe: f => f.metrics.tipo_calculo }
];

export function abrirComparativa(analisis, internosIniciales = []) {
    filasRef = analisis?.filas || [];
    seleccion = [...new Set(internosIniciales)].filter(i => filasRef.some(f => f.equipo.interno === i));
    cerrar();

    overlay = document.createElement('div');
    overlay.className = 'calc-overlay comparar-overlay';
    overlay.innerHTML = `
        <div class="comparar-panel">
            <div class="metas-head">
                <div>
                    <span class="calc-panel-label">Comparativa</span>
                    <h3>Comparar equipos</h3>
                    <p class="metas-sub">Agregá dos o más equipos para ponerlos lado a lado: cargas, litros reales, horas de ralentí, km/horas y consumo real, todo sobre el mismo período filtrado en el panel.</p>
                </div>
                <button class="btn-icon" data-cerrar><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="comparar-agregar">
                <div class="search-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="text" id="comparar-buscar" placeholder="Agregar equipo por interno, dominio o denominación..." list="equip-suggestions" autocomplete="off">
                </div>
                <button class="btn-secondary btn-sm" id="comparar-agregar-btn"><i class="fa-solid fa-plus"></i> Agregar</button>
            </div>
            <div class="comparar-chips" id="comparar-chips"></div>

            <div id="comparar-resumen"></div>

            <div class="table-responsive comparar-tabla">
                <table class="data-table" id="comparar-table"></table>
            </div>
        </div>`;

    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-cerrar]')) cerrar(); });
    document.addEventListener('keydown', escCierra);
    document.body.appendChild(overlay);

    const input = document.getElementById('comparar-buscar');
    const agregarDesdeInput = () => {
        const val = (input.value || '').trim().toUpperCase();
        if (!val) return;
        const fila = filasRef.find(f =>
            f.equipo.interno.toUpperCase() === val ||
            (f.equipo.dominio || '').toUpperCase() === val
        ) || filasRef.find(f =>
            f.equipo.interno.toUpperCase().includes(val) ||
            (f.equipo.denominacion || '').toUpperCase().includes(val)
        );
        if (!fila) {
            input.classList.add('input-error');
            setTimeout(() => input.classList.remove('input-error'), 600);
            return;
        }
        agregar(fila.equipo.interno);
        input.value = '';
        input.focus();
    };
    document.getElementById('comparar-agregar-btn').addEventListener('click', agregarDesdeInput);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); agregarDesdeInput(); } });

    pintar();
}

function escCierra(e) { if (e.key === 'Escape') cerrar(); }

function cerrar() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.removeEventListener('keydown', escCierra);
}

function agregar(interno) {
    if (!seleccion.includes(interno)) seleccion.push(interno);
    pintar();
}

function quitar(interno) {
    seleccion = seleccion.filter(i => i !== interno);
    pintar();
}

function pintar() {
    const chips = document.getElementById('comparar-chips');
    const resumenEl = document.getElementById('comparar-resumen');
    const tabla = document.getElementById('comparar-table');
    if (!chips || !tabla || !resumenEl) return;

    const filas = seleccion.map(i => filasRef.find(f => f.equipo.interno === i)).filter(Boolean);

    chips.innerHTML = filas.length ? filas.map(f => `
        <span class="comparar-chip">
            ${esc(f.equipo.interno)}<small>${esc(f.equipo.denominacion || '')}</small>
            <button data-quitar="${esc(f.equipo.interno)}" title="Quitar"><i class="fa-solid fa-xmark"></i></button>
        </span>`).join('') : '<span class="comparar-vacio">Todavía no agregaste ningún equipo. Buscá arriba por interno, dominio o denominación.</span>';

    chips.querySelectorAll('[data-quitar]').forEach(b => b.addEventListener('click', () => quitar(b.dataset.quitar)));

    resumenEl.innerHTML = resumenComparativo(filas);

    if (filas.length < 2) {
        tabla.innerHTML = `<caption class="comparar-caption">Agregá al menos dos equipos para ver la comparativa.</caption>`;
        return;
    }

    tabla.innerHTML = `
        <thead>
            <tr>
                <th>Métrica</th>
                ${filas.map(f => `<th>${esc(f.equipo.interno)}<div class="th-sub">${esc(f.equipo.dominio || f.equipo.denominacion || '')}</div></th>`).join('')}
            </tr>
        </thead>
        <tbody>
            ${METRICAS.map(m => filaMetrica(m, filas)).join('')}
        </tbody>`;
}

function filaMetrica(m, filas) {
    const valores = filas.map(m.get);
    // Consumo real y meta se miden en L/Hora o L/100Km según el equipo: si en la selección hay
    // equipos de ambos tipos, ese número no es comparable entre sí y no se resalta mejor/peor.
    const unidadesMezcladas = m.unidadDe && new Set(filas.map((f, i) => valores[i] !== null ? m.unidadDe(f) : null).filter(Boolean)).size > 1;
    const numericos = valores.filter(v => v !== null && v !== undefined && !isNaN(v));
    let mejor = null, peor = null;
    if (m.mejorEsMenor !== null && numericos.length >= 2 && !unidadesMezcladas) {
        mejor = m.mejorEsMenor ? Math.min(...numericos) : Math.max(...numericos);
        peor = m.mejorEsMenor ? Math.max(...numericos) : Math.min(...numericos);
    }
    return `<tr>
        <td class="cell-key">${esc(m.label)}</td>
        ${filas.map((f, i) => {
            const v = valores[i];
            if (v === null || v === undefined || isNaN(v)) return '<td class="cell-muted">—</td>';
            let cls = '';
            if (mejor !== null && peor !== null && mejor !== peor) {
                if (v === mejor) cls = 'cmp-best';
                else if (v === peor) cls = 'cmp-worst';
            }
            const num = m.signo && v >= 0 ? `+${nf(v, m.dec)}` : nf(v, m.dec);
            const txt = m.money ? `$${num}` : `${num}${m.unidad ? (m.unidad === '%' ? '%' : ` ${m.unidad}`) : ''}`;
            const suf = m.sufijo ? ` ${esc(m.sufijo(f))}` : '';
            return `<td class="${cls}">${txt}${suf}</td>`;
        }).join('')}
    </tr>`;
}

/** Frases tipo "MX101 hizo 27 cargas más que MX96 (+44%)". Solo con exactamente 2 equipos: con 3+ no hay un "más que" claro sin elegir un par. */
function resumenComparativo(filas) {
    if (filas.length !== 2) return '';
    const [a, b] = filas;

    const frases = RESUMEN_ITEMS.map(it => {
        const va = it.get(a), vb = it.get(b);
        if (va === null || vb === null || va === undefined || vb === undefined || isNaN(va) || isNaN(vb)) return null;
        // Consumo real solo se puede restar entre equipos medidos en la misma unidad (L/Hora vs L/100Km no son comparables).
        if (it.unidadDe && it.unidadDe(a) !== it.unidadDe(b)) return null;
        const diff = va - vb;
        if (Math.abs(diff) < 0.005) return null;
        const mayor = diff > 0 ? a : b;
        const menor = diff > 0 ? b : a;
        const base = Math.min(Math.abs(va), Math.abs(vb));
        const pct = base > 0.001 ? (Math.abs(diff) / base) * 100 : null;
        const valTxt = it.money ? `$${nf(Math.abs(diff), it.dec)}` : `${nf(Math.abs(diff), it.dec)}${it.unidad ? ' ' + it.unidad : ''}`;
        const sufTxt = it.sufijo ? it.sufijo(mayor) : '';
        return `<li><strong>${esc(mayor.equipo.interno)}</strong> ${it.verbo} ${valTxt}${sufTxt} más de ${esc(it.label)} que <strong>${esc(menor.equipo.interno)}</strong>${pct !== null ? ` <span class="cmp-pct">(+${nf(pct)}%)</span>` : ''}</li>`;
    }).filter(Boolean);

    if (!frases.length) return '';
    return `<ul class="comparar-resumen">${frases.join('')}</ul>`;
}
