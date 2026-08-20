/**
 * Ajuste masivo de metas de consumo.
 *
 * Permite seleccionar un grupo de equipos (por denominación o por estado de la meta) y
 * fijarles la meta de una sola vez, eligiendo de dónde sale el valor:
 *   - el CONSUMO REAL medido de cada equipo (cada uno con el suyo),
 *   - la MEDIANA de su denominación (todo el grupo con el mismo objetivo),
 *   - un valor manual.
 *
 * La idea es que, mientras no exista el dato oficial de fábrica, la meta se ajuste a lo que
 * la flota realmente consume — y recién ahí se investigue a fondo lo que sigue haciendo ruido.
 */
import { getAllEquipos, updateEquipo } from '../data/database.js';
import { sugerirMeta, metaDesdeConsumoReal, confiabilidad } from '../data/diagnostico.js';

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let filasRef = [];
let periodoRef = null;
let seleccion = new Set();
let overlay = null;

export function abrirAjusteMetas(analisis, filtroInicial = 'todos') {
    filasRef = (analisis?.filas || []).filter(f => ['L/Hora', 'L/100Km'].includes(f.metrics.tipo_calculo));
    periodoRef = analisis?.totales ? { desde: analisis.totales.periodo_desde, hasta: analisis.totales.periodo_hasta } : null;
    seleccion = new Set();
    cerrar();

    overlay = document.createElement('div');
    overlay.className = 'calc-overlay metas-overlay';
    overlay.innerHTML = `
        <div class="metas-panel">
            <div class="metas-head">
                <div>
                    <span class="calc-panel-label">Ajuste masivo</span>
                    <h3>Metas de consumo</h3>
                    <p class="metas-sub">Elegí los equipos y de dónde sale la meta. Lo que apliques queda marcado como corrección manual y no se pisa al reimportar la planilla.</p>
                </div>
                <button class="btn-icon" data-cerrar><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="metas-filtros">
                <select id="metas-filtro">
                    <option value="todos">Todos los equipos medibles</option>
                    <option value="sin_meta">Sin meta cargada</option>
                    <option value="metas_raras">Metas sospechosas (muy lejos del real)</option>
                    <option value="sobre">Sobre la meta (+15%)</option>
                </select>
                <select id="metas-deno"><option value="ALL">Todas las denominaciones</option></select>
                <label class="checkbox-line"><input type="checkbox" id="metas-solo-confiables" checked> Solo con datos confiables</label>
                <span id="metas-count" class="cards-count"></span>
            </div>

            <div class="metas-acciones">
                <button class="btn-secondary btn-sm" data-sel="todos">Seleccionar todos</button>
                <button class="btn-secondary btn-sm" data-sel="ninguno">Ninguno</button>
                <button class="btn-primary btn-sm" id="metas-normalizar-real" title="Seleccionar todos + aplicar el consumo real de cada uno como meta"><i class="fa-solid fa-wand-magic-sparkles"></i> Normalizar todos con el real</button>
                <div class="metas-aplicar">
                    <select id="metas-origen">
                        <option value="real">Usar el consumo real de cada equipo</option>
                        <option value="mediana">Usar la mediana de su grupo comparable</option>
                        <option value="manual">Usar un valor fijo…</option>
                    </select>
                    <input type="number" id="metas-manual" step="0.01" min="0" placeholder="valor" style="display:none">
                    <button class="btn-primary btn-sm" id="metas-aplicar"><i class="fa-solid fa-check"></i> Aplicar a los seleccionados</button>
                </div>
            </div>

            <div class="table-responsive metas-tabla">
                <table class="data-table">
                    <thead><tr>
                        <th style="width:34px"></th><th>Interno</th><th>Dominio</th><th>Denominación</th>
                        <th>Consumo real</th><th>Meta actual</th><th>Nueva meta</th><th>Base</th>
                    </tr></thead>
                    <tbody id="metas-body"></tbody>
                </table>
            </div>
        </div>`;

    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-cerrar]')) cerrar(); });
    document.body.appendChild(overlay);

    const denos = [...new Set(filasRef.map(f => f.equipo.denominacion).filter(Boolean))].sort();
    document.getElementById('metas-deno').innerHTML = '<option value="ALL">Todas las denominaciones</option>' +
        denos.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');

    document.getElementById('metas-filtro').value = filtroInicial;
    ['metas-filtro', 'metas-deno', 'metas-solo-confiables'].forEach(id =>
        document.getElementById(id).addEventListener('change', pintar));
    document.getElementById('metas-origen').addEventListener('change', (e) => {
        document.getElementById('metas-manual').style.display = e.target.value === 'manual' ? '' : 'none';
        pintar();
    });
    overlay.querySelectorAll('[data-sel]').forEach(b => b.addEventListener('click', () => {
        const visibles = filtrar().map(f => f.equipo.interno);
        if (b.dataset.sel === 'todos') visibles.forEach(i => seleccion.add(i));
        else visibles.forEach(i => seleccion.delete(i));
        pintar();
    }));
    document.getElementById('metas-aplicar').addEventListener('click', aplicar);
    document.getElementById('metas-normalizar-real')?.addEventListener('click', () => {
        document.getElementById('metas-origen').value = 'real';
        document.getElementById('metas-manual').style.display = 'none';
        const visibles = filtrar().map(f => f.equipo.interno);
        visibles.forEach(i => seleccion.add(i));
        pintar();
        aplicar();
    });

    pintar();
}

function cerrar() { if (overlay) { overlay.remove(); overlay = null; } }

