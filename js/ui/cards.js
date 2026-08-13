import { getAllEquipos, getAllRawRecords, getAllEstimados } from '../data/database.js';
import { calculateMetrics, getConfirmedConsumption, calculateAlignedPeriod, getCargasForEquipo, getGPSForEquipo, RULE_NO_TANK } from '../data/analyzer.js';
import { AppState } from '../app.js';
import { openUnitModal } from './modals.js';
import { exportUnitToPDF } from '../export/exporter.js';

/**
 * Calcula el estado visual (OK / atención / alerta) de un equipo comparando su consumo
 * real contra la meta de fábrica (si existe).
 * Fix: antes `renderCards()` usaba `statusClass`/`statusMsg` en el template sin definirlas
 * en ningún lado -> ReferenceError en cada tarjeta -> la vista "Equipos" quedaba rota al
 * 100% (siempre caía en el catch de más abajo mostrando "Error al cargar datos").
 */
function getEquipoStatus(metrics, confirmed) {
    if (metrics.tipo_calculo === 'No Aplica') {
        return { statusClass: 'status-warn', statusMsg: 'No aplica seguimiento de combustible' };
    }
    if (!metrics.consumo_real || metrics.consumo_real <= 0) {
        return { statusClass: 'status-warn', statusMsg: 'Sin datos suficientes para calcular consumo' };
    }
    if (!confirmed || !confirmed.valor || confirmed.valor <= 0) {
        return { statusClass: 'status-warn', statusMsg: 'Sin meta definida para comparar' };
    }
    const ratio = metrics.consumo_real / confirmed.valor;
    if (ratio <= 1.15) {
        return { statusClass: 'status-ok', statusMsg: 'Dentro de la meta esperada' };
    }
    const pctSobre = Math.round((ratio - 1) * 100);
    return { statusClass: 'status-alert', statusMsg: `${pctSobre}% por encima de la meta` };
}

