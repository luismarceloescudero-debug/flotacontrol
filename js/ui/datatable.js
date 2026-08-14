import { getAllEquipos, getAllRawRecords, getAllEstimados, updateEquipo, updateEstimado } from '../data/database.js';
import { calculateAlignedPeriod, sumHoras } from '../data/analyzer.js';
import { parseConsumoEstimado, getDenominacion } from '../data/normalizer.js';

let currentTableData = [];

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function renderDataTable(type) {
    const container = document.getElementById('dashboard-table-container');
    const headerRow = document.getElementById('table-header');
    const tbody = document.getElementById('table-body');
    const title = document.getElementById('table-title');

    if (!container || !headerRow || !tbody) return;

    container.style.display = 'block';
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    tbody.innerHTML = '<tr><td colspan="8">Cargando registros...</td></tr>';
    headerRow.innerHTML = '';

    try {
        let records = [];

        if (type === 'carga' || type === 'gps') {
            const allRecords = await getAllRawRecords();
            const allCargas = allRecords.filter(r => r.type === 'carga');
            const allGps = allRecords.filter(r => r.type === 'gps');
            const { start, end } = calculateAlignedPeriod(allCargas, allGps);
            const enRango = r => !start || !end || !r.fecha || ((r.fecha_hasta || r.fecha) >= start && r.fecha <= end);

            if (type === 'carga') {
                title.innerText = 'Cargas de Combustible';
                records = allCargas.filter(enRango);
                headerRow.innerHTML = `<th>Fecha</th><th>Interno</th><th>Litros</th><th>Importe</th><th>Combustible</th><th>Lugar</th><th>Centro de costo</th><th>Chofer</th>`;
                tbody.innerHTML = records.map(r => `
                    <tr>
                        <td>${esc(r.fecha)}</td>
                        <td class="cell-key">${esc(r.interno)}</td>
                        <td>${nf(r.litros, 2)}</td>
                        <td>$${nf(r.importe, 2)}</td>
                        <td>${esc(r.combustible)}</td>
                        <td>${esc(r.lugar_carga)}</td>
                        <td>${esc(r.centro_costo)}</td>
                        <td>${esc(r.chofer)}</td>
                    </tr>`).join('') || '<tr><td colspan="8">No hay cargas registradas.</td></tr>';
            } else {
                title.innerText = 'Resumen de Flota (GPS)';
                records = allGps.filter(enRango);
                headerRow.innerHTML = `<th>Desde</th><th>Hasta</th><th>Interno</th><th>Km</th><th>Hs ralentí</th><th>Hs movimiento</th><th>Hs total</th>`;
                // Fix: `horas` ahora es un objeto {ralenti, movimiento, parado, total}.
                // La versión anterior hacía r.horas.toFixed(1) y rompía la tabla entera.
                tbody.innerHTML = records.map(r => {
                    const h = (r.horas && typeof r.horas === 'object') ? r.horas : { ralenti: 0, movimiento: parseFloat(r.horas) || 0, total: parseFloat(r.horas) || 0 };
                    return `
                    <tr>
                        <td>${esc(r.fecha)}</td>
                        <td>${esc(r.fecha_hasta || '')}</td>
                        <td class="cell-key">${esc(r.interno)}</td>
                        <td>${nf(r.distancia, 0)}</td>
                        <td>${nf(h.ralenti, 1)}</td>
                        <td>${nf(h.movimiento, 1)}</td>
                        <td><strong>${nf(h.total, 1)}</strong></td>
                    </tr>`;
                }).join('') || '<tr><td colspan="7">No hay registros de GPS.</td></tr>';
            }
        }
        else if (type === 'equipos') {
            title.innerText = 'Equipos (editable)';
            records = (await getAllEquipos()).sort((a, b) => (a.interno || '').localeCompare(b.interno || ''));
            headerRow.innerHTML = `<th>Interno</th><th>Denominación</th><th>Dominio</th><th>Marca</th><th>Modelo</th><th>Tipo original (Excel)</th><th></th>`;
            tbody.innerHTML = records.map((r, i) => `
                <tr>
                    <td class="cell-key">${esc(r.interno)}</td>
                    <td contenteditable="true" class="cell-edit" onblur="window.saveDBRow('equipos', ${i}, 'denominacion', this.innerText)">${esc(r.denominacion || getDenominacion(r.interno, r.tipo))}</td>
                    <td contenteditable="true" class="cell-edit" onblur="window.saveDBRow('equipos', ${i}, 'dominio', this.innerText)">${esc(r.dominio)}</td>
                    <td contenteditable="true" class="cell-edit" onblur="window.saveDBRow('equipos', ${i}, 'marca', this.innerText)">${esc(r.marca)}</td>
                    <td contenteditable="true" class="cell-edit" onblur="window.saveDBRow('equipos', ${i}, 'modelo', this.innerText)">${esc(r.modelo)}</td>
                    <td class="cell-muted">${esc(r.tipo)}</td>
                    <td><span class="save-flag" id="save-${i}">Guardado ✓</span></td>
                </tr>`).join('') || '<tr><td colspan="7">No hay equipos cargados.</td></tr>';
        }
        else if (type === 'estimados') {
            title.innerText = 'Consumos Estimados (editable)';
            records = (await getAllEstimados()).sort((a, b) => (a.interno || '').localeCompare(b.interno || ''));
            headerRow.innerHTML = `<th>Interno</th><th>Meta (texto)</th><th>Valor</th><th>Unidad</th><th>Origen</th><th></th>`;
            tbody.innerHTML = records.map((r, i) => `
                <tr>
                    <td class="cell-key">${esc(r.interno)}</td>
                    <td contenteditable="true" class="cell-edit" onblur="window.saveDBRow('estimados', ${i}, 'consumo_estimado', this.innerText)">${esc(r.consumo_estimado)}</td>
                    <td>${r.consumo_estimado_valor != null ? nf(r.consumo_estimado_valor, 2) : '—'}</td>
                    <td>${esc(r.consumo_estimado_unidad || '—')}</td>
                    <td class="cell-muted">${esc(r.source_file || 'Manual')}</td>
                    <td><span class="save-flag" id="save-${i}">Guardado ✓</span></td>
                </tr>`).join('') || '<tr><td colspan="6">No hay metas cargadas.</td></tr>';
        }

        currentTableData = records;
    } catch (e) {
        console.error('Error al renderizar tabla:', e);
        tbody.innerHTML = `<tr><td colspan="8" style="color:var(--accent-red)">Error al cargar registros: ${esc(e.message)}</td></tr>`;
    }
}

export async function saveDBRow(dbName, index, field, newValue) {
    try {
        const record = currentTableData[index];
        if (!record) return;

        record[field] = String(newValue).trim();

        if (dbName === 'equipos') {
            await updateEquipo(record);
        } else if (dbName === 'estimados') {
            // Al editar el texto de la meta ("8 L/hora") hay que re-derivar el número y la
            // unidad, porque son los campos que usa el cálculo. Antes solo se guardaba el
            // texto y el valor numérico quedaba desactualizado.
            if (field === 'consumo_estimado') {
                const p = parseConsumoEstimado(record.consumo_estimado);
                record.consumo_estimado_valor = p.valor;
                record.consumo_estimado_unidad = p.unidad;
            }
            await updateEstimado(record);
        }

        const flag = document.getElementById(`save-${index}`);
        if (flag) {
            flag.style.display = 'inline';
            setTimeout(() => { flag.style.display = 'none'; }, 1800);
        }
        if (typeof window.renderPanel === 'function') window.renderPanel();
    } catch (e) {
        console.error('Error al guardar fila:', e);
    }
}
