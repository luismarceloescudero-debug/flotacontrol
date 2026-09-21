/**
 * Vista "Rendimiento": L/m³ por mixer (ítem 10 del roadmap).
 *
 * Responde una pregunta que el L/hora y el L/100km no pueden contestar: si un mixer consume
 * mucho porque rinde mal o porque trabajó mucho. Un mixer que entregó el doble de hormigón va a
 * cargar más combustible y eso no es un problema; dividir por los m³ entregados lo normaliza.
 *
 * Es CONTEXTO, no reemplazo. La unidad de cálculo del equipo sigue siendo la que declara
 * "Consumos Estimados" — esta vista no cambia ninguna meta ni ningún desvío.
 *
 * El denominador sale de `alineacionEntregas` (analyzer.js), que tiene su propio período común:
 * los meses con cargas Y con entregas. NO se reusa `metrics.alineacion`, que es el de
 * cargas∩GPS — un mixer puede tener GPS de ocho meses y entregas de cinco, y mezclar los dos
 * períodos es exactamente lo que la regla 1 prohíbe.
 */
import { Chart, ScatterController, LineController, PointElement, LineElement, LinearScale, Tooltip, Legend } from '../../vendor/chart.mjs';
import { mediana } from '../data/diagnostico.js';
import { MIN_ENTREGAS_L_M3 } from '../data/analyzer.js';

// Chart.js v4 no registra nada por defecto: hay que pedir explícitamente lo que se usa.
Chart.register(ScatterController, LineController, PointElement, LineElement, LinearScale, Tooltip, Legend);

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
// Convención del proyecto: el helper se copia, no se importa (ver CLAUDE.md, "XSS convention").
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let grafico = null;

/** Lee una variable CSS del tema para que el gráfico no invente colores propios. */
function color(nombre, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
    return v || fallback;
}

/**
 * Los mixers con L/m³ calculable, separados por si su base se sostiene.
 *
 * Solo mixers: la regla está en `calculos-combustible`. Un tractor no entrega hormigón, así que
 * su L/m³ no significa nada aunque el número salga.
 */
export function datosLm3(analisis) {
    const filas = [];
    for (const f of (analisis?.filas || [])) {
        const deno = String(f.equipo?.denominacion || '').toUpperCase();
        if (!deno.includes('MIXER')) continue;
        const al = f.alineacionEntregas;
        if (!al || al.consumo_l_m3 == null) continue;
        filas.push({
            interno: f.equipo.interno,
            denominacion: f.equipo.denominacion,
            litros: al.litros,
            m3: al.m3,
            lm3: al.consumo_l_m3,
            entregas: al.cantidad_entregas,
            meses: al.meses,
            baseFloja: al.base_floja
        });
    }
    filas.sort((a, b) => a.lm3 - b.lm3);
    const solidos = filas.filter(f => !f.baseFloja);
    // La mediana se calcula SOLO sobre los de base sólida. Con los flojos adentro, dos mixers
    // que apenas entregaron (MX70 con 4 entregas, MX102 con 5) corren la referencia de todo el
    // grupo: medido, la mueve de 3,621 a 3,792 L/m³.
    const med = solidos.length ? mediana(solidos.map(f => f.lm3)) : null;
    return { filas, solidos, flojos: filas.filter(f => f.baseFloja), mediana: med };
}