export async function renderCards() {
    const container = document.getElementById('cards-container');
    if (!container) return;
    
    container.innerHTML = '<p>Cargando equipos...</p>';

    try {
        const equipos = await getAllEquipos();
        const estimadosData = await getAllEstimados();
        
        const allRecords = await getAllRawRecords();
        let allCargas = allRecords.filter(r => r.type === 'carga');
        let allGps = allRecords.filter(r => r.type === 'gps');

        // Auto-alineación
        const { start, end } = calculateAlignedPeriod(allCargas, allGps);
        
        let cargas = allCargas;
        let gps = allGps;
        if (start && end) {
            cargas = allCargas.filter(c => c.fecha >= start && c.fecha <= end);
            gps = allGps.filter(g => g.fecha >= start && g.fecha <= end);
        }

        container.innerHTML = '';
        
        equipos.forEach(eq => {
            // Exclude teams without a fuel tank from the fuel dashboard
            const noTankMatch = RULE_NO_TANK.find(pref => eq.interno.startsWith(pref));
            if (noTankMatch) return;

            // Filtrar registros de este equipo.
            // Fix: antes se comparaba `c.interno === eq.interno` (igualdad exacta de texto).
            // Si dos archivos traían el mismo equipo con formato levemente distinto
            // ("TR-21" vs "TR21"), el cruce fallaba en silencio y devolvía 0 registros.
            // getCargasForEquipo/getGPSForEquipo ya existían en analyzer.js y normalizan
            // la clave (normalizeEquipoKey) antes de comparar, pero no se estaban usando acá.
            const eqCargas = getCargasForEquipo(eq.interno, cargas);
            const eqGps = getGPSForEquipo(eq.interno, gps);

            const metrics = calculateMetrics(eq, eqCargas, eqGps);
            const confirmed = getConfirmedConsumption(eq.interno, estimadosData);
            const { statusClass, statusMsg } = getEquipoStatus(metrics, confirmed);

            const card = document.createElement('div');
            card.className = 'equip-card';
            card.onclick = () => openUnitModal(eq, metrics, confirmed, eqCargas, eqGps);
            
            // Calculate aggregations
            const totalLitros = eqCargas.reduce((sum, c) => sum + (parseFloat(c.litros) || 0), 0);
            const totalCosto = eqCargas.reduce((sum, c) => sum + (parseFloat(c.importe) || 0), 0);
            
            // Find most frequent cost center and location
            let ccMap = {};
            let locMap = {};
            eqCargas.forEach(c => {
                if (c.centro_costo) ccMap[c.centro_costo] = (ccMap[c.centro_costo] || 0) + 1;
                if (c.lugar_carga) locMap[c.lugar_carga] = (locMap[c.lugar_carga] || 0) + 1;
            });
            const topCC = Object.keys(ccMap).sort((a,b) => ccMap[b]-ccMap[a])[0] || 'N/A';
            const topLoc = Object.keys(locMap).sort((a,b) => locMap[b]-locMap[a])[0] || 'N/A';

            card.innerHTML = `
                <div class="card-header">
                    <div class="card-title">
                        <h3>${eq.interno} <small style="color:var(--text-muted)">${eq.dominio}</small></h3>
                        <p>${eq.marca} ${eq.modelo} (${eq.tipo})</p>
                    </div>
                    <button class="btn-export-card" title="Exportar Reporte" onclick="event.stopPropagation(); window.exportUnitToPDF('${eq.interno}')">
                        <i class="fa-solid fa-file-pdf"></i>
                    </button>
                </div>
                
                <div class="card-metrics" style="display:flex; flex-direction:column; gap:0.5rem; margin-top:1rem; border-bottom:1px solid var(--border-color); padding-bottom:1rem; margin-bottom:1rem;">
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:var(--text-muted); font-size:0.85rem;">Total Combustible:</span>
                        <span style="font-weight:600;">${totalLitros.toFixed(1)} L</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:var(--text-muted); font-size:0.85rem;">Costo Total:</span>
                        <span style="font-weight:600;">$${totalCosto.toFixed(2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:var(--text-muted); font-size:0.85rem;">Centro Costo Frec.:</span>
                        <span style="font-weight:600; font-size:0.85rem;">${topCC}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:var(--text-muted); font-size:0.85rem;">Lugar Carga Frec.:</span>
                        <span style="font-weight:600; font-size:0.85rem;">${topLoc}</span>
                    </div>
                </div>

                <div class="card-metrics">
                    <div class="metric-box">
                        <label>Combustible</label>
                        <span>${metrics.total_litros.toFixed(1)} L</span>
                    </div>
                    <div class="metric-box">
                        <label>${metrics.tipo_calculo === 'L/100Km' ? 'Distancia' : 'Horas'}</label>
                        <span>${metrics.tipo_calculo === 'L/100Km' ? metrics.total_km.toFixed(0)+' km' : metrics.total_horas.toFixed(1)+' hs'}</span>
                    </div>
                    <div class="metric-box" style="grid-column: span 2;">
                        <label>Consumo Real (${metrics.tipo_calculo})</label>
                        <span style="color:var(--accent-cyan)">${metrics.consumo_real.toFixed(2)}</span>
                    </div>
                </div>
                
                ${confirmed ? `<p style="font-size:0.8rem; color:var(--accent-amber); margin-bottom: 1rem;"><i class="fa-solid fa-check-circle"></i> Meta: ${confirmed.value}</p>` : ''}

                <div class="card-status ${statusClass}">
                    <i class="fa-solid ${statusClass === 'status-ok' ? 'fa-check' : (statusClass === 'status-alert' ? 'fa-triangle-exclamation' : 'fa-circle-info')}"></i>
                    ${statusMsg}
                </div>
            `;
            
            container.appendChild(card);
        });

    } catch (e) {
        console.error("Error al renderizar tarjetas:", e);
        container.innerHTML = '<p style="color:red">Error al cargar datos.</p>';
    }
}
