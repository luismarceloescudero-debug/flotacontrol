import { getAllEquipos, getAllRawRecords } from '../data/database.js';
import { calculateAlignedPeriod, sumHoras } from '../data/analyzer.js';

export async function renderDashboard() {
    const container = document.getElementById('dashboard-metrics');
    if (!container) return;

    container.innerHTML = '<p>Calculando métricas globales...</p>';

    try {
        const equipos = await getAllEquipos();
        const allRecords = await getAllRawRecords();
        
        let allCargas = allRecords.filter(r => r.type === 'carga');
        let allGps = allRecords.filter(r => r.type === 'gps');

        // Calcular auto-alineación
        const { start, end } = calculateAlignedPeriod(allCargas, allGps);
        
        // Update UI con el periodo
        const dateDisplay = document.getElementById('auto-date-range');
        if (dateDisplay) {
            if (start && end) {
                dateDisplay.innerText = `${start} a ${end}`;
            } else {
                dateDisplay.innerText = "Datos Insuficientes";
            }
        }

        // Filtrar a ese periodo común
        let cargas = allCargas;
        let gps = allGps;
        if (start && end) {
            cargas = allCargas.filter(c => c.fecha >= start && c.fecha <= end);
            gps = allGps.filter(g => g.fecha >= start && g.fecha <= end);
        }

        let totalLitros = 0;
        let totalCosto = 0;
        let totalKm = 0;

        cargas.forEach(c => {
            totalLitros += parseFloat(c.litros) || 0;
            totalCosto += parseFloat(c.importe) || 0;
        });

        gps.forEach(g => {
            totalKm += parseFloat(g.distancia) || 0;
        });
        // Fix: antes hacía `parseFloat(g.horas)`, que devuelve NaN cuando `horas` ya viene
        // como objeto {ralenti, movimiento, parado, total} (formato actual del parser GPS).
        // sumHoras() soporta ambos formatos y es la misma función que usan las tarjetas.
        const totalHoras = sumHoras(gps);

        container.innerHTML = `
            <div class="metric-card" onclick="window.showDataTable('carga')">
                <h3>Total Litros <i class="fa-solid fa-arrow-pointer" style="font-size:0.8rem; margin-left:0.5rem; opacity:0.5;"></i></h3>
                <div class="value">${totalLitros.toLocaleString('es-AR', {maximumFractionDigits: 1})} L</div>
                <div class="subtitle">En ${cargas.length} cargas registradas. Click para ver.</div>
            </div>
            <div class="metric-card" onclick="window.showDataTable('carga')">
                <h3>Costo Total <i class="fa-solid fa-arrow-pointer" style="font-size:0.8rem; margin-left:0.5rem; opacity:0.5;"></i></h3>
                <div class="value">$ ${totalCosto.toLocaleString('es-AR', {maximumFractionDigits: 2})}</div>
                <div class="subtitle">Click para ver cargas.</div>
            </div>
            <div class="metric-card" onclick="window.showDataTable('gps')">
                <h3>Actividad Global <i class="fa-solid fa-arrow-pointer" style="font-size:0.8rem; margin-left:0.5rem; opacity:0.5;"></i></h3>
                <div class="value">${totalKm.toLocaleString('es-AR', {maximumFractionDigits: 0})} km</div>
                <div class="subtitle">y ${totalHoras.toLocaleString('es-AR', {maximumFractionDigits: 1})} horas. Click para ver.</div>
            </div>
            <div class="metric-card">
                <h3>Equipos Activos</h3>
                <div class="value">${equipos.length}</div>
                <div class="subtitle">En base de datos maestra</div>
            </div>
        `;
    } catch (e) {
        console.error("Error renderizando dashboard:", e);
        container.innerHTML = '<p style="color:red">Error cargando dashboard.</p>';
    }
}
