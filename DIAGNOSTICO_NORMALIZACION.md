# DIAGNÓSTICO DETALLADO - FlotaControl Data Normalization Issues

## 🔍 PROBLEMA 1: Normalización Temporal Deficiente

### Síntoma
- Archivo "Cargas Combustible": **datos diarios** (1 fila = 1 carga)
- Archivo "Resumen de Flota": **datos mensuales** (1 fila = 1 mes de un equipo)
- No se pueden cruzar directamente: 30 días ≠ 1 mes

### Causa Raíz
En `js/data/analyzer.js`, función `calculateAlignedPeriod()`:
```javascript
// Problema: compara fechas sin considerar granularidad
// Si Cargas: 01/08, 02/08, 03/08... 31/08 (30 registros)
// Si GPS: Agosto 2025 (1 registro con mes entero)
// → Alineación falla porque no normaliza a la misma unidad
```

### Impacto
```
Dashboard muestra:
- Total Litros: ✅ CORRECTO (suma todas las cargas)
- Total Horas: ❌ INCORRECTO (suma solo si hay datos diarios)
- Consumo Real: ❌ INCORRECTO (divide por horas incorrectas)
```

### Solución Arquitectónica
Necesita función:
```javascript
normalizeTimeGranularity(records, sourceGranularity, targetGranularity) {
  // Ejemplo: 30 registros diarios → 1 registro semanal
  // Suma: litros, km, horas
  // Promedia: consumos, velocidades
  // Retorna array normalizado a la misma granularidad
}
```

---

## 🔴 PROBLEMA 2: Suma de Horas Heterogéneas

### Síntoma
GPS "Resumen de Flota" trae 3 columnas de horas:
- TIEMPO EN RALENTÍ (H:MM:SS)
- TIEMPO EN MOVIMIENTO (H:MM:SS)  
- TIEMPO PARADO (H:MM:SS)

Pero `xlsx-parser.js` busca **una sola columna** "HORAS" y la primera que encuentra es:
```
rawRows[i]['TIEMPO EN MOVIMIENTO'] = "12:30:00" → parseado como 12.5 horas ✅
rawRows[i]['TIEMPO EN RALENTÍ'] = "05:15:00" → IGNORADO ❌
rawRows[i]['TIEMPO PARADO'] = "02:45:00" → IGNORADO ❌
```

### Causa Raíz
En `js/parsers/xlsx-parser.js` (líneas ~70-90):
```javascript
// Pseudocódigo actual:
headers.forEach(h => {
  if (h.includes('TIEMPO') || h.includes('HORA')) {
    obj.horas = parseNumber(rawRows[i][idx]); // Solo guarda UNA
  }
})
```

### Impacto
```
Equipo TR21:
- Horas reales en el mes: 20h (5 ralentí + 12 mov + 3 parado)
- App solo registra: 12h (solo movimiento)
- Consumo calculado: 25 L / 12h = 2.08 L/h ❌
- Consumo real debería ser: 25 L / 20h = 1.25 L/h
- ERROR: 66% sobrestimado
```

### Solución
Cambiar estructura de datos:
```javascript
// Antes:
{ interno: "TR21", horas: 12 }

// Después:
{ 
  interno: "TR21", 
  horas: { 
    ralenti: 5, 
    movimiento: 12, 
    parado: 3, 
    total: 20 
  } 
}
```

---

## 🔗 PROBLEMA 3: No Reconoce Datos Entre Planillas

### Síntoma
App tiene 4 "mundos" desconectados:

**Mundo 1: Equipos** (archivo "Equipos HSV...")
```json
{
  "interno": "TR21",
  "dominio": "HSV-200",
  "marca": "KOMATSU",
  "tipo": "CARGADOR FRONTAL"
}
```

**Mundo 2: Cargas** (archivo "Cargas_Combustible...")
```json
{
  "interno": "TR 21",        // ← Espacio en lugar de guión
  "fecha": "2025-08-01",
  "litros": 50
}
```

**Mundo 3: GPS** (archivo "Resumen de Flota...")
```json
{
  "unidad": "TR-21",         // ← Guión diferente
  "mes": "2025-08",
  "horas_movimiento": 120
}
```

**Mundo 4: Estimados** (archivo "Consumos Estimados...")
```json
{
  "interno": "TR21",         // ← Sin separador
  "consumo_estimado": 1.5
}
```

**Problema:** Todos dicen "TR21" pero con formatos diferentes:
- "TR21" ≠ "TR 21" ≠ "TR-21"

### Causa Raíz
Función `extractDataFromString()` en `normalizer.js`:
```javascript
// Sí normaliza a mayúsculas y quita acentos
// Sí quita guiones: "TR-21" → "TR21"
// ✅ PERO: solo se llama en ALGUNOS parsers, no en todos
// ✅ PERO: una vez normalizada en memory, se pierde cuando se guarda en DB
```

