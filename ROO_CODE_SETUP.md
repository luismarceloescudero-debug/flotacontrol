# 🚀 FLOTACONTROL - SETUP PARA ROO CODE

## ¿QUÉ ES EL PROBLEMA?

La app **NO FUNCIONA** porque:
- ❌ Datos de "TR21", "TR-21", "TR 21" se ven como 3 equipos diferentes
- ❌ Horas en ralentí + movimiento + parado no se suman
- ❌ Datos de diferentes Excel no se cruzan
- ❌ Funciones `getAllRawRecords()` y `getAllEstimados()` no existen
- ❌ Exportador Excel no funciona

---

## 🎯 SOLUCIÓN (5 PASOS)

### PASO 1: Abrir `js/data/normalizer.js`

**Buscar:** La función que empieza con `export function extractDataFromString(val) {`

**ANTES de esa función, AGREGAR:**
```javascript
export function normalizeEquipoKey(interno) {
    if (!interno) return '';
    return normalizeString(interno).replace(/[\s\-_]/g, '').trim();
}
```

**Modificar la función `extractDataFromString` para que retorne también `interno_key`:**
```javascript
return { 
    interno, 
    dominio, 
    interno_key: normalizeEquipoKey(interno)  // ← AGREGAR ESTA LÍNEA
};
```

**AL FINAL DEL ARCHIVO, AGREGAR:**
```javascript
export function parseDuration(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    let str = String(val).trim();
    if (str.includes(':')) {
        let parts = str.split(':');
        if (parts.length === 3) {
            let h = parseNumber(parts[0]) || 0;
            let m = parseNumber(parts[1]) || 0;
            let s = parseNumber(parts[2]) || 0;
            return h + (m / 60) + (s / 3600);
        }
    }
    return parseNumber(str);
}

export function aggregateHours(horasDict) {
    if (!horasDict || typeof horasDict !== 'object') {
        return { ralenti: 0, movimiento: 0, parado: 0, total: 0 };
    }
    const hr = parseDuration(horasDict.ralenti || 0) || 0;
    const hm = parseDuration(horasDict.movimiento || 0) || 0;
    const hp = parseDuration(horasDict.parado || 0) || 0;
    const total = hr + hm + hp;
    return {
        ralenti: Math.round(hr * 100) / 100,
        movimiento: Math.round(hm * 100) / 100,
        parado: Math.round(hp * 100) / 100,
        total: Math.round(total * 100) / 100
    };
}
```

---

### PASO 2: Abrir `js/data/database.js`

**Buscar la función `getAllEstimados()`**

**DESPUÉS de esa función, AGREGAR:**
```javascript

export function getAllRawRecords() {
    return new Promise((resolve, reject) => {
        const transaction = getDB().transaction(['raw_records'], 'readonly');
        const store = transaction.objectStore('raw_records');
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e.target.error);
    });
}
```

---

### PASO 3: Abrir `js/data/analyzer.js`

**AL INICIO DEL ARCHIVO (después del comentario), AGREGAR:**
```javascript
import { normalizeEquipoKey } from './normalizer.js';
```

**Buscar la función `calculateMetrics()` y encontrar:**
```javascript
gpsList.forEach(g => {
    totalKm += (parseFloat(g.distancia) || 0);
    totalHoras += (parseFloat(g.horas) || 0);
});
```

**REEMPLAZAR por:**
```javascript
gpsList.forEach(g => {
    totalKm += (parseFloat(g.distancia) || 0);
    if (typeof g.horas === 'object' && g.horas.total) {
        totalHoras += g.horas.total;
    } else {
        totalHoras += (parseFloat(g.horas) || 0);
    }
});
```

**AL FINAL DEL ARCHIVO, ANTES DEL ÚLTIMO `}`, AGREGAR:**
```javascript

export function getCargasForEquipo(interno, rawRecords) {
    return rawRecords.filter(r => 
        r.type === 'carga' && 
        normalizeEquipoKey(r.interno) === normalizeEquipoKey(interno)
    );
}

export function getGPSForEquipo(interno, rawRecords) {
    return rawRecords.filter(r => 
        r.type === 'gps' && 
        normalizeEquipoKey(r.interno) === normalizeEquipoKey(interno)
    );
}
```

---

### PASO 4: Abrir `js/export/exporter.js`

**Buscar la función `exportTableToXLSX()`**

**REEMPLAZAR TODO POR:**
```javascript
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
```

---

### PASO 5: Verificación

Abre consola (F12) y ejecuta:

```javascript
console.log(typeof normalizeEquipoKey === 'function' ? "✅" : "❌");
console.log(typeof aggregateHours === 'function' ? "✅" : "❌");
console.log(typeof parseDuration === 'function' ? "✅" : "❌");
getAllRawRecords().then(r => console.log(`✅ ${r.length}`)).catch(e => console.log("❌", e.message));
getAllEstimados().then(r => console.log(`✅ ${r.length}`)).catch(e => console.log("❌", e.message));
```

---

## ✅ LISTO

Si ves 5 ✅, la app funciona. Sube los archivos Excel y presiona "Procesar y Analizar".
