# PLAN DE EJECUCIÓN PARA ROO CODE

## 🎯 Objetivo
Roo Code automatizará la corrección de problemas de normalización de datos.

---

## 📋 TAREAS EJECUTABLES

### TAREA 1: Analizar Estructura de Datos Reales
**Requisito:** Tener ejemplos de archivos Excel en `ARCHIVOS/`

```bash
Roo Code debe:
1. Listar archivos en ARCHIVOS/
2. Si existen .xlsx:
   - Leer la estructura de cada uno
   - Documentar columnas reales vs esperadas
   - Crear matriz: archivo → columnas → tipos de datos
3. Generar reporte: "Structure Analysis.md"
```

**Resultado esperado:**
```
ESTRUCTURA REAL DE DATOS
======================

Archivo: Equipos_HSV_20250801.xlsx
├─ Hoja: Equipos
├─ Columnas encontradas:
│  - INTERNO (ej: "TR-21")
│  - DOMINIO (ej: "HSV-200")
│  - MARCA (ej: "KOMATSU")
│  - MODELO (ej: "WA320")
│  - TIPO (ej: "CARGADOR FRONTAL")
└─ Primeras 3 filas parseadas: [...]

Archivo: Cargas_Combustible_20250801.xlsx
├─ Columnas:
│  - INTERNO (formato: "CM10", "TR21", etc.)
│  - FECHA (formato: DD/MM/YYYY)
│  - LITROS (formato: número decimal)
│  - LUGAR DE CARGA (texto libre)
└─ Primeras 3 filas: [...]

Archivo: Resumen de Flota Agosto 2025.xlsx
├─ Metadatos: Desde 2025-08-01, Hasta 2025-08-31
├─ Columnas:
│  - UNIDAD (formato: "TR-21" - ¡GUIÓN!)
│  - TIEMPO EN MOVIMIENTO (formato: HH:MM:SS)
│  - TIEMPO EN RALENTÍ (formato: HH:MM:SS)
│  - TIEMPO PARADO (formato: HH:MM:SS)
│  - KILÓMETROS RECORRIDOS (número)
└─ Primeras 3 filas: [...]

Archivo: Plantilla_Consumos_Oficiales.json
├─ Estructura: Array de objetos
├─ Campos:
│  - modelo (string)
│  - consumo_teorico (número en L/h o L/100km)
└─ Primeros 3 registros: [...]
```

---

### TAREA 2: Implementar `normalizeEquipoKey()` en normalizer.js

**Código a agregar:**
```javascript
// Copiar función normalizeEquipoKey() de normalizer-v2-mejorado.js
// Agregarla DESPUÉS de normalizeString()
```

**Verificación:**
```javascript
// Tests:
normalizeEquipoKey("TR-21") === "TR21" ✅
normalizeEquipoKey("TR 21") === "TR21" ✅
normalizeEquipoKey("TR21") === "TR21" ✅
normalizeEquipoKey("CM-10") === "CM10" ✅
normalizeEquipoKey("SR 001") === "SR001" ✅
```

---

### TAREA 3: Actualizar `extractDataFromString()` para Retornar Clave Normalizada

**Dónde:** `js/data/normalizer.js`, función `extractDataFromString()`

**Cambio:**
```javascript
// ANTES: return { interno, dominio };
// DESPUÉS: return { interno, dominio, interno_key: normalizeEquipoKey(interno) };
```

**Verificación:**
```javascript
extractDataFromString("CM10 JZE578").interno_key === "CM10" ✅
extractDataFromString("TR-21 HSV200").interno_key === "TR21" ✅
```

---

### TAREA 4: Actualizar `database.js` para Guardar `interno_key`

**Dónde:** `js/data/database.js`, función `insertEquipos()`

**Cambio:**
Cuando se guarda un equipo, agregar campo `interno_key`:
```javascript
// ANTES:
await store.put({
    interno: equipo.interno,
    dominio: equipo.dominio,
    ...
});

// DESPUÉS:
const extracted = extractDataFromString(equipo.interno);
await store.put({
    interno: extracted.interno,
    interno_key: extracted.interno_key,  // ← NUEVO
    dominio: equipo.dominio,
    ...
});
```

**Equivalente para `raw_records`:**
```javascript
// Al insertar registros de Cargas/GPS, también agregar:
const extracted = extractDataFromString(carga.interno);
await store.put({
    interno: extracted.interno,
    interno_key: extracted.interno_key,  // ← NUEVO
    fecha: carga.fecha,
    ...
});
```

---

### TAREA 5: Implementar `parseDuration()` en normalizer.js