function filtrar() {
    const filtro = document.getElementById('metas-filtro')?.value || 'todos';
    const deno = document.getElementById('metas-deno')?.value || 'ALL';
    const soloConf = document.getElementById('metas-solo-confiables')?.checked;

    return filasRef.filter(f => {
        // Un equipo sin cargas en el período no aporta información para fijar una meta.
        if (f.metrics.cantidad_cargas === 0) return false;
        if (deno !== 'ALL' && f.equipo.denominacion !== deno) return false;
        if (soloConf && !confiabilidad(f, periodoRef).confiable) return false;

        if (filtro === 'sin_meta') return !f.confirmed || !f.confirmed.valor;
        if (filtro === 'sobre' || filtro === 'excedidos') return f.metrics.desvio_pct !== null && f.metrics.desvio_pct > 15;
        if (filtro === 'metas_raras') {
            if (!f.confirmed || !f.confirmed.valor || !f.metrics.consumo_real) return false;
            const r = f.metrics.consumo_real / f.confirmed.valor;
            return r >= 2.5 || r <= 0.4;
        }
        return true;
    }).sort((a, b) => b.metrics.total_litros - a.metrics.total_litros);
}

/** Nueva meta propuesta para una fila, según el origen elegido. */
function nuevaMeta(f) {
    const origen = document.getElementById('metas-origen')?.value || 'real';
    if (origen === 'manual') {
        const v = parseFloat(document.getElementById('metas-manual')?.value);
        return isNaN(v) || v <= 0 ? null : { valor: v, base: 'valor fijo ingresado a mano' };
    }
    if (origen === 'mediana') {
        const s = sugerirMeta(f, filasRef);
        return s ? { valor: s.valor, base: s.base } : null;
    }
    const s = metaDesdeConsumoReal(f);
    return s ? { valor: s.valor, base: s.base } : null;
}

function pintar() {
    const filas = filtrar();
    const body = document.getElementById('metas-body');
    document.getElementById('metas-count').textContent = `${filas.length} equipos · ${seleccion.size} seleccionados`;

    body.innerHTML = filas.map(f => {
        const nm = nuevaMeta(f);
        const marcado = seleccion.has(f.equipo.interno);
        const conf = confiabilidad(f, periodoRef);
        return `<tr class="${marcado ? 'fila-sel' : ''}">
            <td><input type="checkbox" data-interno="${esc(f.equipo.interno)}" ${marcado ? 'checked' : ''}></td>
            <td class="cell-key">${esc(f.equipo.interno)}</td>
            <td class="cell-dom">${esc(f.equipo.dominio || '—')}</td>
            <td>${esc(f.equipo.denominacion)}</td>
            <td><strong>${nf(f.metrics.consumo_real, 2)}</strong> <small>${esc(f.metrics.tipo_calculo)}</small>
                <div class="cell-muted">${f.metrics.cantidad_cargas} cargas${conf.confiable ? '' : ' · ⚠ ' + esc(conf.avisos.join(', '))}</div></td>
            <td>${f.confirmed && f.confirmed.valor ? nf(f.confirmed.valor, 2) : '<span class="cell-muted">sin meta</span>'}</td>
            <td class="${nm ? 'cell-nueva' : 'cell-muted'}">${nm ? nf(nm.valor, 2) : '—'}</td>
            <td class="cell-muted">${nm ? esc(nm.base) : 'no hay base suficiente'}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="8">Ningún equipo coincide con el filtro.</td></tr>';

    body.querySelectorAll('input[type=checkbox]').forEach(ch => {
        ch.addEventListener('change', () => {
            if (ch.checked) seleccion.add(ch.dataset.interno); else seleccion.delete(ch.dataset.interno);
            document.getElementById('metas-count').textContent = `${filas.length} equipos · ${seleccion.size} seleccionados`;
            ch.closest('tr').classList.toggle('fila-sel', ch.checked);
        });
    });
}

async function aplicar() {
    const filas = filtrar().filter(f => seleccion.has(f.equipo.interno));
    if (!filas.length) { alert('No hay equipos seleccionados.'); return; }

    const conValor = filas.map(f => ({ f, nm: nuevaMeta(f) })).filter(x => x.nm);
    if (!conValor.length) { alert('Ninguno de los seleccionados tiene una base para calcular la meta.'); return; }

    if (!confirm(`¿Aplicar la nueva meta a ${conValor.length} equipos?\n\nQuedan marcadas como corrección manual: una reimportación de "Consumos Estimados" no las va a pisar.`)) return;

    const btn = document.getElementById('metas-aplicar');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Aplicando...';

    try {
        const maestros = await getAllEquipos();
        for (const { f, nm } of conValor) {
            const eq = maestros.find(e => e.interno === f.equipo.interno);
            if (!eq) continue;
            const unidad = f.metrics.tipo_calculo;
            eq.meta_valor = nm.valor;
            eq.meta_unidad = unidad;
            eq.meta_texto = `${nm.valor} ${unidad === 'L/Hora' ? 'L/hora' : 'L/100km'}`;
            eq.meta_origen = nm.base;
            eq.editado_manual = [...new Set([...(eq.editado_manual || []), 'meta_valor', 'meta_unidad', 'meta_texto'])];
            await updateEquipo(eq);
        }
        cerrar();
        if (typeof window.renderPanel === 'function') await window.renderPanel();
        alert(`Listo: ${conValor.length} metas actualizadas.`);
    } catch (e) {
        console.error('Error aplicando metas:', e);
        alert('No se pudieron aplicar todas las metas: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> Aplicar a los seleccionados'; }
    }
}
