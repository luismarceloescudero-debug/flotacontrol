# Correcciones aplicadas — registro (13/08/2026)

Este archivo documenta qué se corrigió realmente en el código, verificado contra los
Excel reales de `ARCHIVOS/` (no solo leyendo la documentación previa). Los documentos
`RESUMEN_EJECUTIVO.md`, `PLAN_ROO_CODE.md`, `DIAGNOSTICO_NORMALIZACION.md`,
`.instructions.md`, `ROO_CODE_SETUP.md` y `.agent.md` se conservan como **historial** de
un intento de reparación anterior (vía Roo Code) — varias de las cosas que esos
documentos daban por "ya resueltas" en realidad no estaban conectadas de punta a punta.
Este archivo es la fuente de verdad actualizada.

## Bugs corregidos

1. **Dashboard vacío siempre**: `index.html` no tenía `id="dashboard-metrics"` en el
   contenedor que busca `dashboard.js` → `getElementById` devolvía `null` y la función
   cortaba sin pintar nada. Agregado el `id`.

2. **Vista "Equipos" rota al 100%**: `cards.js` usaba `statusClass`/`statusMsg` en el
   template sin definirlas en ningún lado → `ReferenceError` en cada tarjeta. Se agregó
   `getEquipoStatus()`, que compara el consumo real contra la meta de fábrica.

3. **Cruce de datos por igualdad exacta de texto**: `cards.js` comparaba
   `c.interno === eq.interno` en vez de usar `getCargasForEquipo`/`getGPSForEquipo`
   (que ya existían en `analyzer.js` y normalizan la clave, pero no se usaban). Ahora sí
   se usan.

4. **Horas de GPS mal agregadas**: el parser (`xlsx-parser.js`) solo tomaba la columna
   "Tiempo en movimiento" como número plano. Verificado contra
   `ARCHIVOS/Resumen de Flota*.xlsx`: la columna real viene como **fracción de día de
   Excel** (no como texto "HH:MM:SS"), y **no existe** una columna "Tiempo parado" en
   los archivos reales (solo "Tiempo en ralentí" + "Tiempo en movimiento"). Se agregó
   `parseExcelHours()`/`aggregateHours()` en `normalizer.js` y se conectó en el parser.

5. **`determineConsumptionType()` nunca resolvía un tipo de cálculo real**: comparaba
   las reglas (`TR`, `CM`, `BM`, etc.) contra `equipo.tipo` (texto descriptivo tipo
   "AUTOELEVADOR"), cuando esas reglas son prefijos del `interno`. Con el bug, ~el 100%
   de la flota caía en "Desconocido" y `consumo_real` quedaba en 0. Corregido para
   comparar contra el prefijo del `interno` (mismo criterio que ya usaba `cards.js` para
   excluir equipos sin tanque). Verificado: pasó de 0 equipos con tipo resuelto a 101/193.

6. **Columna "TIPO" duplicada en Equipos HSV\*.xlsx**: la fila de encabezados repite
   "TIPO" dos veces (categoría descriptiva + clasificación por peso). Al convertir filas
   a objetos, la segunda pisaba a la primera y se perdía el dato. Ahora las columnas
   repetidas se renombran automáticamente (`TIPO`, `TIPO_2`, ...).

7. **Fechas de GPS corruptas**: las celdas "Desde:"/"Hasta:" del reporte GPS traen
   `"1/1/2026, 0:00"` (coma pegada a la fecha). `parseDate()` solo cortaba por espacio,
   dejando la coma pegada al año (`"2026,-01-01"`), lo que rompía la comparación de
   fechas contra Cargas. Corregido para cortar por espacio o coma.

8. **Consumos estimados sin valor numérico**: se guardaba solo el texto crudo
   (`"3 L/hora"`), imposible de comparar. Ahora se guarda también
   `consumo_estimado_valor` (número puro), manteniendo el texto original para mostrar.

9. **`dashboard.js` con lógica de horas duplicada y desincronizada** de `analyzer.js`
   (hacía `parseFloat(g.horas)`, que da `NaN` si `horas` es un objeto). Se centralizó en
   `sumHoras()` (en `analyzer.js`), usada por ambos.

## Validación

Se armó un harness de Node (no versionado, temporal) que corre `xlsx-parser.js` +
`analyzer.js` contra los Excel reales (`Equipos HSV SJ-MZA 2026.xlsx`,
`Cargas_Combustible_HSV_2026.xlsx`, 3 meses de `Resumen de Flota*.xlsx`, `Consumos
Estimados 2026.xlsx`). Resultado: 193 equipos parseados, 3828 cargas, 120+ registros GPS
por mes, 134 estimados; 75 equipos con cruce completo (cargas + GPS), 101 con tipo de
cálculo resuelto (antes: prácticamente 0). Los valores de `consumo_real` quedan en
rangos creíbles pero **no fueron validados contra el conocimiento real de la flota** —
eso queda pendiente de que alguien de HSV los revise.

## Asistente IA ("Antigravity")

Se reemplazó la integración de Gemini (nunca llegó a conectarse; era un stub que decía
"Simulando conexión...") por Claude vía un backend propio (`api/chat.js`), para que la
API key no quede expuesta en el navegador. Capacidades reales:
- Análisis en lenguaje natural sobre un resumen de la flota (top 10 equipos, totales).
- Tool `get_equipo_detalle`: acceso on-demand a CUALQUIER equipo (no solo el top 10),
  resuelto contra el IndexedDB local del navegador.
- Tool `web_search` (nativa de Anthropic): research real en internet, con tope de 3
  búsquedas por mensaje (configurable, tiene costo aparte).

Requiere desplegar con la variable de entorno `ANTHROPIC_API_KEY` (ver `.env.example`).
No funciona abriendo `index.html` directo ni con un servidor estático simple sin backend.

## Qué quedó afuera de este commit (a propósito)

- `_archive/` (scripts Python puntuales sobre el HTML viejo) y `v2/` (estructura
  duplicada de `js/`/`styles/`, propósito sin definir): no se versionan todavía. Si
  alguno tiene código vivo que se necesite, avisar antes de descartarlos del todo.
- `Flota_Master_DB.json`, `masters_seed.json`, `Plantilla_Consumos_Oficiales.json`: datos
  internos de la flota. Se dejaron fuera del repo por defecto (ver `.gitignore`) hasta
  decidir conscientemente si se quieren versionar.
- `chart.umd.min.js`, `xlsx.full.min.js` (en la raíz): no se usan — `index.html` carga
  esas librerías por CDN. Quedaban del HTML monolítico viejo.
- Scripts sueltos de inspección (`test_parser.js`, `_tmp_inspect.js`, `inspect_data.js`,
  `extract_app_state.js`, `roo-code-init.js`, `test_browser.js`): quedaron afuera por ser
  herramientas puntuales de diagnóstico, algunas ya obsoletas (apuntan al HTML viejo).

## Pendiente (Fase 2 del plan original)

- `normalizeTimeGranularity()` para alinear correctamente cargas diarias vs. GPS
  mensual (hoy `calculateAlignedPeriod()` calcula la intersección de fechas pero no
  normaliza granularidad).
- Exportador a PDF (`exportUnitToPDF` sigue siendo un `alert()` placeholder).
- Tests automatizados (unitarios + E2E) con CI en GitHub Actions.
- Revisar la lógica de "ARIDOS" en `determineConsumptionType()` (condición de negocio
  ambigua, no se tocó — ver comentarios en `analyzer.js`).