**Código a agregar:** Función `parseDuration()` de normalizer-v2-mejorado.js

**Verificación:**
```javascript
parseDuration("12:30:45") === 12.5125 ✅
parseDuration("05:15:00") === 5.25 ✅
parseDuration("0:00:00") === 0 ✅
parseDuration(12.5) === 12.5 ✅
```

---

### TAREA 6: Implementar `aggregateHours()` en normalizer.js

**Código a agregar:** Función `aggregateHours()` de normalizer-v2-mejorado.js

**Verificación:**
```javascript
aggregateHours({ 
  ralenti: "05:15:00", 
  movimiento: "12:30:00", 
  parado: "02:45:00" 
})
// Retorna: { ralenti: 5.25, movimiento: 12.5, parado: 2.75, total: 20.5 }
```

---

### TAREA 7: Actualizar Parser de GPS en xlsx-parser.js

**Dónde:** `js/parsers/xlsx-parser.js`, sección `handleGPS()`

**Cambio:**
En lugar de buscar una sola columna "HORAS", buscar 3:
```javascript
// ANTES:
obj.horas = parseNumber(rawRows[i][idx]);

// DESPUÉS:
obj.horas = aggregateHours({
  ralenti: rawRows[i][headerIdx['TIEMPO EN RALENTI']],
  movimiento: rawRows[i][headerIdx['TIEMPO EN MOVIMIENTO']],
  parado: rawRows[i][headerIdx['TIEMPO PARADO']]
});
```

**Implicación:**
Ahora `raw_records` con `type='gps'` tendrá:
```json
{
  "tipo": "gps",
  "interno": "TR21",
  "horas": {
    "ralenti": 5.25,
    "movimiento": 12.5,
    "parado": 2.75,
    "total": 20.5
  }
}
```

---

### TAREA 8: Crear `getAllRawRecords()` en database.js

**Agregar función:**
```javascript
export function getAllRawRecords() {
    return new Promise((resolve, reject) => {
        if (!dbInstance) {
            reject(new Error("Database not initialized"));
            return;
        }
        const transaction = dbInstance.transaction(['raw_records'], 'readonly');
        const store = transaction.objectStore('raw_records');
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
```

**Verificación:**
```javascript
const allRecords = await getAllRawRecords();
console.log(`Registros totales: ${allRecords.length}`);
console.log(`Tipos: `, [...new Set(allRecords.map(r => r.type))]);
// Esperado: ["carga", "gps"] o similar
```

---

### TAREA 9: Crear `getAllEstimados()` en database.js

**Agregar función:**
```javascript
export function getAllEstimados() {
    return new Promise((resolve, reject) => {
        if (!dbInstance) {
            reject(new Error("Database not initialized"));
            return;
        }
        const transaction = dbInstance.transaction(['estimados'], 'readonly');
        const store = transaction.objectStore('estimados');
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
```

---

### TAREA 10: Actualizar `calculateMetrics()` en analyzer.js

**Dónde:** `js/data/analyzer.js`

**Cambio:**
```javascript
// ANTES:
export function calculateMetrics(equipo, cargasList, gpsList) {
    // ...
    let totalHoras = 0;
    gpsList.forEach(g => {
        totalHoras += (parseFloat(g.horas) || 0);
    });

// DESPUÉS:
export function calculateMetrics(equipo, cargasList, gpsList) {
    // ...
    let totalHoras = 0;
    gpsList.forEach(g => {
        if (typeof g.horas === 'object' && g.horas.total) {
            totalHoras += g.horas.total;  // Ya es suma de todos los tipos
        } else {
            totalHoras += (parseFloat(g.horas) || 0);  // Fallback
        }
    });
```

---

### TAREA 11: Crear Función de Cruce Mejorado

**Dónde:** `js/data/analyzer.js`

**Nueva función:**
```javascript
export function getCargasForEquipo(interno_key, rawRecords) {
    return rawRecords.filter(r => 
        r.type === 'carga' && 
        normalizeEquipoKey(r.interno) === interno_key
    );
}

export function getGPSForEquipo(interno_key, rawRecords) {
    return rawRecords.filter(r => 
        r.type === 'gps' && 
        normalizeEquipoKey(r.interno) === interno_key
    );
}
```

---

### TAREA 12: Implementar Exportador Excel Funcional

**Dónde:** `js/export/exporter.js`

