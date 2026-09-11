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
import { coberturaEquipo, coberturaMensual, diasHabilesDeMeses, confiabilidad } from '../data/diagnostico.js';

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let filasRef = [];
let seleccion = [];   // internos, en el orden en que se agregaron
let overlay = null;
let periodoRef = null;  // {desde, hasta} del análisis activo — denominador de las tasas
// 'totales' compara lo que cada equipo hizo; 'normalizado' compara su RITMO. Un equipo con 3
// cargas y otro con 106 no son comparables por total —el segundo simplemente trabajó más— pero
// sí por litros/día trabajado. Ver regla 1 de la skill calculos-combustible.
let modo = 'totales';

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
    { key: 'precio_litro', esTasa: true, label: 'Precio por litro', unidad: '$/L', dec: 0, money: true, get: f => f.metrics.total_litros > 0 ? f.metrics.total_costo / f.metrics.total_litros : null, mejorEsMenor: true },
    { key: 'cargas', label: 'Cantidad de cargas', unidad: '', dec: 0, get: f => f.metrics.cantidad_cargas, mejorEsMenor: null },
    { key: 'gps', label: 'Registros GPS', unidad: '', dec: 0, get: f => f.metrics.cantidad_gps, mejorEsMenor: null },
    { key: 'km', label: 'Kilómetros', unidad: 'km', dec: 0, get: f => f.metrics.total_km > 0 ? f.metrics.total_km : null, mejorEsMenor: null },
    { key: 'horas', label: 'Horas totales (GPS)', unidad: 'hs', dec: 1, get: f => f.metrics.total_horas > 0 ? f.metrics.total_horas : null, mejorEsMenor: null },
    { key: 'ralenti', label: 'Horas en ralentí', unidad: 'hs', dec: 1, get: f => f.metrics.horas_ralenti, mejorEsMenor: true },
    { key: 'ralenti_pct', esTasa: true, label: '% del tiempo en ralentí', unidad: '%', dec: 0, get: f => f.metrics.total_horas > 0 ? (f.metrics.horas_ralenti / f.metrics.total_horas * 100) : null, mejorEsMenor: true },
    { key: 'consumo', esTasa: true, label: 'Consumo real', unidad: '', dec: 2, sufijo: f => f.metrics.tipo_calculo, get: f => f.metrics.consumo_real > 0 ? f.metrics.consumo_real : null, mejorEsMenor: true, unidadDe: f => f.metrics.tipo_calculo },
    { key: 'meta', label: 'Meta', unidad: '', dec: 2, get: f => f.confirmed && f.confirmed.valor > 0 ? f.confirmed.valor : null, mejorEsMenor: null, unidadDe: f => f.metrics.tipo_calculo },
    { key: 'desvio', esTasa: true, label: 'Desvío vs meta', unidad: '%', dec: 1, signo: true, get: f => f.metrics.desvio_pct, mejorEsMenor: true }
];

/**
 * Métricas NORMALIZADAS: el mismo dato dividido por la actividad real del equipo, para que dos
 * equipos con volúmenes de trabajo distintos sean comparables.
 *
 * Regla 1 de calculos-combustible: numerador y denominador del MISMO período. Acá el numerador
 * (litros, km, costo) sale del período analizado y el denominador (días trabajados) también —
 * `coberturaEquipo()` lo calcula sobre ese mismo período, descontando los días marcados fuera de
 * servicio. Nunca se prorratea: si un equipo no tiene días trabajados, la celda queda en "—" en
 * lugar de inventar un ritmo.
 *
 * Consumo, meta y desvío NO se re-normalizan: ya son tasas (L/100km, L/hora). Se muestran igual
 * en los dos modos porque son lo único que siempre fue comparable.
 */
