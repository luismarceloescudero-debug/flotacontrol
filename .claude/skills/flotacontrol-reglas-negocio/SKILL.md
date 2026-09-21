---
name: flotacontrol-reglas-negocio
description: >
  Aplicar cuando se toque cualquier cálculo, agregación, hallazgo, corrección automática,
  o vista nueva en FlotaControl. Contiene las invariantes que ningún cambio puede violar,
  las decisiones ya cerradas con el usuario (que no se vuelven a discutir), las reglas de
  escaping XSS del proyecto, y el patrón obligatorio para agregar una vista nueva.
---

# FlotaControl — Reglas de negocio, invariantes y convenciones

Este proyecto tiene tres invariantes que la app violó en el pasado y que ningún cambio puede
volver a violar. Están documentadas en `CLAUDE.md` bajo "Three invariants that keep the numbers
honest". Leelas antes de tocar cualquier cálculo, agregación o hallazgo.

## 1. Las tres invariantes

### Invariante 1 — Mismo período en los dos lados de una razón

Un consumo divide litros por actividad: **los dos operandos tienen que venir del mismo tramo de
meses**. Lo mismo vale para cualquier resta contra una meta (por ejemplo `calcularExceso()`):
los litros y la actividad de la comparación salen del mismo `alineacion`, nunca de "todo el
período" contra "solo los meses con GPS".

`alinearCargasYGps()` (analyzer.js) intersecta los meses con cargas de cada equipo con sus
meses con GPS, y el consumo se calcula sobre ese subconjunto (`litros_alineados` /
`km_alineados` / `horas_alineadas`). Los totales del período (`total_litros`, `total_km`,
`total_horas`) quedan intactos — son gasto y actividad reales y alimentan los KPIs de flota.

**Trampa a vigilar:** un registro GPS multi-mes (ej. "Resumen de Flota Ene-Jul") tiene
`periodo` igual al mes de su fecha de inicio, pero cubre siete meses. Usar `r.periodo` para
agrupar o filtrar cuenta esos siete meses como uno solo. La función que expande el rango es
`mesesDeRegistro(r)` (analyzer.js). `periodo` solo es seguro en cargas, que son puntuales.

### Invariante 1b — Todo KPI = Σ tarjetas + lo no asignado

Todo lo que entra a un total de flota tiene que poder descomponerse: **KPI = suma de las
tarjetas + `totales.sin_asignar`**, exacto, sin residuo.

Un huérfano aporta litros, kilómetros Y horas, no solo litros. El caso testigo: la unidad
`PORTATIL` del GPS tiene 6.903 km, 3.180 h y **cero litros** — si solo se acumulan litros, es
invisible en los hallazgos (que agrupan por litros) pero sigue sumando al KPI de kilómetros.
`totales.sin_asignar` publica `{litros, km, horas, codigos}` y los pasos de la trazabilidad
de los KPIs lo nombran.

La otra mitad de la regla: **lo que queda fuera del período**. El período es la intersección
Cargas ∩ GPS, así que meses con cargas y sin GPS quedan afuera de los KPIs. Eso está bien para
la razón, pero invisible para quien compara contra la planilla. `totales.fuera_de_periodo`
publica litros, costo y meses, y el hallazgo `meses_sin_gps` lo dice en palabras.

### Invariante 2 — Una definición por concepto

Conceptos que existen en un solo lugar y se importan, nunca se reimplementan:

| Concepto | Único dueño |
|---|---|
| Mediana | `mediana()` en diagnostico.js |
| Cobertura | `coberturaEquipo()` en diagnostico.js |
| Utilización | `utilizacion()` en diagnostico.js |
| Confiabilidad de una métrica | `confiabilidad()` en diagnostico.js |
| Jornada de referencia | `JORNADA_REFERENCIA` en analyzer.js |
| Días hábiles | `diasHabiles()` en feriados.js |
| Normalización de claves de equipo | `normalizeEquipoKey()` en normalizer.js |
| Meses de un registro multi-mes | `mesesDeRegistro()` en analyzer.js |

Escribir una segunda versión "porque es más rápido" produjo dos veces el mismo bug: la mediana
inline con `arr.sort()[Math.floor(n/2)]` devuelve el valor de arriba en una lista par, no el
promedio de los dos centrales. Está documentado en `CORRECCIONES_APLICADAS.md`.

### Invariante 3 — Un número bajo necesita contexto antes de ser conclusión

Toda métrica que sea **una razón** (L/día, $/carga, km/hora, L/m³) puede dar un número chico
simplemente porque la base es floja. Un total es un hecho; una razón es una conclusión.

`utilizacion()` compara horas por día hábil contra `JORNADA_REFERENCIA` (10-12 h para áridos y
mixers, de operaciones, no de los datos). Sin ese contexto, un equipo que trabajó poco se ve
idéntico a uno eficiente.