export function renderRendimiento(container, analisis) {
    const cont = container || document.getElementById('view-rendimiento');
    if (!cont) return;
    const a = analisis || window.ultimoAnalisis;

    if (!a || !(a.filas || []).length) {
        cont.innerHTML = `<div class="rend-vacio"><i class="fa-solid fa-chart-scatter"></i>
            <p>No hay análisis cargado. Subí las planillas desde "Carga de Datos".</p></div>`;
        return;
    }

    const d = datosLm3(a);

    if (!d.filas.length) {
        cont.innerHTML = `<div class="rend-vacio"><i class="fa-solid fa-chart-scatter"></i>
            <p><strong>No hay mixers con L/m³ calculable en este período.</strong></p>
            <p class="rend-nota">Hace falta que un mixer tenga cargas de combustible y entregas de Loop
            en los <strong>mismos meses</strong>. Si subiste las cargas pero no el "Informe Entregas Loop"
            (o al revés), no hay período común y el cociente no se puede calcular.</p></div>`;
        return;
    }

    const rango = d.solidos.length > 1
        ? `${nf(d.solidos[0].lm3, 2)} a ${nf(d.solidos[d.solidos.length - 1].lm3, 2)}`
        : '—';

    cont.innerHTML = `
        <div class="rend-header">
            <h2><i class="fa-solid fa-truck-droplet"></i> Litros por m³ entregado</h2>
            <p class="rend-intro">Cuánto combustible gasta cada mixer por metro cúbico que entrega.
            Normaliza el consumo por trabajo hecho: un mixer que entregó el doble carga más
            combustible, y eso no es un problema. <strong>Es contexto, no reemplaza</strong> al
            consumo en la unidad declarada del equipo.</p>
        </div>

        <div class="rend-kpis">
            <div class="rend-kpi">
                <span class="rend-kpi-valor">${d.mediana != null ? nf(d.mediana, 2) : '—'}</span>
                <span class="rend-kpi-label">L/m³ mediana</span>
                <span class="rend-kpi-sub">sobre ${d.solidos.length} mixer${d.solidos.length === 1 ? '' : 's'} de base sólida</span>
            </div>
            <div class="rend-kpi">
                <span class="rend-kpi-valor">${d.filas.length}</span>
                <span class="rend-kpi-label">mixers medidos</span>
                <span class="rend-kpi-sub">${d.flojos.length} con base floja</span>
            </div>
            <div class="rend-kpi">
                <span class="rend-kpi-valor">${rango}</span>
                <span class="rend-kpi-label">rango de base sólida</span>
                <span class="rend-kpi-sub">del más eficiente al menos</span>
            </div>
        </div>

        <div class="rend-grafico-caja">
            <canvas id="rend-canvas" height="340"></canvas>
        </div>
        <p class="rend-leyenda">
            Cada punto es un mixer sobre <strong>su propio período común</strong> (los meses que
            tienen cargas y entregas a la vez). La línea es la mediana del grupo: por encima,
            gasta más combustible por m³ que la mitad de la flota. Los puntos en gris tienen menos
            de ${MIN_ENTREGAS_L_M3} entregas y <strong>no compiten</strong>: con ese denominador el
            cociente no mide eficiencia, mide que hay pocos datos.
        </p>

        <div class="table-responsive rend-tabla-caja">
            <table class="data-table rend-tabla">
                <thead><tr>
                    <th>Equipo</th><th>L/m³</th><th>vs mediana</th>
                    <th>Litros</th><th>m³</th><th>Entregas</th><th>Meses en común</th>
                </tr></thead>
                <tbody>
                    ${d.filas.map(f => {
                        const dif = d.mediana ? (f.lm3 / d.mediana - 1) * 100 : null;
                        const cls = f.baseFloja ? 'rend-floja' : (dif > 15 ? 'rend-alto' : dif < -15 ? 'rend-bajo' : '');
                        return `<tr class="${cls}">
                            <td><strong>${esc(f.interno)}</strong></td>
                            <td><strong>${nf(f.lm3, 3)}</strong></td>
                            <td>${f.baseFloja ? '<span class="rend-badge-floja">base floja</span>'
                                : dif == null ? '—'
                                : `${dif > 0 ? '+' : ''}${nf(dif, 0)}%`}</td>
                            <td>${nf(f.litros)} L</td>
                            <td>${nf(f.m3)} m³</td>
                            <td>${nf(f.entregas)}</td>
                            <td><span title="${esc(f.meses.join(', '))}">${f.meses.length}</span></td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>`;

    dibujar(d);
}

function dibujar(d) {
    const canvas = document.getElementById('rend-canvas');
    if (!canvas) return;
    if (grafico) { grafico.destroy(); grafico = null; }

    const verde = color('--accent-green', '#22c55e');
    const rojo = color('--accent-red', '#ef4444');
    const cian = color('--accent-cyan', '#06b6d4');
    const gris = color('--text-muted', '#94a3b8');
    const borde = color('--border-color', 'rgba(148,163,184,0.25)');
    const texto = color('--text-secondary', '#cbd5e1');

    const punto = f => ({ x: f.m3, y: f.litros, interno: f.interno, lm3: f.lm3, entregas: f.entregas, meses: f.meses.length });
    // Por encima o por debajo de la mediana: el color dice de qué lado cayó, no inventa umbral.
    const altos = d.solidos.filter(f => d.mediana != null && f.lm3 > d.mediana).map(punto);
    const bajos = d.solidos.filter(f => d.mediana == null || f.lm3 <= d.mediana).map(punto);
    const flojos = d.flojos.map(punto);

    // La línea de tendencia es la mediana llevada a los ejes: y = mediana * x. Pasa por el
    // origen porque cero m³ entregados es cero combustible atribuible a la entrega.
    const maxM3 = Math.max(...d.filas.map(f => f.m3), 1);
    const linea = d.mediana != null
        ? [{ x: 0, y: 0 }, { x: maxM3 * 1.05, y: d.mediana * maxM3 * 1.05 }]
        : [];

    grafico = new Chart(canvas.getContext('2d'), {
        type: 'scatter',
        data: {
            datasets: [
                { type: 'line', label: `Mediana ${nf(d.mediana, 2)} L/m³`, data: linea,
                  borderColor: cian, borderWidth: 2, borderDash: [6, 4], pointRadius: 0, fill: false },
                { label: 'Bajo la mediana', data: bajos, backgroundColor: verde, pointRadius: 6, pointHoverRadius: 9 },
                { label: 'Sobre la mediana', data: altos, backgroundColor: rojo, pointRadius: 6, pointHoverRadius: 9 },
                { label: `Base floja (< ${MIN_ENTREGAS_L_M3} entregas)`, data: flojos, backgroundColor: gris, pointRadius: 5, pointStyle: 'triangle', pointHoverRadius: 8 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { title: { display: true, text: 'm³ entregados en el período común', color: texto },
                     grid: { color: borde }, ticks: { color: texto } },
                y: { title: { display: true, text: 'Litros cargados en esos mismos meses', color: texto },
                     grid: { color: borde }, ticks: { color: texto } }
            },
            plugins: {
                legend: { labels: { color: texto, usePointStyle: true } },
                tooltip: {
                    callbacks: {
                        // El tooltip muestra los operandos, no solo el resultado: un número sin
                        // sus pasos no se publica (regla 2 de calculos-combustible).
                        label: (ctx) => {
                            const p = ctx.raw;
                            if (p.interno === undefined) return `Mediana del grupo: ${nf(d.mediana, 2)} L/m³`;
                            return [
                                `${p.interno}: ${nf(p.lm3, 3)} L/m³`,
                                `${nf(p.y)} L ÷ ${nf(p.x)} m³`,
                                `${nf(p.entregas)} entregas en ${p.meses} mes${p.meses === 1 ? '' : 'es'}`
                            ];
                        }
                    }
                }
            }
        }
    });
}

// El panel de diagnóstico abre vistas por nombre global (ver panel.js).
window.renderRendimiento = renderRendimiento;