const METRICAS_NORMALIZADAS = [
    { key: 'litros_dia', esTasa: true, label: 'Litros por día trabajado', unidad: 'L', dec: 2, mejorEsMenor: null,
      get: (f, c) => c.dias > 0 ? f.metrics.total_litros / c.dias : null },
    { key: 'litros_carga', esTasa: true, label: 'Litros por carga', unidad: 'L', dec: 1, mejorEsMenor: null,
      get: f => f.metrics.cantidad_cargas > 0 ? f.metrics.total_litros / f.metrics.cantidad_cargas : null },
    { key: 'costo_dia', esTasa: true, label: 'Costo por día trabajado', unidad: '', dec: 0, money: true, mejorEsMenor: true,
      get: (f, c) => c.dias > 0 ? f.metrics.total_costo / c.dias : null },
    { key: 'km_dia', esTasa: true, label: 'Km por día trabajado', unidad: 'km', dec: 1, mejorEsMenor: null,
      get: (f, c) => c.dias > 0 && f.metrics.total_km > 0 ? f.metrics.total_km / c.dias : null },
    { key: 'hs_dia', esTasa: true, label: 'Horas por día trabajado', unidad: 'hs', dec: 2, mejorEsMenor: null,
      get: (f, c) => c.dias > 0 && f.metrics.total_horas > 0 ? f.metrics.total_horas / c.dias : null },
    { key: 'cargas_mes', esTasa: true, label: 'Cargas por mes con datos', unidad: '', dec: 1, mejorEsMenor: null,
      get: (f, c) => c.mesesConDatos > 0 ? f.metrics.cantidad_cargas / c.mesesConDatos : null },
    { key: 'ralenti_pct', esTasa: true, label: '% del tiempo en ralentí', unidad: '%', dec: 0, mejorEsMenor: true,
      get: f => f.metrics.total_horas > 0 ? (f.metrics.horas_ralenti / f.metrics.total_horas * 100) : null },
    { key: 'consumo', esTasa: true, label: 'Consumo real', unidad: '', dec: 2, mejorEsMenor: true,
      sufijo: f => f.metrics.tipo_calculo, unidadDe: f => f.metrics.tipo_calculo,
      get: f => f.metrics.consumo_real > 0 ? f.metrics.consumo_real : null },
    { key: 'meta', label: 'Meta', unidad: '', dec: 2, mejorEsMenor: null, unidadDe: f => f.metrics.tipo_calculo,
      get: f => f.confirmed && f.confirmed.valor > 0 ? f.confirmed.valor : null },
    { key: 'desvio', esTasa: true, label: 'Desvío vs meta', unidad: '%', dec: 1, signo: true, mejorEsMenor: true,
      get: f => f.metrics.desvio_pct }
];

/**
 * Contexto de normalización por equipo: los denominadores, con su origen.
 * Se calcula una vez por render y se pasa a cada métrica, para que no haya dos definiciones de
 * "días trabajados" dando números distintos (invariante 2 del proyecto).
 */