La regla práctica: en la comparativa (`comparativa.js`), las métricas que son razones llevan
`esTasa: true`. Si `confiabilidad()` dice que la base no se sostiene, esa celda **queda fuera
del cálculo de mejor/peor** y se muestra atenuada con "⚠ base floja" y el motivo en el tooltip.
Los totales no se marcan nunca.

## 2. Decisiones cerradas (no volver a discutir)

Estas decisiones se tomaron con el usuario después de medir contra los archivos reales de
`ARCHIVOS/`. No se revisan sin una medición nueva que las contradiga.

### Sobre datos faltantes

- **INTERNO SIN DOMINIO no es un error. DOMINIO SIN INTERNO no es un error.** Nunca se marca
  como advertencia ni se le pide al usuario que corrija. El análisis avanza con lo que hay.
- **Faltar un mes no es un error.** El análisis se hace sobre el período que comparten los
  archivos subidos. Si el usuario quiere analizar solo julio, sube solo el Resumen de Flota de
  julio. Nunca se le informa "falta el mes X".
- **Subir 3 meses o subir el año completo no es un error.** Se analiza la intersección de los
  meses con datos en ambas fuentes, aunque sea un solo mes.

### Sobre fuentes de datos

- **Los kilómetros de Loop nunca se usan como denominador de consumo.** Miden viaje cargado,
  no recorrido total. La columna se descarta; el archivo no.
- **Odómetro y horómetro de Wara quedan fuera del alcance.** No se leen ni se guardan en
  `handleGPS()`. De Wara solo se extrae: km recorridos, horas de ralentí y horas de movimiento.
- **El cruce con Informe de Ignición está eliminado.** `cruzarIgnicion()`, `handleIgnicion()`,
  el hallazgo `gps_vs_ignicion`, el case `reclamo_ignicion` y `CONSEJOS.gps_vs_ignicion` ya no
  existen. El control que buscaba ese cruce lo da ahora el ciclo de Loop (roadmap, ítem 9).
- **`Informe Volumen entregado por camión` es solo control de totales.** No aporta dato
  primario; sirve para detectar export incompletos. Se importa, pero se marca como derivable.
- **Los remitos de Loop en conflicto NO son parte del análisis de combustible.** El hallazgo
  `entregas_conflicto_remito` se eliminó. Los datos siguen guardados y visibles en "Entregas
  (Loop)" pero no ensucian el diagnóstico de consumo.

### Sobre autocorrecciones

- **Solo se autocorrigen códigos CON litros en la planilla de Cargas.** Un código que aparece
  únicamente en GPS o en Loop, sin ninguna carga, se descarta — no se da de alta ni se acepta.
  Implementado en `aplicarCorreccionesAutomaticas()` con `huerfanoAporta()` en diagnostico.js.
- **"Posible repetida" no es un hallazgo.** Dos cargas del mismo equipo, el mismo día, con los
  mismos litros pero distinto importe u hora son legítimas (dos surtidores, dos turnos). Solo el
  duplicado exacto — idéntico en todos los campos hasta el centavo — tiene corrección obvia.
- **Dar de alta un equipo nuevo es la normalidad, no un aviso.** Las acciones `alta_interno`
  salieron del hallazgo `acciones_automaticas`. Solo se reportan `aceptado_no_flota` y
  `meta_alineada`, que sí son decisiones que el usuario puede querer revertir.

### Sobre el entorno técnico

- **NUNCA agregar `"type": "module"` al `package.json`.** `xlsx.full.min.js` es UMD y los
  arneses lo cargan con `createRequire()`. Bajo `type: module` ese `require()` devuelve un
  objeto vacío, el parseo produce 0 filas y `verificar-datos-reales.mjs` mide **0 equipos en
  vez de 189 — sin lanzar un solo error**. Es exactamente la clase de falla silenciosa que los
  arneses existen para atrapar.
- **NO migrar a Dexie.** Evaluado 14/09/2026, descartado. Dexie y la conexión cruda no pueden
  coexistir sobre la misma base (Upgrade bloqueado por la otra conexión). Migrar todo de una
  eliminaría el problema pero también la validación incremental. El race condition que motivó
  la evaluación ya está resuelto por el `Map<id, cambios>` de `insertEntregasLoop()`.
- **NO agregar bundler.** El proyecto es "no build step" por decisión, no por accidente.
- **NO agregar framework SPA (React, Vue, Svelte, Alpine).** La UI es imperativa y esa decisión
  está tomada con evidencia (`panel.js` tiene 4.867 líneas y funciona; los tres arneses
  dependen de su forma actual).

## 3. Convención de escaping XSS

No hay un módulo compartido de escape. La función `esc()` está duplicada **verbatim** al inicio
de cada archivo que arma `innerHTML` desde datos dinámicos:

- `js/ui/panel.js`
- `js/ui/datatable.js`
- `js/ui/modals.js`
- `js/ui/comparativa.js`
- `js/ui/metas.js`
- `js/ui/seguimiento.js`
- `js/ui/upload.js`
- `js/ui/calcpopover.js`
- `js/data/diagnostico.js`

La definición exacta es:

```js
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));