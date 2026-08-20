/**
 * Modal de detalle de un equipo: muestra de dónde sale cada número del cálculo,
 * el historial de cargas y la actividad GPS del período.
 */
import { evolucionMensual, confiabilidad } from '../data/diagnostico.js';

const MESES_CORTOS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function openUnitModal(equipo, metrics, confirmed, eqCargas = [], eqGps = [], ubicacion = null, periodo = null) {
    const container = document.getElementById('modals-container');
    if (!container) return;

    const esHora = metrics.tipo_calculo === 'L/Hora';
    const factor = esHora ? metrics.total_horas : metrics.total_km;
    const unidadFactor = esHora ? 'horas' : 'km';
    // Fix: antes se sacaba el número de la meta con un regex sobre el texto en cada uso.
    // Ahora el valor numérico ya viene parseado y validado desde el parser.
    const meta = confirmed && confirmed.valor > 0 ? confirmed.valor : 0;

    const ultimasCargas = eqCargas.slice().sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')).slice(0, 12);

    const modalId = `unit-modal-${equipo.interno.replace(/[^A-Za-z0-9]/g, '')}`;

    container.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay active" id="${modalId}">
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <div>
                        <h2>${esc(equipo.interno)} ${equipo.dominio ? `<span class="card-dominio">${esc(equipo.dominio)}</span>` : '<span class="card-dominio"><em>sin dominio</em></span>'}</h2>
                        <p class="modal-sub">${esc(equipo.denominacion || '')} · ${esc([equipo.marca, equipo.modelo].filter(Boolean).join(' '))}</p>
                        ${(equipo.anio || equipo.potencia || equipo.capacidad) ? `<p class="modal-sub modal-sub-specs">${esc([equipo.anio, equipo.potencia, equipo.capacidad].filter(Boolean).join(' · '))}</p>` : ''}
                        ${ubicacion && (ubicacion.combustible || ubicacion.centroCosto) ? `<p class="modal-sub modal-sub-specs">
                            ${ubicacion.combustible ? `<i class="fa-solid fa-droplet"></i> ${esc(ubicacion.combustible)}` : ''}
                            ${ubicacion.centroCosto ? ` · <i class="fa-solid fa-building"></i> ${esc(ubicacion.centroCosto)}${ubicacion.centroCostoBreakdown && ubicacion.centroCostoBreakdown.length > 1 ? ` <span title="${esc(ubicacion.centroCostoBreakdown.map(c => `${c.valor} (${c.n})`).join(', '))}">(+${ubicacion.centroCostoBreakdown.length - 1} más)</span>` : ''}` : ''}
                        </p>` : ''}
                    </div>
                    <button class="btn-close" data-close><i class="fa-solid fa-xmark"></i></button>
                </div>

                <div class="modal-body">
                    ${(() => {
                        const c = confiabilidad({ metrics, cargas: eqCargas }, periodo);
                        const avisoBanner = c.confiable ? '' : `<div class="insight-bar insight-warn">
                            <i class="fa-solid fa-circle-exclamation"></i>
                            <div>Este consumo se apoya en pocos datos (${esc(c.avisos.join(', '))}). Tomalo como indicativo hasta tener más período cargado.</div>
                        </div>`;
                        // Cobertura de cargas contra los días hábiles del período, aunque no
                        // dispare el aviso: responde directamente a "¿son suficientes cargas
                        // para el período que estoy mirando?" con el número, no solo un semáforo.
                        const coberturaLinea = c.cobertura ? `<p class="modal-note modal-cobertura">
                            <i class="fa-solid fa-calendar-check"></i>
                            Cargó combustible en <strong>${c.cobertura.diasConCarga} de ${c.cobertura.diasHabiles}</strong> días hábiles del período analizado (${c.cobertura.pct}%).
                        </p>` : '';
                        return avisoBanner + coberturaLinea;
                    })()}
                    ${metrics.motivo_sin_calculo ? `
                        <div class="insight-bar insight-warn">
                            <i class="fa-solid fa-triangle-exclamation"></i> ${esc(metrics.motivo_sin_calculo)}
                        </div>` : ''}

                    <h3>Pasos del cálculo</h3>
                    ${(metrics.pasos && metrics.pasos.length) ? `
                    <ol class="calc-pasos" style="margin-bottom:1.25rem">
                        ${metrics.pasos.map((p, i) => `
                            <li>
                                <span class="calc-paso-n">${i + 1}</span>
                                <div class="calc-paso-cuerpo">
                                    <span class="calc-paso-texto">${esc(p.texto)}</span>
                                    ${p.calculo ? `<code class="calc-paso-formula">${esc(p.calculo)}</code>` : ''}
                                    ${p.nota ? `<span class="calc-paso-nota">${esc(p.nota)}</span>` : ''}
                                </div>
                                <span class="calc-paso-res">${esc(p.resultado)}</span>
                            </li>`).join('')}
                    </ol>` : ''}
                    ${metrics.fuentes && metrics.fuentes.length ? `
                    <div class="calc-fuentes"><span>Datos tomados de:</span>${metrics.fuentes.map(f => `<code>${esc(f)}</code>`).join('')}</div>` : ''}

                    <h3>Simular otro escenario</h3>
                    <div class="calc-flow">
                        <div class="calc-box">
                            <span class="calc-label">Combustible cargado</span>
                            <input type="number" step="0.1" id="calc-litros" value="${metrics.total_litros.toFixed(1)}">
                            <span class="calc-unit">litros · ${metrics.cantidad_cargas} cargas</span>
                        </div>
                        <div class="calc-op">÷</div>
                        <div class="calc-box">
                            <span class="calc-label">${esHora ? 'Horas de uso (GPS)' : 'Distancia (GPS)'}</span>
                            <input type="number" step="0.1" id="calc-factor" value="${factor.toFixed(1)}">
                            <span class="calc-unit">${unidadFactor} · ${metrics.cantidad_gps} registros</span>
                        </div>
                        <div class="calc-op">=</div>
                        <div class="calc-box calc-result">
                            <span class="calc-label">Consumo (${esc(metrics.tipo_calculo)})</span>
                            <span id="calc-result">${nf(metrics.consumo_real, 2)}</span>
                            <span class="calc-unit">${meta ? `meta: ${nf(meta, 2)}` : 'sin meta cargada'}</span>
                        </div>
                    </div>

                    ${esHora && metrics.horas_ralenti > 0 ? `
                    <div class="insight-bar">
                        <i class="fa-solid fa-hourglass-half"></i>
                        De las ${nf(metrics.total_horas, 1)} horas, <strong>${nf(metrics.horas_ralenti, 1)} fueron en ralentí</strong>
                        (${nf(metrics.horas_ralenti / metrics.total_horas * 100, 0)}%) y ${nf(metrics.horas_movimiento, 1)} en movimiento.
                    </div>` : ''}

                    ${meta > 0 && metrics.total_litros > 0 ? `
                    <h3>Proyección inversa</h3>
                    <p class="modal-note">
                        Si el equipo cumpliera exactamente su meta de <strong>${esc(confirmed.value)}</strong>,
                        con ${nf(metrics.total_litros, 1)} L cargados debería haber registrado:
                        <strong>${esHora ? nf(metrics.total_litros / meta, 1) + ' horas' : nf((metrics.total_litros / meta) * 100, 0) + ' km'}</strong>.
                        ${factor > 0 ? `Registró ${nf(factor, esHora ? 1 : 0)} ${unidadFactor}.` : 'No hay registro de GPS para comparar.'}
                    </p>` : ''}

                    <h3>Evolución mes a mes</h3>
                    ${(() => {
                        // Responde a "¿fue puntual de un mes o se sostiene?": un desvío que
                        // aparece un solo mes suele ser una obra particular; uno que se repite
                        // es un problema del equipo.
                        const ev = evolucionMensual({ cargas: eqCargas, gps: eqGps, metrics });
                        if (!ev.length) return '<p class="modal-note">No hay suficientes períodos para comparar.</p>';
                        const maxC = Math.max(...ev.map(m => m.consumo), meta || 0, 0.001);
                        return `
                        <div class="evol">
                            ${ev.map(m => {
                                const alto = m.consumo > 0 ? Math.max((m.consumo / maxC) * 100, 3) : 0;
                                const sobre = meta > 0 && m.consumo > meta * 1.15;
                                return `<div class="evol-col">
                                    <span class="evol-val">${m.consumo > 0 ? nf(m.consumo, 2) : '—'}</span>
                                    <div class="evol-barra"><i style="height:${alto}%; background:${sobre ? 'var(--accent-red)' : 'var(--accent-cyan)'}"></i></div>
                                    <span class="evol-mes">${MESES_CORTOS[parseInt(m.periodo.split('-')[1], 10) - 1] || m.periodo}</span>
                                    <span class="evol-sub">${nf(m.litros)} L · ${m.cargas} cargas</span>
                                </div>`;
                            }).join('')}
                            ${meta > 0 ? `<div class="evol-meta" style="bottom:calc(${(meta / maxC) * 100}% * 0.62 + 2.9rem)"><span>meta ${nf(meta, 2)}</span></div>` : ''}
                        </div>`;
                    })()}

                    <h3>Últimas cargas de combustible</h3>
                    ${ultimasCargas.length ? `
                    <div class="table-responsive modal-table">
                        <table class="data-table">
                            <thead><tr><th>Fecha</th><th>Litros</th><th>Importe</th><th>Lugar</th><th>Centro de costo</th><th>Chofer</th></tr></thead>
                            <tbody>
                                ${ultimasCargas.map(c => `
                                    <tr>
                                        <td>${esc(c.fecha)}</td>
                                        <td>${nf(c.litros, 1)}</td>
                                        <td>$${nf(c.importe, 0)}</td>
                                        <td>${esc(c.lugar_carga)}</td>
                                        <td>${esc(c.centro_costo)}</td>
                                        <td>${esc(c.chofer)}</td>
                                    </tr>`).join('')}
                            </tbody>
                        </table>
                    </div>` : '<p class="modal-note">No hay cargas registradas en el período.</p>'}

                    <h3>Actividad GPS del período</h3>
                    ${eqGps.length ? `
                    <div class="table-responsive modal-table">
                        <table class="data-table">
                            <thead><tr><th>Desde</th><th>Hasta</th><th>Km</th><th>Hs ralentí</th><th>Hs movimiento</th><th>Hs total</th></tr></thead>
                            <tbody>
                                ${eqGps.map(g => {
                                    const h = (g.horas && typeof g.horas === 'object') ? g.horas : { ralenti: 0, movimiento: parseFloat(g.horas) || 0, total: parseFloat(g.horas) || 0 };
                                    return `<tr>
                                        <td>${esc(g.fecha)}</td>
                                        <td>${esc(g.fecha_hasta || '')}</td>
                                        <td>${nf(g.distancia, 0)}</td>
                                        <td>${nf(h.ralenti, 1)}</td>
                                        <td>${nf(h.movimiento, 1)}</td>
                                        <td><strong>${nf(h.total, 1)}</strong></td>
                                    </tr>`;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>` : '<p class="modal-note">Este equipo no tiene registros en el Resumen de Flota (GPS) del período.</p>'}
                </div>
            </div>
        </div>`);

    const modal = document.getElementById(modalId);
    modal.querySelector('[data-close]').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    // Recalculo en vivo al editar litros o el factor (para simular escenarios)
    const inputLitros = modal.querySelector('#calc-litros');
    const inputFactor = modal.querySelector('#calc-factor');
    const spanResult = modal.querySelector('#calc-result');

    const update = () => {
        const l = parseFloat(inputLitros.value) || 0;
        const f = parseFloat(inputFactor.value) || 0;
        let res = 0;
        if (f > 0) res = esHora ? (l / f) : ((l / f) * 100);
        spanResult.innerText = nf(res, 2);
        spanResult.style.color = (meta > 0 && res > meta * 1.15) ? 'var(--accent-red)' : 'var(--accent-cyan)';
    };
    inputLitros.addEventListener('input', update);
    inputFactor.addEventListener('input', update);
}