function contextoDe(fila) {
    const cob = periodoRef ? coberturaEquipo(fila, periodoRef, []) : null;
    const cobMes = periodoRef ? coberturaMensual(fila, periodoRef) : null;
    const meses = cobMes?.listaMeses || [];

    // EL DENOMINADOR SON LOS MESES DEL PROPIO EQUIPO, NO LOS DEL PERÍODO.
    // Esto no es un detalle: un equipo con datos en 1 de 8 meses tiene sus litros en ese mes, y
    // dividirlos por los días hábiles de los 8 da un ritmo 8 veces menor que el real — numerador
    // y denominador de períodos distintos, que es exactamente lo que prohíbe la regla 1. Se vio
    // en vivo comparando CM30 (1 de 8 meses) contra TR32 (8 de 8): los dos mostraban "179 días".
    // diasHabilesDeMeses() es la misma función que usa actividadImplicita(), no una segunda
    // definición de días hábiles (invariante 2).
    const dh = meses.length ? diasHabilesDeMeses(meses) : null;
    let dias = dh ? dh.ponderado : 0;
    // Los días marcados fuera de servicio se descuentan proporcionalmente a lo que representan
    // sobre el período completo: no se sabe en cuál de los meses del equipo cayeron.
    const fueraServicio = cob?.diasFueraServicio || 0;
    if (fueraServicio > 0 && cob) {
        const baseCompleta = cob.diasPonderados ?? cob.diasHabiles ?? 0;
        if (baseCompleta > 0) dias = Math.max(0.5, dias * (1 - fueraServicio / baseCompleta));
    }
    // ¿Se puede confiar en una TASA de este equipo? Un total es un hecho aunque haya una sola
    // carga; una tasa es una conclusión, y con 1 carga en 1 mes no hay con qué sostenerla.
    // `confiabilidad()` es la definición que ya usa el resto de la app — no se escribe otra.
    const conf = confiabilidad(fila, periodoRef);
    return {
        dias: dias || 0,
        diasFueraServicio: fueraServicio,
        mesesConDatos: cobMes?.conDatos || 0,
        mesesPeriodo: cobMes?.mesesPeriodo || 0,
        listaMeses: meses,
        confiable: conf.confiable,
        avisos: conf.avisos || []
    };
}

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
    periodoRef = analisis?.totales?.periodo_desde && analisis?.totales?.periodo_hasta
        ? { desde: analisis.totales.periodo_desde, hasta: analisis.totales.periodo_hasta }
        : null;
    modo = 'totales';
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

            <div class="comparar-agregar" style="justify-content:flex-start">
                <button class="btn-secondary btn-sm" id="comparar-modo" title="Los totales dicen cuánto hizo cada equipo; el ritmo dice a qué velocidad lo hizo. Para equipos que trabajaron distinto, el ritmo es lo comparable."></button>
            </div>

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
    document.getElementById('comparar-modo').addEventListener('click', () => {
        modo = modo === 'normalizado' ? 'totales' : 'normalizado';
        pintar();
    });

    pintar();
}

/** Cambiar a modo ritmo desde el aviso de "cargas desiguales". */
function activarNormalizado() { modo = 'normalizado'; pintar(); }

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
    resumenEl.querySelectorAll('.btn-cmp-accion').forEach(b => {
        if (b.dataset.accion === 'normalizar') b.addEventListener('click', activarNormalizado);
    });

    if (filas.length < 2) {
        tabla.innerHTML = `<caption class="comparar-caption">Agregá al menos dos equipos para ver la comparativa.</caption>`;
        return;
    }

    const ctxs = filas.map(contextoDe);
    const lista = modo === 'normalizado' ? METRICAS_NORMALIZADAS : METRICAS;

    // El período de cada equipo se declara SIEMPRE, en los dos modos: comparar dos equipos sobre
    // períodos distintos sin decirlo es exactamente lo que la regla 1 prohíbe. Si uno tiene datos
    // en 2 meses y el otro en 8, tiene que verse antes de leer cualquier otra fila.
    const mesesDistintos = new Set(ctxs.map(c => c.mesesConDatos)).size > 1;
    const filaPeriodo = `<tr class="cmp-fila-periodo">
        <td class="cell-key">Meses con datos${mesesDistintos ? ' <b>(desiguales)</b>' : ''}</td>
        ${ctxs.map(c => `<td class="${mesesDistintos ? 'cmp-worst' : ''}" title="${esc(c.listaMeses.join(', '))}">${c.mesesConDatos} de ${c.mesesPeriodo}</td>`).join('')}
    </tr>`;
    // El denominador de todas las tasas del modo normalizado, visible como fila propia: sin esto
    // "12,4 L/día" sería un número sin pasos, que la regla 2 no deja publicar.
    const filaDias = modo === 'normalizado' ? `<tr class="cmp-fila-periodo">
        <td class="cell-key">Días trabajados <small>(denominador)</small></td>
        ${ctxs.map(c => `<td title="Días hábiles ponderados (lun-vie 1, sábado 0,5) de los meses en que ESTE equipo tiene datos: ${esc(c.listaMeses.join(', ')) || 'ninguno'}${c.diasFueraServicio > 0 ? ` — menos ${nf(c.diasFueraServicio)} días por estado del equipo` : ''}">${nf(c.dias, 1)}<small> en ${c.mesesConDatos} mes${c.mesesConDatos === 1 ? '' : 'es'}</small></td>`).join('')}
    </tr>` : '';

    tabla.innerHTML = `
        <thead>
            <tr>
                <th>Métrica</th>
                ${filas.map(f => `<th>${esc(f.equipo.interno)}<div class="th-sub">${esc(f.equipo.dominio || f.equipo.denominacion || '')}</div></th>`).join('')}
            </tr>
        </thead>
        <tbody>
            ${filaPeriodo}
            ${filaDias}
            ${lista.map(m => filaMetrica(m, filas, ctxs)).join('')}
        </tbody>`;

    const btn = document.getElementById('comparar-modo');
    if (btn) btn.innerHTML = modo === 'normalizado'
        ? '<i class="fa-solid fa-scale-balanced"></i> Viendo ritmo (por día trabajado) — ver totales'
        : '<i class="fa-solid fa-scale-unbalanced"></i> Viendo totales — comparar por ritmo';
}

