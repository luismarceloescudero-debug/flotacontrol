/**
 * Exportación de reportes
 */

export function exportUnitToPDF(interno) {
    alert(`Exportando reporte PDF para el equipo ${interno}...\n(La generación real del PDF se implementará integrando jsPDF/html2pdf)`);
    // TODO: Implement actual jsPDF logic here
}

export function exportTableToXLSX() {
    const table = document.getElementById('data-table');
    if (!table) {
        alert('No hay tabla para exportar');
        return;
    }
    try {
        const ws = XLSX.utils.table_to_sheet(table);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Datos');
        const filename = `FlotaControl_${new Date().toISOString().split('T')[0]}.xlsx`;
        XLSX.writeFile(wb, filename);
        console.log('✅ Exportado:', filename);
    } catch (e) {
        console.error('Error:', e);
        alert('Error: ' + e.message);
    }
}
