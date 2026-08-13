import { getAllEquipos, getAllRawRecords, getAllEstimados, updateEquipo, updateEstimado } from '../data/database.js';
import { calculateAlignedPeriod } from '../data/analyzer.js';

let currentTableData = [];
let currentType = '';

export async function renderDataTable(type) {
    const container = document.getElementById('dashboard-table-container');
    const headerRow = document.getElementById('table-header');
    const tbody = document.getElementById('table-body');
    const title = document.getElementById('table-title');
    
    if (!container || !headerRow || !tbody) return;

    container.style.display = 'block';
    tbody.innerHTML = '<tr><td colspan="6">Cargando registros...</td></tr>';
    headerRow.innerHTML = '';
    currentType = type;

    try {
        let records = [];

        if (type === 'carga' || type === 'gps') {
            const allRecords = await getAllRawRecords();
            let allCargas = allRecords.filter(r => r.type === 'carga');
            let allGps = allRecords.filter(r => r.type === 'gps');
            const { start, end } = calculateAlignedPeriod(allCargas, allGps);
            
            if (type === 'carga') {
                title.innerText = 'Registros de Operación: Cargas de Combustible';
                records = start && end ? allCargas.filter(c => c.fecha >= start && c.fecha <= end) : allCargas;
                
                headerRow.innerHTML = `<th>Fecha</th><th>Interno</th><th>Litros</th><th>Importe ($)</th><th>Lugar/CC</th>`;
                tbody.innerHTML = records.map(r => `
                    <tr>
                        <td>${r.fecha}</td>
                        <td style="color:var(--accent-cyan); font-weight:bold;">${r.interno}</td>
                        <td>${r.litros.toFixed(2)}</td>
                        <td>$${r.importe.toFixed(2)}</td>
                        <td>${r.lugar_carga} / ${r.centro_costo}</td>
                    </tr>
                `).join('') || '<tr><td colspan="5">No hay datos de cargas.</td></tr>';
            } 
            else if (type === 'gps') {
                title.innerText = 'Registros de Operación: Actividad GPS';
                records = start && end ? allGps.filter(g => g.fecha >= start && g.fecha <= end) : allGps;
                
                headerRow.innerHTML = `<th>Fecha</th><th>Interno</th><th>Km Recorridos</th><th>Horas Trabajo</th>`;
                tbody.innerHTML = records.map(r => `
                    <tr>
                        <td>${r.fecha}</td>
                        <td style="color:var(--accent-cyan); font-weight:bold;">${r.interno}</td>
                        <td>${r.distancia.toFixed(0)}</td>
                        <td>${r.horas.toFixed(1)}</td>
                    </tr>
                `).join('') || '<tr><td colspan="4">No hay datos de GPS.</td></tr>';
            }
        } 
        else if (type === 'equipos') {
            title.innerText = 'Maestro: Base de Datos de Equipos (Editable)';
            records = await getAllEquipos();
            
            // Allow editing of DOMINIO, MARCA, MODELO, TIPO
            headerRow.innerHTML = `<th>Interno (Key)</th><th>Dominio</th><th>Marca</th><th>Modelo</th><th>Tipo</th><th>Acción</th>`;
            tbody.innerHTML = records.map((r, index) => `
                <tr id="eq-row-${index}">
                    <td style="color:var(--accent-cyan); font-weight:bold;">${r.interno}</td>
                    <td contenteditable="true" onblur="window.saveDBRow('equipos', ${index}, 'dominio', this.innerText)" style="background:rgba(255,255,255,0.05);">${r.dominio || ''}</td>
                    <td contenteditable="true" onblur="window.saveDBRow('equipos', ${index}, 'marca', this.innerText)" style="background:rgba(255,255,255,0.05);">${r.marca || ''}</td>
                    <td contenteditable="true" onblur="window.saveDBRow('equipos', ${index}, 'modelo', this.innerText)" style="background:rgba(255,255,255,0.05);">${r.modelo || ''}</td>
                    <td contenteditable="true" onblur="window.saveDBRow('equipos', ${index}, 'tipo', this.innerText)" style="background:rgba(255,255,255,0.05);">${r.tipo || ''}</td>
                    <td><span style="color:var(--accent-green); font-size:0.8rem; display:none;" id="eq-save-${index}">Guardado ✓</span></td>
                </tr>
            `).join('') || '<tr><td colspan="6">No hay equipos en la BD.</td></tr>';
        }
        else if (type === 'estimados') {
            title.innerText = 'Maestro: Base de Datos de Consumos Estimados (Editable)';
            records = await getAllEstimados();
            
            headerRow.innerHTML = `<th>Interno (Key)</th><th>Consumo Estimado (L/h o L/100km)</th><th>Origen de Dato</th><th>Acción</th>`;
            tbody.innerHTML = records.map((r, index) => `
                <tr id="est-row-${index}">
                    <td style="color:var(--accent-cyan); font-weight:bold;">${r.interno}</td>
                    <td contenteditable="true" onblur="window.saveDBRow('estimados', ${index}, 'consumo_estimado', this.innerText)" style="background:rgba(255,255,255,0.05);">${r.consumo_estimado || ''}</td>
                    <td>${r.source_file || 'Manual'}</td>
                    <td><span style="color:var(--accent-green); font-size:0.8rem; display:none;" id="est-save-${index}">Guardado ✓</span></td>
                </tr>
            `).join('') || '<tr><td colspan="4">No hay estimaciones en la BD.</td></tr>';
        }

        currentTableData = records;

    } catch (e) {
        console.error("Error al renderizar tabla:", e);
        tbody.innerHTML = '<tr><td colspan="6" style="color:red">Error al cargar registros.</td></tr>';
    }
}

export async function saveDBRow(dbName, index, field, newValue) {
    try {
        let record = currentTableData[index];
        if (!record) return;

        record[field] = newValue.trim();

        if (dbName === 'equipos') {
            await updateEquipo(record);
            showSaveIcon(`eq-save-${index}`);
        } else if (dbName === 'estimados') {
            await updateEstimado(record);
            showSaveIcon(`est-save-${index}`);
        }
    } catch(e) {
        console.error("Error al guardar fila:", e);
    }
}

function showSaveIcon(id) {
    const el = document.getElementById(id);
    if(el) {
        el.style.display = 'inline';
        setTimeout(() => el.style.display = 'none', 2000);
    }
}