function filaMetrica(m, filas, ctxs = []) {
    const valores = filas.map((f, i) => m.get(f, ctxs[i] || {}));
    // Consumo real y meta se miden en L/Hora o L/100Km según el equipo: si en la selección hay
    // equipos de ambos tipos, ese número no es comparable entre sí y no se resalta mejor/peor.
    const unidadesMezcladas = m.unidadDe && new Set(filas.map((f, i) => valores[i] !== null ? m.unidadDe(f) : null).filter(Boolean)).size > 1;

    // Una TASA sobre base floja no compite por "mejor/peor". Sin esto, CM30 —1 carga en 1 mes—
    // se pintaba de verde como el más eficiente en costo/día contra TR32 (169 cargas), cuando lo
    // único que pasó es que casi no trabajó. Es el caso de la invariante 3: un número bajo
    // necesita su contexto antes de ser una conclusión. Los TOTALES sí compiten: 71,6 L es un
    // hecho aunque venga de una sola carga; "3,11 L/día" es una conclusión.
    const debil = (i) => m.esTasa && ctxs[i] && ctxs[i].confiable === false;
    const numericos = valores.filter((v, i) => v !== null && v !== undefined && !isNaN(v) && !debil(i));
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
            if (!debil(i) && mejor !== null && peor !== null && mejor !== peor) {
                if (v === mejor) cls = 'cmp-best';
                else if (v === peor) cls = 'cmp-worst';
            }
            // Etiqueta honesta sobre el número flojo: se muestra igual, pero dice de qué base sale.
            const marca = debil(i)
                ? ` <span class="cmp-debil" title="${esc((ctxs[i].avisos || []).join(' · '))}">⚠ base floja</span>`
                : '';
            const num = m.signo && v >= 0 ? `+${nf(v, m.dec)}` : nf(v, m.dec);
            const txt = m.money ? `$${num}` : `${num}${m.unidad ? (m.unidad === '%' ? '%' : ` ${m.unidad}`) : ''}`;
            const suf = m.sufijo ? ` ${esc(m.sufijo(f))}` : '';
            return `<td class="${cls}${debil(i) ? ' cmp-poco-fiable' : ''}">${txt}${suf}${marca}</td>`;
        }).join('')}
    </tr>`;
}

/**
 * Validación de criterios unificados: al comparar equipos, avisar sobre diferencias
 * que hacen la comparación menos confiable (distintas sedes, distinta cantidad de cargas,
 * períodos desiguales, pocas cargas, etc.).
 */
function validarCriterios(filas) {
    const avisos = [];

    if (filas.length < 2) return '';

    // 1. Verificar sedes: si un equipo opera en una sede diferente, la comparación puede ser engañosa
    const sedes = filas.map(f => f.ubicacion?.provincia || 'SIN DATO');
    const sedesUnicas = [...new Set(sedes)];
    if (sedesUnicas.length > 1) {
        const detalle = filas.map(f => `${esc(f.equipo.interno)}: ${esc(f.ubicacion?.provincia || 'sin dato')}`).join(' · ');
        avisos.push({
            tipo: 'sede', icono: 'fa-location-dot', color: 'aviso-alta',
            texto: `Equipos en sedes distintas: ${detalle}. Un equipo de San Juan con datos de Mendoza puede ser un error de sede en los datos.`
        });
    }

    // 2. Cantidad de cargas: diferencias grandes sugieren comparación desigual
    const cargas = filas.map(f => f.metrics.cantidad_cargas);
    const maxCargas = Math.max(...cargas);
    const minCargas = Math.min(...cargas);
    if (maxCargas > 0 && minCargas > 0 && maxCargas / minCargas > 2) {
        avisos.push({
            tipo: 'cargas', icono: 'fa-gas-pump', color: 'aviso-media',
            texto: `Cantidad de cargas desigual (${minCargas} vs ${maxCargas}): comparar los totales de estos dos equipos mide cuánto trabajó cada uno, no cómo consume.`,
            // El aviso deja de ser solo un cartel: la acción que recomienda está acá al lado.
            accion: modo === 'normalizado' ? null : { id: 'normalizar', texto: 'Comparar por ritmo (por día trabajado)' }
        });
    }

    // 3. Pocas cargas: <10 puede deberse a vacaciones, taller, fuera de servicio
    const pocas = filas.filter(f => f.metrics.cantidad_cargas > 0 && f.metrics.cantidad_cargas < 10);
    if (pocas.length) {
        avisos.push({
            tipo: 'pocas', icono: 'fa-triangle-exclamation', color: 'aviso-media',
            texto: `${pocas.map(f => esc(f.equipo.interno)).join(', ')} ${pocas.length === 1 ? 'tiene' : 'tienen'} menos de 10 cargas. Posibles causas: vacaciones del chofer, fuera de servicio, taller externo. Verificar antes de concluir.`
        });
    }

    // 4. Tipo de cálculo diferente: no se puede comparar L/Hora con L/100Km
    const tipos = [...new Set(filas.map(f => f.metrics.tipo_calculo).filter(t => t === 'L/Hora' || t === 'L/100Km'))];
    if (tipos.length > 1) {
        avisos.push({
            tipo: 'unidad', icono: 'fa-scale-unbalanced', color: 'aviso-alta',
            texto: `Se mezclan unidades (${tipos.join(' y ')}): el consumo real no es comparable entre estos equipos.`
        });
    }

    // 5. Lugar de carga diferente: puede indicar datos cruzados
    const lugares = filas.map(f => f.ubicacion?.lugarCarga || '').filter(Boolean);
    const lugaresUnicos = [...new Set(lugares)];
    if (lugaresUnicos.length > 1) {
        avisos.push({
            tipo: 'lugar', icono: 'fa-warehouse', color: 'aviso-baja',
            texto: `Cargan en lugares distintos (${lugaresUnicos.map(esc).join(', ')}). Esto puede afectar el precio por litro.`
        });
    }

    if (!avisos.length) return '';

    return `
        <div class="comparar-avisos">
            <div class="comparar-avisos-head"><i class="fa-solid fa-clipboard-check"></i> Criterios de comparación</div>
            ${avisos.map(a => `
                <div class="comparar-aviso ${a.color}">
                    <i class="fa-solid ${a.icono}"></i>
                    <span>${a.texto}</span>
                    ${a.accion ? `<button class="btn-xs btn-cmp-accion" data-accion="${esc(a.accion.id)}">${esc(a.accion.texto)}</button>` : ''}
                </div>`).join('')}
        </div>`;
}

/** Frases tipo "MX101 hizo 27 cargas más que MX96 (+44%)". Solo con exactamente 2 equipos: con 3+ no hay un "más que" claro sin elegir un par. */
function resumenComparativo(filas) {
    if (filas.length !== 2) return validarCriterios(filas);
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

    const criterios = validarCriterios(filas);
    const resumen = frases.length ? `<ul class="comparar-resumen">${frases.join('')}</ul>` : '';
    return criterios + resumen;
}
