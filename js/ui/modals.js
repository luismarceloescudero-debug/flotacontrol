export function openUnitModal(equipo, metrics, confirmed, eqCargas, eqGps) {
    let container = document.getElementById('modals-container');
    if (!container) return;

    // Expected value parsing for inverse math
    let expectedValue = 0;
    if (confirmed) {
        // e.g. "34.5 L/100Km" -> 34.5
        const match = confirmed.value.match(/([\d\.]+)/);
        if (match) expectedValue = parseFloat(match[1]);
    }

    const modalHTML = `
        <div class="modal-overlay active" id="unit-modal-${equipo.interno}">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Detalle: ${equipo.interno} - ${equipo.dominio}</h2>
                    <button class="btn-close" onclick="this.closest('.modal-overlay').remove()"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    <h3>Pasos del Cálculo (Editable)</h3>
                    <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:1rem;">
                        Podés editar los litros o distancia para ver proyecciones y recalcular.
                    </p>
                    
                    <div class="calc-steps">
                        <div class="calc-step">
                            <label>1. Total Litros Cargados:</label>
                            <input type="number" id="calc-litros" value="${metrics.total_litros.toFixed(1)}">
                        </div>
                        <div class="calc-step">
                            <label>2. ${metrics.tipo_calculo === 'L/100Km' ? 'Distancia Recorrida (km)' : 'Horas de Uso (hs)'}:</label>
                            <input type="number" id="calc-factor" value="${metrics.tipo_calculo === 'L/100Km' ? metrics.total_km : metrics.total_horas}">
                        </div>
                        <div class="calc-step" style="background: rgba(59,130,246,0.1); border:none; padding:1rem; margin-top:1rem;">
                            <label style="color:var(--accent-cyan); font-weight:bold;">= Consumo Resultante (${metrics.tipo_calculo}):</label>
                            <span id="calc-result" style="font-size:1.5rem; font-weight:bold;">${metrics.consumo_real.toFixed(2)}</span>
                        </div>
                    </div>

                    ${expectedValue > 0 ? `
                    <div style="margin-top:2rem;">
                        <h3 style="color:var(--accent-amber)">Cálculo Inverso (Falta de GPS)</h3>
                        <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:1rem;">
                            Meta según fábrica: <strong>${confirmed.value}</strong>. 
                            Si el vehículo consumió ${metrics.total_litros.toFixed(1)}L, debería haber recorrido/trabajado:
                        </p>
                        <div class="calc-step" style="background: rgba(245,158,11,0.1); border:none; padding:1rem;">
                            <label style="color:var(--accent-amber); font-weight:bold;">Proyección Inversa:</label>
                            <span style="font-size:1.5rem; font-weight:bold;">
                                ${metrics.tipo_calculo === 'L/100Km' ? 
                                    ((metrics.total_litros / expectedValue) * 100).toFixed(0) + ' km' : 
                                    (metrics.total_litros / expectedValue).toFixed(1) + ' hs'}
                            </span>
                        </div>
                    </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', modalHTML);

    // Add interactivity to the calc step inputs
    const modal = document.getElementById(`unit-modal-${equipo.interno}`);
    const inputLitros = modal.querySelector('#calc-litros');
    const inputFactor = modal.querySelector('#calc-factor');
    const spanResult = modal.querySelector('#calc-result');

    const updateCalc = () => {
        let l = parseFloat(inputLitros.value) || 0;
        let f = parseFloat(inputFactor.value) || 0;
        let res = 0;
        
        if (f > 0) {
            if (metrics.tipo_calculo === 'L/100Km') {
                res = (l / f) * 100;
            } else {
                res = l / f;
            }
        }
        spanResult.innerText = res.toFixed(2);
    };

    inputLitros.addEventListener('input', updateCalc);
    inputFactor.addEventListener('input', updateCalc);
}