El problema: **Datos se normalizan una vez en parsing, pero se guardan SIN normalizar**

### Impacto
```
Cruce de datos falla:
- Buscas cargas de "TR21" → query: interno == "TR21"
- Pero en DB está guardado "TR 21" (con espacio)
- Resultado: 0 registros ❌
```

### Solución
Crear clave única normalizada:
```javascript
export function normalizeEquipoKey(interno, dominio = null) {
  // Input: "TR-21" o "TR 21" o "TR21"
  // Output: "TR21" (siempre igual)
  const norm = normalizeString(interno).replace(/[\s-]/g, '');
  return norm; // Usada como PRIMARY KEY en todas partes
}

// Aplicar en:
// - insertEquipos() → guardar como { ...orig, interno_key: normalizedKey }
// - insertRawRecords() → guardar con mismo key
// - busquedas → siempre normalizar antes de query
```

---

## 🚫 PROBLEMA 4: Consumos Estimados No Se Vinculan

### Síntoma
La función `getConfirmedConsumption()` en `analyzer.js` busca:
```javascript
const estimado = estimadosData.find(e => e.interno === key);
```

Pero `estimadosData` es un array que nunca se llena.

### Causa Raíz
1. Tabla `estimados` en IndexedDB existe
2. Se llama a `insertEstimados()` cuando se parsea el archivo
3. ✅ Se guarda bien en la DB
4. ❌ PERO: Nunca se LEE cuando se necesita

En `analyzer.js`:
```javascript
// Problema: la función recibe "estimadosData = []" (vacío por defecto)
export function calculateMetrics(equipo, cargasList, gpsList) {
  // estimadosData nunca se pasa, siempre es [] vacío
}
```

### Impacto
```
Cards muestra:
- Consumo Real: 1.5 L/h ✅
- Consumo Estimado: (sin datos) ❌
- Comparativa: No se puede calcular
```

### Solución
Modificar flujo:
```javascript
// Antes de calcular métricas, cargar estimados:
const estimados = await getAllEstimados();  // Nueva función
const metrics = calculateMetrics(equipo, cargas, gps, estimados);

// En database.js:
export function getAllEstimados() {
  return new Promise((resolve, reject) => {
    const tx = dbInstance.transaction(['estimados'], 'readonly');
    const store = tx.objectStore('estimados');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

---

## 📋 MATRIZ DE PROBLEMAS vs ARCHIVOS

| Problema | Archivo | Función | Línea | Fix |
|----------|---------|---------|-------|-----|
| Temporal | analyzer.js | calculateAlignedPeriod() | ~40-70 | Agregar granularidad |
| Horas | xlsx-parser.js | handleGPS() | ~200-250 | Detectar 3 tipos |
| Claves | normalizer.js | extractDataFromString() | ~30-40 | Crear normalizeEquipoKey() |
| Cruce | database.js | (missing) | - | Crear getAllEstimados() |
| missing | database.js | (missing) | - | Crear getAllRawRecords() |

---

## ✅ CHECKLIST DE VALIDACIÓN

Después de cada fix, verificar:

```
[ ] Equipos se cargan: verificar IndexedDB store "equipos"
    SELECT * FROM equipos LIMIT 5
    
[ ] Cargas se cargan: verificar IndexedDB store "raw_records"
    SELECT * FROM raw_records WHERE type='carga' LIMIT 10
    
[ ] GPS se carga: verificar que horas sean agregadas
    SELECT * FROM raw_records WHERE type='gps' LIMIT 1
    → Debe tener: { horas: { ralenti, movimiento, parado, total } }
    
[ ] Cruce funciona: verificar que interno_normalizado sea igual
    SELECT DISTINCT interno FROM equipos  (debe haber "TR21", "CM10", etc)
    SELECT DISTINCT interno FROM raw_records (debe haber mismos valores)
    
[ ] Consumos estimados se vinculan:
    SELECT COUNT(*) FROM estimados
    SELECT * FROM estimados LIMIT 1
    → calculateMetrics() debe recibir estos datos
```

---

## 🎯 PRIORIDAD DE FIXES

**HOY (crítico):**
1. Implementar `normalizeEquipoKey()` y usarla en todos lados
2. Modificar parser GPS para capturar 3 tipos de horas
3. Implementar `getAllEstimados()` en database.js
4. Implementar `getAllRawRecords()` en database.js

**ESTA SEMANA (importante):**
5. Crear `normalizeTimeGranularity()` para alinear períodos
6. Mejorar `calculateMetrics()` para trabajar con datos normalizados
7. Agregar validaciones en cada parser

**PRÓXIMA SEMANA (mejoras):**
8. Exporters funcionales
9. Tests automáticos
10. Más parsers (CSV, PDF)