**Reemplazar stub:**
```javascript
export function exportTableToXLSX() {
    const table = document.getElementById('data-table');
    if (!table) {
        alert('No hay tabla para exportar');
        return;
    }
    
    const ws = XLSX.utils.table_to_sheet(table);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Datos');
    
    const filename = `FlotaControl_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, filename);
}
```

---

### TAREA 13: Testear Integración

**Roo Code debe:**

1. **Test 1: Upload de archivos**
   ```
   Subir 4 archivos reales (Equipos, Cargas, GPS, Estimados)
   Verificar que se cargan sin errores
   Resultado: Console sin errores críticos
   ```

2. **Test 2: Integridad de Datos**
   ```
   Ejecutar en Console:
   - const allEquipos = await getAllEquipos();
   - const allRecords = await getAllRawRecords();
   - const allEstimados = await getAllEstimados();
   
   Verificar:
   ✅ allEquipos.length > 0
   ✅ allRecords.length > 0
   ✅ allEstimados.length > 0
   ✅ allRecords con type='gps' tienen horas.total
   ```

3. **Test 3: Cruce de Datos**
   ```
   Ejecutar en Console:
   - const eq = allEquipos[0];
   - const cargas = getCargasForEquipo(eq.interno_key, allRecords);
   - const gps = getGPSForEquipo(eq.interno_key, allRecords);
   
   Verificar:
   ✅ cargas.length > 0 (hay cargas para este equipo)
   ✅ gps.length > 0 (hay GPS para este equipo)
   ```

4. **Test 4: Cálculo de Consumos**
   ```
   Ejecutar en Console:
   - const metrics = calculateMetrics(eq, cargas, gps);
   
   Verificar:
   ✅ metrics.total_litros > 0
   ✅ metrics.tipo_calculo en ['L/100Km', 'L/Hora', 'No Aplica']
   ✅ metrics.consumo_real >= 0
   ```

5. **Test 5: Dashboard Actualizado**
   ```
   Navegar a Dashboard
   Verificar:
   ✅ Se cargan métricas globales
   ✅ No hay errores en console
   ✅ Top 10 consumidores mostrando datos correctos
   ```

---

## 🚀 MODO DE EJECUCIÓN EN ROO CODE

### Opción A: Automático (Recomendado)
```
Usuario: "/run-fixes"
Roo Code:
1. Ejecuta TAREAS 1-13 secuencialmente
2. Reporta progreso
3. Si hay error, lo intenta de nuevo
4. Al final: Reporte de éxito/fallo
```

### Opción B: Interactivo
```
Usuario: "¿Cuál es el siguiente paso?"
Roo Code:
1. Sugiere próxima tarea
2. Muestra el código a cambiar
3. Usuario aprueba
4. Roo Code aplica cambio
5. Valida resultado
6. Siguiente tarea
```

### Opción C: Consultivo
```
Usuario: "¿Por qué no suma horas?"
Roo Code:
1. Analiza código actual
2. Explica problema específico
3. Muestra dónde arreglarlo
4. Ofrece código mejorado
5. Pregunta si lo aplicar
```

---

## ✅ CHECKLIST DE COMPLETITUD

- [ ] Análisis de estructura de datos reales completado
- [ ] normalizeEquipoKey() implementado
- [ ] extractDataFromString() retorna interno_key
- [ ] database.js guarda interno_key en equipos y raw_records
- [ ] parseDuration() implementado
- [ ] aggregateHours() implementado
- [ ] Parser de GPS actualizado para 3 tipos de horas
- [ ] getAllRawRecords() creado
- [ ] getAllEstimados() creado
- [ ] calculateMetrics() usa horas agregadas correctamente
- [ ] Funciones de cruce (getCargasForEquipo, getGPSForEquipo) creadas
- [ ] Exportador Excel funcional
- [ ] Test 1: Upload sin errores ✅
- [ ] Test 2: Integridad de datos ✅
- [ ] Test 3: Cruce de datos ✅
- [ ] Test 4: Cálculo correcto ✅
- [ ] Test 5: Dashboard actualizado ✅
- [ ] Documentación actualizada
- [ ] Ready para Fase 2 (agregación temporal)

---

## 📞 PREGUNTAS FRECUENTES PARA ROO CODE

**P: ¿Qué hago si hay errores?**
R: Roo Code reporta el error específico y lo arregla, o pide ayuda del usuario.

**P: ¿Cómo valido que funciona?**
R: Después de cada tarea, Roo Code ejecuta tests mínimos en Console.

**P: ¿Qué pasa si hay inconsistencias de datos?**
R: Roo Code analiza y reporta qué columnas faltan o están fuera de formato.

**P: ¿Puedo pausar el proceso?**
R: Sí, Roo Code guarda estado y puede retomar.
