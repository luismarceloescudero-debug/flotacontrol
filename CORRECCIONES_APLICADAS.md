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
  normaliza granularidad) — parcialmente cubierto por `evolucionMensual()` (ya
  agrupaba cargas diarias en cubetas mensuales por equipo) y por los botones "Últimos
  N meses" agregados el 20/08/2026; sigue faltando una alineación multi-archivo a nivel
  de flota completa, no solo por equipo.
- Exportador a PDF (`exportUnitToPDF` sigue siendo un `alert()` placeholder).
- Tests automatizados (unitarios + E2E) con CI en GitHub Actions.
- Revisar la lógica de "ARIDOS" en `determineConsumptionType()` (condición de negocio
  ambigua, no se tocó — ver comentarios en `analyzer.js`).

## Correcciones aplicadas (20/08/2026)

Verificadas contra los Excel reales de `ARCHIVOS/` con un harness de Playwright (headless,
no versionado) que levanta la app en un servidor local y sube los 9 archivos reales
(Equipos, Cargas, Consumos Estimados y 6 meses de Resumen de Flota).

1. **`normalizeEquipoKey()` no igualaba códigos con y sin ceros a la izquierda**: el GPS
   exporta el interno sin relleno ("CF1", "TR9") pero el padrón de Equipos lo trae relleno
   ("CF01", "TR09") para el mismo equipo físico. Como la clave normalizada no igualaba
   ambas grafías, esos equipos perdían sus horas y km de GPS todos los meses (quedaban en
   "huérfanos" sin que se notara). Confirmado con datos reales: al aplicar el fix, CF1↔CF01
   y TR9↔TR09 cruzan correctamente y `equipos_con_datos` sube de 122 a 124 sobre el mismo
   dataset de 6 meses. La clave ahora le quita el cero a la izquierda solo al primer bloque
   de dígitos después del prefijo, sin tocar sufijos ("MX108VL" no se altera) ni colapsar
   códigos genuinamente distintos ("MX63" y "MX630" siguen siendo claves distintas).
   Quedan sin resolver (causas distintas, no son el mismo bug): `MX` suelto sin número,
   `CF40` (no es un problema de ceros), y `MX108VL`/`MX63TK` (sufijo pegado al código en el
   Excel de GPS) — se dejan en huérfanos para revisión manual, como ya preveía el flujo de
   correcciones de cargas.

2. **`confiabilidad()` usaba un umbral fijo de cantidad de cargas, sin importar cuán largo
   era el período analizado**: "3 cargas" pasaba como confiable igual si el período era una
   semana o 6 meses (130 días hábiles), cuando son señales muy distintas. Ahora, cuando se
   le pasa el período analizado, calcula además la **cobertura real**: días con al menos una
   carga sobre los días hábiles del período (reutilizando `diasHabiles()` de `feriados.js`,
   el mismo cálculo que ya se mostraba en el KPI de período). Se muestra en el modal de
   detalle de cada equipo ("Cargó combustible en 38 de 63 días hábiles del período
   analizado (60%)") y entra en los avisos de confiabilidad usados por "Ajustar metas" y el
   diagnóstico automático cuando la cobertura baja de 40%.

3. **Alinear varios archivos al mismo período reciente requería tildar mes por mes**: se
   agregaron botones "Últimos 3 meses" / "Últimos 6 meses" / "Últimos 12 meses" (cuando hay
   suficientes períodos con datos) junto al ya existente "N meses cruzados", para elegir de
   un click el tramo reciente sobre el que se quiere combinar/comparar Cargas + GPS + otras
   planillas, en vez de tildar cada mes a mano.

4. **Badge de archivo procesado mostraba "DONE"/"ERROR" en vez de "LISTO"/"ERROR"**:
   `processAllFiles()` en `upload.js` fijaba el texto correcto por archivo, pero el
   `renderFileList()` final volvía a pintar todos los badges con el texto crudo del estado
   (`f.status.toUpperCase()`), pisando el texto en español. Corregido con una tabla de
   etiquetas (`BADGE_LABEL`) usada en los dos lugares donde se pinta el badge.

## Correcciones aplicadas (20/08/2026, segunda tanda — feedback con capturas de la app en producción)

Mismo harness de Playwright contra los 9 archivos reales, más inspección directa de celdas
con `openpyxl` para los casos de identificación de equipos.

1. **Filtros de "Centro de costo" y "Lugar de carga" perdían valores minoritarios**:
   `poblarFiltroCentroCosto()`/`poblarFiltroLugarCarga()` armaban el desplegable con el
   valor MÁS FRECUENTE de cada equipo (`ubicacion.centroCosto`), no con todos los valores
   reales que aparecen en las cargas. Un equipo que cargó mayormente para "AMZA" pero alguna
   vez para una estación de servicio externa nunca mostraba esa segunda opción, así que el
   filtro terminaba con una lista incompleta y "adivinada". Corregido para construir ambos
   desplegables a partir de `ubicacion.centroCostoBreakdown` / `ubicacion.lugarCargaBreakdown`
   (todos los valores distintos, con conteo), y el filtro ahora matchea contra el desglose
   completo, no solo el top 1. Verificado con datos reales: el filtro de centro de costo
   ahora muestra los códigos reales de la planilla (AMZA, CMZA, LMZA, PMZA, PSM, PTY, SJ,
   TMZA), y el de lugar de carga ya incluye estaciones de servicio de terceros (ej. "EE SS
   CORONEL DIAZ").

2. **`MX108VL`/`MX63TK` con el interno mal extraído desde el GPS**: la columna "Unidad" del
   Resumen de Flota trae a veces interno + patente juntos en la misma celda, separados por
   espacio (ej. "MX-63-TK OXZ 911"). `extraerIdentidad()` partía la celda por espacios ANTES
   de clasificar cada token, así que una patente con espacio interno ("OXZ 911") se rompía en
   dos fragmentos que no calificaban ni como interno ni como dominio, y el algoritmo terminaba
   quedándose con una lectura incorrecta. Se reescribió `clasificarIdentificador()` para
   reconocer primero el candidato completo (interno con guiones tipo "MX-63-TK", patente con
   espacio tipo "OXZ 911") antes de partir por espacios, y `extraerIdentidad()` para probar
   esa clasificación de candidato completo antes de caer al partido por palabras. Verificado
   directamente contra los valores reales extraídos del Excel: ambos casos quedan con el
   interno correcto y sin romper ningún otro caso ya cubierto (celdas mixtas típicas, códigos
   atípicos).

3. **Tarjetas de equipos sin ninguna carga de combustible en el período**: aparecían en el
   panel igual que cualquier otro equipo, mostrando solo datos de GPS o quedando vacías. Por
   pedido explícito: la planilla de Cargas de Combustible es la que manda — es sobre esa que
   se arman los cruces de lugares de carga, interno/dominio, tipo de combustible, precio y
   centro de costo, y son las tarjetas que importan para el análisis. Se agregó un filtro base
   en `filtrarYOrdenar()` que oculta cualquier equipo con `cantidad_cargas === 0`, antes de
   aplicar el resto de los filtros de la UI.

4. **La tarjeta de detalle (overlay de pantalla completa) no usaba el cálculo inverso ya
   disponible en la grilla**: `cardHTML()` (la tarjeta chica) ya calculaba una actividad
   estimada (litros ÷ meta) cuando un equipo no tiene GPS, pero `abrirOverlayEquipo()` (la
   vista de detalle que se abre al hacer click en la tarjeta) es una función separada que no
   tenía esa lógica — mostraba "0,0 hs" y "Consumo real —" sin ninguna explicación, tal como
   se veía en la captura de AE01. Se portó la misma lógica de `actividadImplicita()` al
   overlay: ahora muestra "≈ X hs/km" con la fórmula usada, una nota explicando que no hay GPS
   y cómo se llegó al número, y el mismo badge "Estimado" que ya tenía la tarjeta. También se
   corrigió el estado (`estadoDe()`) para no repetir la advertencia genérica de "falta GPS"
   cuando ya se está mostrando la estimación arriba. Verificado en vivo contra un equipo real
   sin GPS (CF38): el overlay ahora muestra "≈ 1.044,5 hs — estimado: 8.355,8 L ÷ 8,00
   L/hora" en vez de un dato vacío.

5. **El hallazgo "N equipos cargan combustible sin dato de actividad" mezclaba dos
   situaciones distintas**: equipos que de verdad no se pueden estimar (sin meta ni GPS) con
   equipos que YA tienen una estimación por cálculo inverso — mostrando el mismo tono de
   advertencia para ambos casos, cuando el segundo no es un problema sin resolver. Se separó
   en dos hallazgos: uno de severidad media solo para los que no tienen ninguna base para
   estimar, y otro de severidad baja/informativa ("N equipos sin GPS, con actividad estimada
   por cálculo inverso") para los que sí, con una nota invitando a revisar la meta o los
   litros cargados si el número estimado no parece razonable.

6. **Botón "Ver cargas" (y varias acciones de los hallazgos: dar de alta un equipo, asignar
   centro de costo, ver registros GPS huérfanos) no hacían nada**: todos llamaban a
   `window.renderDataTable`, una función que nunca se publicaba en `window` — el guard
   `typeof window.renderDataTable === 'function'` daba `false` silenciosamente y el botón
   quedaba decorativo. Se agregó `abrirTablaConBusqueda()` en `datatable.js` (navega a la
   tabla correcta y deja la búsqueda ya aplicada por interno/dominio) y se publicó como
   `window.abrirTablaConBusqueda` desde `app.js`; todos los puntos de `panel.js` que antes
   armaban la navegación a mano ahora pasan por acá. Verificado en vivo: "Ver cargas" navega a
   Base de Datos con la búsqueda ya cargada y filas visibles.

7. **"Comparar estos equipos" no seguía el diseño visual del resto de las acciones del
   hallazgo**: el botón (y "Ver cargas") no tenían una regla de CSS propia, así que caían en
   el estilo de botón genérico en vez del mismo tratamiento visual que ya usan las demás
   acciones propuestas (`.btn-diag-propuesta`). Se agregó esa regla en `panel.css`. La
   funcionalidad en sí (abre la comparativa real con los equipos del hallazgo, con acceso al
   registro de carga vía el buscador) ya estaba conectada — se verificó en vivo que abre
   correctamente con los equipos precargados.

8. **"Ignorar" / "Ignorar todos" solo ocultaban el hallazgo, sin ofrecer la corrección**: por
   pedido explícito ("sugerir y ejecutar cambios"), ahora, si el hallazgo tiene una acción
   propuesta concreta (ajustar metas, dar de alta un equipo, etc.), "Ignorar" avisa antes de
   ocultar y da la opción de aplicar esa acción en su lugar; "Ignorar todos" avisa cuántos de
   los hallazgos visibles tienen una acción disponible. Sigue siendo reversible (no borra
   nada, se puede restaurar), pero ya no es un simple "taparlo y listo".

9. **Bug real encontrado al revisar el caso de BM07 (carga asignada a mano sin interno ni
   dominio)**: tanto el panel de corrección de cargas huérfanas (`datatable.js`) como el
   re-aplicado automático de esas correcciones al reimportar (`database.js`) armaban la
   `interno_key`/`dominio_key` a mano (`.toUpperCase().replace(...)`) en vez de usar
   `normalizeEquipoKey()` — la misma función que normaliza esas claves en todo el resto del
   sistema (la que se corrigió en la primera tanda para CF1/CF01, TR9/TR09). Una carga
   asignada manualmente a un interno con cero a la izquierda (ej. "BM07") podía terminar con
   una clave que NO coincidía con la que usan las demás planillas de ese mismo equipo,
   sacándolo silenciosamente de los cruces con GPS/Estimados. Corregido para usar
   `normalizeEquipoKey()` en los dos lugares. Recomendación: reabrir el panel de corrección de
   esa carga de BM07 (Base de Datos → Movimientos de cargas → buscar el registro) y
   reasignarla una vez subido este cambio, para que quede guardada con la clave correcta.

### No implementado en esta tanda (evaluado y descartado por alcance/riesgo)

- Automatizar por completo "Ignorar" para que ejecute una corrección de datos sin
  intervención (más allá de sugerirla y dejar aplicarla con un click): implica decidir de
  antemano qué corrección es "la correcta" para hallazgos con varias causas posibles
  (sobreconsumo, metas raras, pares), con riesgo de modificar datos del maestro sin que la
  persona lo confirme puntualmente. Se prefirió el punto intermedio (avisar + ofrecer
  aplicar) hasta tener una regla de negocio explícita de qué se puede auto-corregir.

## 20/08/2026, tercera tanda

Ronda de correcciones a partir de la revisión de la comparativa de equipos, la tarjeta de
cada equipo, el ajuste masivo de metas y el dashboard. Todo lo siguiente se verificó en vivo
con Playwright contra los 9 archivos reales de `ARCHIVOS/` (no solo revisando el código).

1. **"Períodos desalineados" se mostraba en la tarjeta chica pero no había forma de verlo ni
   actuar desde el overlay del equipo**: se agregó la misma información (qué meses tiene
   Cargas que no tiene GPS y viceversa) dentro del overlay, con un botón que lleva
   directamente a Base de Datos → Cargas de Combustible con ese interno ya buscado. De paso
   se encontró que el botón, al navegar, no cerraba el overlay antes de hacerlo: la tabla
   quedaba renderizada debajo del panel del equipo, que seguía interceptando todos los clicks
   (confirmado con Playwright: después de navegar, ningún botón de la vista de datos
   respondía). Se corrigió para cerrar el overlay antes de navegar. Verificado en vivo con
   TR26 (un equipo con desalineación real entre Cargas y GPS).

2. **Los botones "Últimos 3 meses" / "Últimos 6 meses" no tomaban meses completos**: contaban
   sobre la lista cruda de meses con datos, sin filtrar los meses que solo tienen Cargas o
   solo GPS (no ambos) ni excluir el mes en curso (que por definición está incompleto). Ahora
   `renderMesesGrid()` calcula primero los meses "cruzados" (con Cargas Y GPS a la vez,
   excluyendo el mes actual) y los botones usan esa lista tanto para el conteo mostrado
   ("N meses cruzados") como para la selección real al hacer click.

3. **"Normalizar todos con el real" no se reflejaba en la tabla de Consumos Estimados, y en
   general el ajuste masivo podía saltear equipos sin avisar**: eran dos bugs distintos.
   Primero, la causa raíz que explica la pregunta directa sobre MX102: el botón usaba la
   lista de equipos ya filtrada por el checkbox "Solo con datos confiables" (tildado por
   defecto), así que un equipo con poca cobertura de cargas (MX102: 30 cargas sobre 120 días
   hábiles, 25%) quedaba afuera de "normalizar TODOS" sin ningún aviso — su meta seguía
   mostrando el valor viejo de la planilla (12,00) en vez del consumo real (5,81). Se corrigió
   para que el botón siempre tome todos los equipos visibles, sin importar el estado del
   checkbox, y el diálogo de confirmación ahora informa cuántos de esos equipos tienen poca
   cobertura de datos (para que la persona decida con esa información, no que se filtren
   solos). Segundo, aparte del bug de la meta: la tabla de Consumos Estimados solo recorría
   los registros originales de la planilla de Estimados, así que un equipo con meta puesta a
   mano pero sin fila propia en esa planilla (como pasa después de normalizar) directamente no
   aparecía ahí — la meta estaba guardada pero invisible en esa vista. Se corrigió para que la
   tabla combine la planilla de Estimados con las metas del maestro y muestre una fila
   sintética con la etiqueta "Ajustado a mano" para esos casos. Verificado en vivo:
   MX102 pasó de 12,00 a 5,81 al normalizar, y ahora aparece en Consumos Estimados con esa
   etiqueta.

4. **Las tablas de Base de Datos no eran consistentes entre sí ni editables por completo**:
   se unificó el criterio de fechas (formato es-AR, ver punto 6) en todas las tablas de
   movimientos, y se agregó edición de encabezados: las columnas personalizadas del Maestro
   ahora tienen un botón para renombrarlas además del de borrarlas. El pedido puntual de poder
   corregir un interno que ya se había "Corregido" (el ejemplo dado: un interno con guion mal
   asignado) reveló un bug de fondo más serio: `huellaCarga()` — la función que identifica de
   forma estable cada carga para saber si ya tiene una corrección guardada — calculaba su
   clave usando el interno **actual** del registro, que es justamente el campo que la
   corrección modifica. Resultado: apenas se guardaba una corrección, la próxima vez que se
   recalculaba la huella ya no coincidía con la guardada, y la carga volvía a verse "sin
   corregir" — sin ningún error visible, perdiendo silenciosamente el vínculo con la
   corrección ya hecha. Se corrigió para que la huella use siempre el interno **original**
   del registro (`_interno_original`), no el corregido. De paso se encontró y corrigió el
   mismo problema en el guardado de una segunda edición sobre una corrección existente (el
   valor "original" que se guardaba ya era el corregido, no el real). Con esto arreglado, el
   badge "Corregido" ahora es un botón: click para reabrir el panel con los valores ya
   cargados y editarlos, con opción de "Deshacer corrección". Verificado en vivo: el badge
   persiste después de recargar la tabla, el formulario de edición viene precargado con los
   valores corregidos, y "Deshacer" restaura el registro original.

5. **Formato de fecha e idioma**: `index.html` pasó a `lang="es-AR"`. Se agregó
   `formatFechaAR()` (convierte el formato interno ISO `AAAA-MM-DD` a `DD/MM/AAAA` solo para
   mostrar, nunca para guardar ni comparar) y se aplicó en las tablas de historial de cargas y
   GPS de los modales, y en las columnas de fecha de las tablas de movimientos.

6. **Rediseño de la línea de período/cobertura de la tarjeta**: por pedido explícito, se le
   dio más peso a "cargas sobre días hábiles" (el dato que de verdad dice si el período tiene
   suficiente información) y se bajó de jerarquía el conteo de reportes GPS. Ahora cada
   tarjeta muestra un indicador "N de M días hábiles · P%" con color según cobertura (verde
   ≥40%, ámbar ≥20%, rojo por debajo), el rango de período se muestra una sola vez (antes
   aparecía duplicado entre cargas y GPS), y el conteo de GPS pasó a una línea secundaria más
   chica. Verificado en vivo con un equipo de cobertura media (30 cargas / 117 días hábiles,
   26%, ámbar).

7. **Badges del dashboard (KPIs) eran de solo lectura**: al revisar se confirmó que el
   mecanismo de "ver cómo se calculó" (`registrarCalculo()` / `calcpopover.js`) ya estaba
   conectado en los 6 KPIs — ese pedido ya estaba resuelto. Lo que faltaba era la parte de
   "llevarme al dato": se agregó a `calcpopover.js` la posibilidad de que un cálculo traiga
   botones de acción reales (no solo texto), y se conectaron acciones concretas en cada KPI:
   Combustible y Costo total → ver las cargas de combustible; Distancia y Horas de uso → ver
   los reportes GPS; Sobre la meta → ver esos equipos filtrados en el panel, o ajustar sus
   metas directamente; Equipos → ver el maestro completo, y si hay códigos sin padrón, ver esas
   cargas huérfanas ya buscadas; Período analizado → saltar al selector de período, o ver las
   cargas de ese período. Verificado en vivo: cada botón de acción navega o filtra
   correctamente y no quedan errores de consola.

### No implementado en esta tanda (evaluado y descartado por alcance/riesgo)

- Acción individual para cada código huérfano dentro del KPI "Equipos" (solo se ofrece ir al
  primero de la lista, buscado en Cargas de Combustible): mostrar los N códigos como una
  lista propia dentro del popover de cálculo hubiera requerido un tipo de contenido nuevo en
  `calcpopover.js` (no solo botones), que no estaba pedido explícitamente. La tabla de Cargas
  con ese código ya buscado permite ver y resolver el resto desde ahí.

## 20/08/2026, cuarta tanda

Ronda de correcciones a partir de un feedback largo con 4 capturas de la tabla de Cargas de
Combustible y el hallazgo de ralentí en producción. Se definieron 3 decisiones de alcance con
la persona antes de arrancar (reclamos de GPS como ticket interno, sin integración con
proveedor todavía; zoom multi-nivel completo en los KPIs, con retroceso; y un marco genérico
para que cualquier tipo de planilla nueva —cubiertas, filtros, insumos— tenga su pestaña con
estadísticas básicas sin necesidad de conocer sus columnas de antemano). Todo lo siguiente se
verificó en vivo con Playwright contra los 9 archivos reales de `ARCHIVOS/`, incluida una
pasada final que ejercita las 8 áreas juntas en una sola sesión de navegador (no solo cada
pieza por separado).

1. **HTML crudo visible en el contador de "sin asignar" de Cargas de Combustible** (el bug de
   las capturas): `actualizarContador()` armaba el texto con un `<span>` de color y un
   `<button>` reales, pero los escribía con `textContent` en vez de `innerHTML` — por eso en
   pantalla se veían las etiquetas HTML como texto literal en lugar de un botón funcional. Se
   corrigió a `innerHTML`. Verificado en vivo: el contador ahora renderiza un `<button>` real
   y clickeable, no la etiqueta como texto.

2. **Tabla de Cargas de Combustible: sin filtros por centro de costo/lugar, sin edición
   masiva, sin ordenar por lo que falta corregir**: se agregaron dos selects (centro de costo,
   lugar de carga) poblados con los valores reales del período, un selector de orden que pone
   primero las filas marcadas para corregir (huérfanas o con corrección pendiente), y una
   barra de selección masiva propia para esta tabla (independiente de la del Maestro, porque
   acá varias filas pueden compartir el mismo interno) con 4 acciones: asignar interno/dominio,
   fijar centro de costo, fijar lugar de carga, y eliminar en bloque. Verificado en vivo: los
   12 centros de costo del dataset aparecen en el filtro, "marcadas para corregir primero"
   efectivamente ordena las huérfanas al tope, y las 4 acciones masivas escriben en la base y
   quedan en el historial de ediciones (punto 4).

3. **Acciones reales en los hallazgos de ralentí**: antes el hallazgo solo mostraba la lista de
   equipos, sin ninguna acción sobre ellos. Se agregó un estado persistente por equipo
   (`ralentiEstados`, guardado en IndexedDB) con dos botones por fila — "Aceptable" (el equipo
   sale del hallazgo de ahora en más, por ejemplo un equipo estacionario donde el ralentí es
   su trabajo) y "Reclamo GPS" (genera un ticket interno para pedir revisión del equipo GPS,
   con un motivo sugerido según si es ralentí alto sostenido o inverosímil) — más un botón de
   acción masiva "Promediar y marcar como aceptable" que acepta de una sola vez a todos los
   equipos que están en la media del grupo para abajo, dejando visibles solo a los que se
   salen claramente por arriba para revisar uno por uno. Los reclamos se ven y se cierran desde
   un modal "Reclamos GPS" (con una nota de que por ahora hay que copiarlos o imprimirlos a
   mano para mandárselos al proveedor — no hay integración todavía, por decisión explícita de
   alcance). Los equipos aceptados se pueden ver y desmarcar desde otro modal. Verificado en
   vivo: marcar un equipo como aceptable lo saca de la lista y lo menciona en el detalle del
   hallazgo, "Promediar" marca en bloque, un reclamo generado aparece en el modal
   correspondiente, y desmarcar un aceptado lo devuelve a la lista.

4. **Edición completa de todas las tablas de Base de Datos, con historial**: se extendió la
   edición directa de celda (que ya existía en el Maestro) a las tablas de Cargas, GPS y
   cualquier tipo de movimiento genérico — incluidas las columnas de fecha, que ahora usan un
   selector de fecha en vez de texto libre. Las 3 columnas calculadas de GPS (horas de
   ralentí/movimiento/total, que salen de `horas`, no son un campo propio) se dejaron de solo
   lectura a propósito. Cada edición, en cualquier tabla, ahora queda registrada en un log
   persistente (`edicionesLog`) con tabla, registro, campo, valor anterior y valor nuevo, visible
   desde un nuevo botón "Historial" en la barra de Base de Datos. También se agregó edición de
   encabezados en las tablas de movimientos (renombrar una columna con un botón junto al
   título). Verificado en vivo: editar litros de una carga guarda el cambio, lo marca como
   editado en la celda, y aparece como fila nueva en el historial.

5. **Zoom multi-nivel en los badges del dashboard (KPIs)**: hasta ahora el popover de "cómo se
   calculó" era un solo nivel fijo. Se reescribió `calcpopover.js` para soportar una pila de
   niveles: cualquier paso o acción puede traer una función `zoom` que abre un nivel nuevo
   encima del actual, con una migaja de pan arriba (para saltar a cualquier nivel anterior de
   un click) y un botón "Volver" (un nivel por vez); un nivel sin más `zoom` para ofrecer
   muestra "No hay más detalle para este dato" en vez de dejar botones muertos. Sobre esa base
   se armó el recorrido real: Combustible, Costo, Distancia y Horas de uso bajan de "total de
   la flota" a "aporte de cada equipo, ordenado de mayor a menor" y de ahí al detalle de las
   cargas o los registros GPS concretos de ese equipo (terminal, con botón a la tabla
   completa); Sobre la meta baja de "cuántos equipos" a la lista de esos equipos y de ahí al
   detalle de meta vs. consumo real de cada uno (terminal). Verificado en vivo con los 4
   recorridos completos: cada nivel muestra las migas correctas, "Volver" y el click en una
   miga anterior navegan bien, y el nivel terminal muestra el mensaje de "no hay más detalle"
   junto con su acción a la tabla.

6. **Marco genérico para nuevos tipos de datos de flota (cubiertas, filtros, insumos)**: al
   revisar se confirmó que la base ya generaba automáticamente una pestaña por cada `type` de
   planilla presente (`getTiposDeMovimiento()` + `renderTabs()`) y ya auto-detectaba columnas
   cuando no había una definición fija (`COLS_MOV`) — ese armazón ya estaba resuelto de una
   ronda anterior. Lo que faltaba era un resumen útil arriba de la tabla: se agregó
   `resumenGenerico()`, que cuenta equipos involucrados, detecta columnas numéricas con nombre
   de costo/importe/precio y las suma, y muestra los equipos con más registros. Verificado en
   vivo insertando registros sintéticos de una planilla ficticia de "Cubiertas": se creó sola
   la pestaña con su nombre y cantidad, se auto-detectaron sus columnas (marca, medida), y el
   resumen mostró equipos, costo total y el desglose por equipo correctamente.

### No implementado en esta tanda (evaluado y descartado por alcance/riesgo)

- Integración real con un proveedor de GPS para los reclamos (carga de datos del proveedor,
  envío automático de tickets): por decisión explícita, esta ronda deja el reclamo como un
  registro interno completo (equipo, motivo, fecha, estado) con el campo `proveedor` ya
  preparado en la base para cuando se sume esa integración, pero sin conectar nada externo
  todavía.

## 20/08/2026, quinta tanda

Ronda de correcciones a partir de un feedback largo con 6 capturas de la corrección masiva en
Cargas, el hallazgo de ralentí y el hallazgo de "vehículos sin interno" en producción. Todo lo
siguiente se verificó en vivo con Playwright contra los 9 archivos reales de `ARCHIVOS/`,
incluida una pasada final que ejercita las 7 correcciones juntas en una sola sesión de
navegador, más una repetición completa de la pasada de regresión de la ronda anterior (8 áreas)
para confirmar que nada se rompió.

1. **La corrección masiva de interno en Cargas no aplicaba a todos los registros** (el bug
   principal de las capturas, ej. "DEMO SCANIA"): la causa NO estaba en la selección múltiple
   por checkbox de la tabla (esa se probó aparte y ya funcionaba bien), sino en que corregir
   una fila una por una desde el panel de "Corregir" solo tocaba esa fila. Se agregó, dentro de
   ese mismo panel, un checkbox tildado por defecto "Aplicar esta asignación a las otras N
   cargas sin asignar del mismo dominio (patente)" — al guardar, además de la fila que se
   estaba corrigiendo, se les asigna el mismo interno a todas las demás cargas de ese dominio
   que todavía no tenían equipo asignado. De paso se encontró y corrigió un `ReferenceError`
   (`interno_original is not defined`) que quedó de una variable renombrada, y que cortaba en
   seco la función antes de llegar a aplicar el resto del dominio — sin ese error a la vista en
   pantalla, porque quedaba silenciado en la consola. Verificado en vivo: corregir 1 de 18
   cargas del mismo dominio con el checkbox tildado asignó el interno a las 18, no solo a 1.

2. **"Promediar y marcar como aceptable" aplicaba a los 15 equipos a ciegas, sin poder elegir**:
   al revisar se encontró que esa acción trabaja sobre los equipos "en la media para abajo",
   que casi nunca son los mismos que ya se ven en la lista principal del hallazgo (esa lista
   muestra los peores, no los de la media) — por eso no había forma de tildar/destildar nada,
   directamente no estaban listados en ningún lado. Se agregó un desplegable "Ver los N equipos
   en la media para abajo" dentro de la tarjeta, con un checkbox tildado por defecto para cada
   uno, y el botón "Promediar" ahora solo marca como aceptable a los que quedaron tildados.
   Verificado en vivo: con un equipo destildado a propósito, el botón marcó a los otros 15 pero
   ese en particular no quedó como aceptable.

3. **Reclamo GPS: el motivo no se veía bien y no ofrecía enviar por mail**: el `prompt()` del
   navegador cortaba el motivo sugerido (que puede ser largo) y no daba forma de abrirlo en un
   cliente de mail. Se reemplazó por un modal propio con el motivo en un textarea editable
   (se ve completo, se puede corregir antes de guardar) y dos botones: "Guardar reclamo" (como
   antes) y "Guardar y enviar por mail", que arma un `mailto:` con asunto y cuerpo ya redactados
   y lo abre con el cliente de correo predeterminado del equipo (Outlook u otro) — la app no
   manda nada por sí sola, solo prepara el mensaje para que lo mande la persona, ya que
   (como se definió en la ronda anterior) no hay integración con ningún proveedor todavía.
   Verificado en vivo: el modal muestra el motivo completo, el botón de mail está presente, y
   guardar sin mail deja el reclamo registrado igual.

4. **Hallazgo "vehículos con patente pero sin interno en el padrón": no había forma de marcar
   un código como válido así**: asignarle un interno a mano a una de estas cargas no alcanza,
   porque este hallazgo solo compara contra los equipos reales del padrón — un interno inventado
   nunca va a calzar. Se agregó un mecanismo aparte, independiente del padrón: un nuevo store en
   la base (`noFlotaAceptados`, IndexedDB pasó de v6 a v7) donde se guarda qué códigos se
   marcaron como "así está bien" (típico caso: vehículo de un programa de préstamo/demo, con
   centro de costo pero sin interno propio). Cada código marcado sale del cálculo del hallazgo
   de ahí en adelante (se excluye de litros/costo/cantidad, con una nota de cuántos quedaron
   afuera por esta razón en el detalle) y se puede ver y desmarcar desde un modal "Códigos
   válidos así". Verificado en vivo: marcar un código lo sacó de la lista del hallazgo (bajó de
   3 a 2 ítems) y quedó excluido del cálculo.

5. **La sugerencia de cálculo inverso (CF38) no mostraba de qué equipos salía la referencia**:
   el cálculo (`sugerirMeta`) ya traía internamente la lista de equipos usados como referencia,
   simplemente no se mostraba en ningún lado. Se agregó un botón chico "Ver equipos de
   referencia" junto al botón de sugerir, que abre el mismo popover de "cómo se calculó" ya
   existente con el detalle de cada equipo de referencia y su valor. Verificado en vivo: el
   popover se abrió mostrando los 8 equipos usados como referencia para la sugerencia.

6. **El overlay de detalle de equipo perdía información que sí estaba en la tarjeta chica**
   (días hábiles cubiertos, cantidad de puntos GPS): las dos vistas tenían implementaciones
   separadas y desactualizadas de la misma idea de "info del período" — la tarjeta chica se
   había ido actualizando en rondas anteriores y el overlay se quedó atrás. En vez de parchear
   el overlay a mano se lo hizo llamar a la misma función compartida que ya arma esa línea en la
   tarjeta chica (`cardPeriodoInfo()`), para que las dos vistas queden sincronizadas de acá en
   más y no vuelvan a desviarse. Verificado en vivo: el overlay ahora muestra días hábiles
   cubiertos, período, cantidad de puntos GPS y el aviso de ralentí, igual que la tarjeta chica.

7. **Badge "PENDING" en inglés al cargar archivos**: quedó de una ronda anterior que tradujo
   "LISTO"/"ERROR" pero se le pasó por alto "pending". Corregido a "PENDIENTE". Verificado en
   vivo: el badge dice "PENDIENTE" antes de procesar los archivos.

## 03/09/2026 — arnés de verificación contra datos reales, y un bug real que encontró el día 1

Se armó `tools/verificar-datos-reales.mjs`: no reimplementa el parseo ni el análisis, corre el
pipeline REAL de la app (`xlsx-parser.js` → `database.js` → `analyzer.js` → `diagnostico.js`)
sobre los 13 Excel reales de `ARCHIVOS/`, con `fake-indexeddb` en vez del IndexedDB del
navegador (misma API, en memoria) porque Node no tiene IndexedDB. `npm run verificar` corre y
compara contra `tools/invariantes.json`; `npm run verificar:actualizar` fija nuevos valores
esperados cuando el cambio de número es intencional. Sale con código ≠ 0 si algo no coincide.

1. **Bug real, encontrado por el arnés en su primera corrida — condición de carrera en
   `insertEntregasLoop()` (database.js) perdía volumen de las entregas de Loop, silenciosamente**:
   el volumen total de "Entregas (Loop)" daba **31.822 m³** en vez de los ~55.365 m³ que dan
   tanto el detalle sumado a mano como el propio resumen oficial de Loop ("Informe Volumen
   entregado por camión", 56.386,0 m³). Causa: cuando el mismo remito toca un registro ya
   guardado más de una vez dentro de una misma importación (el caso típico: "Informe Entregas
   Loop" trae el mismo remito en las hojas Hormigón, Bombeado Y Otros — son subconjuntos entre
   sí, no entregas distintas — y además puede calzar con un registro que ya había dejado
   "Exportado informe de Viajes"), el código encolaba un `{id, cambios}` por cada toque y al
   final hacía un `get()` + `put()` **independiente por cada uno**. Los `get()` de los tres
   toques se disparan antes de que el `put()` del primero resuelva, así que los tres leen la
   MISMA foto vieja del registro (sin el volumen todavía) — el último `put()` en resolver ganaba
   y pisaba, con esa foto vieja, el volumen que el anterior acababa de guardar. Se corrigió
   acumulando los cambios por `id` en un `Map` antes de tocar la base, así cada registro se lee
   y se escribe **una sola vez** con todos sus cambios ya combinados: no quedan dos escrituras
   que puedan pisarse. Verificado con un script dirigido sobre los dos archivos de Loop: antes
   del fix, 2.643 de 7.037 registros finales quedaban con volumen en 0 pese a tener una fuente
   ('detalle') que sí lo traía; después del fix, solo 3 (remitos reales sin contraparte en el
   detalle — no es un bug, es un hueco de la planilla). El total pasó de 31.822 a 55.364,5 m³.

2. **Cálculo inverso, segunda fuente independiente**: `actividadImplicita()` (diagnostico.js)
   estimaba la actividad de un equipo sin GPS dividiendo litros ÷ meta — un solo número, que
   depende por completo de que la meta cargada sea correcta. Se agregó una segunda estimación,
   independiente de la meta: días hábiles que el equipo *realmente* cargó combustible (nunca un
   período inventado) × la jornada de referencia que informa la propia operación
   (`JORNADA_REFERENCIA` en analyzer.js — ya existía, no se usaba para esto). Cuando las dos
   estimaciones no coinciden, `estimacionCreible()` lo suma como un tercer motivo de sospecha,
   independiente de los pares y de la potencia declarada que ya usaba. Se muestra en la tarjeta,
   el overlay del equipo y la tabla de comparación de estimaciones, siempre con la fórmula
   (`N días hábiles × X-Y hs/día`) visible junto al número — ningún resultado nuevo se agregó
   sin sus pasos de cálculo a la vista.

## 03/09/2026, segunda tanda — diagnóstico que se aplica solo, y un bug propio encontrado antes de commitear

1. **Nuevo: diagnóstico automático que aplica directamente lo que no tiene ambigüedad**
   (`js/data/autocorreccion.js`, corre en cada `renderPanel()` antes de mostrar nada). Dos
   categorías:
   - **Cargas huérfanas** (código sin fila en el maestro): si el código tiene forma de interno
     válida y la app sabe calcularle algo (su prefijo está en `RULE_L_100KM`, `RULE_L_HORA` o
     `RULE_NO_TANK` de analyzer.js), se da de alta como equipo nuevo directamente. Si no tiene
     forma de interno ni de patente (no hay más dato para resolverlo), se acepta como "así está
     bien" automáticamente. El caso ambiguo —una patente real sin interno en el padrón, que
     necesita que alguien identifique a mano de qué equipo se trata— se deja sin tocar, para
     revisión manual, igual que antes.
   - **Metas vacías**: un equipo sin meta cargada pero con consumo real medible y confiable
     (`metaDesdeConsumoReal().confiable`) se alinea a su propio consumo real la primera vez. No
     queda marcada `editado_manual`, a propósito: si más adelante se importa el valor real de
     fábrica en "Consumos Estimados", tiene que poder pisar esta alineación sin que nadie
     destilde nada primero.

   Cada acción queda anotada en el nuevo store `accionesAutomaticas` (IndexedDB v11 → v12) y
   aparece como hallazgo informativo "se aplicó sola" (severidad baja, con motivo y fecha) en
   vez de desaparecer en silencio — es la forma de "poner para revisión" sin construir una cola
   de aprobación previa, que hubiera vuelto todo manual otra vez.

2. **Bug propio, encontrado antes de commitear por la misma disciplina de verificar contra datos
   reales**: la primera versión de la regla de alta automática daba de alta *cualquier* código
   con forma de interno válida, sin mirar si la app sabe calcularle algo. Corriendo el arnés
   contra los datos reales y revisando la lista completa (no solo el conteo), aparecieron
   `CA01`, `CL03`, `LM01`, `LM02`, `GR01`, `MT03`, `MT04` dados de alta como "equipos nuevos".
   Cuatro de esos son legítimos (`CL03`, `MT03`, `MT04` = CALOVENTOR/MOTOCOMPRESOR, tienen regla
   L/Hora igual que un grupo electrógeno; `CF40` = CARGADORA FRONTAL). Pero `CA01` (CALDERA) y
   `LM01`/`LM02` (LIMPIEZA) están en `TIPO_POR_PREFIJO` —tienen nombre, son gasto real— y en
   NINGUNA regla de cálculo: el comentario de la propia v9 de `database.js` ya los nombra como
   "prefijos fuera de flota" (`CA = CALDERA, LM = LIMPIEZA`). Darlos de alta como equipo rodante
   los dejaba con `tipo_calculo` sin resolver — una tarjeta rota — en vez de la clasificación
   como gasto de planta que `clasificarNoFlota()` ya les da correctamente. `GR01` ni siquiera
   está en `TIPO_POR_PREFIJO`: prefijo totalmente desconocido. Corregido: solo se da de alta
   cuando el prefijo tiene una regla de cálculo real (`PREFIJOS_CALCULABLES` en
   autocorreccion.js); lo demás queda sin tocar, para revisión manual — el default seguro
   cuando la app no está segura, en vez de adivinar. Verificado de nuevo tras el fix: 4 altas
   (antes 8), y `CA01`/`LM01`/`LM02`/`GR01` quedan correctamente afuera.

3. **Bug real en el reclamo GPS consolidado: el botón no existía** — `mailtoReclamoConsolidado()`
   (un solo mail con todos los reclamos abiertos, agrupados por motivo — ralentí, camionetas,
   etc. — con la evidencia de cada unidad) estaba completamente implementada, con su listener
   ya cableado (`modal.querySelector('.btn-reclamo-consolidado')`), pero el `<button
   class="btn-reclamo-consolidado">` nunca se agregó al HTML del modal — el `?.` del listener
   fallaba en silencio, así que la función existía pero era inalcanzable desde la interfaz.
   Agregado el botón, visible cuando hay más de un reclamo abierto.

4. **Base de Datos: columnas "Interno" y "Dominio" separadas → una sola columna "Equipo"**.
   Antes cada fila mostraba las dos columnas siempre, con "—" en la que no aplicaba. Ahora
   muestra el común denominador: `interno + dominio` cuando la fila trae los dos (ej. "MX96
   AF809IF"), solo el interno cuando no hay dominio (ej. "CF38"), o solo el dominio cuando no
   hay interno (ej. "AG546OW").

5. **Dos afirmaciones más que no resistían los datos, corregidas** (mismo patrón que la ronda
   anterior): el comentario de `xlsx-parser.js` sobre por qué se leen las 3 hojas de "Informe
   Entregas Loop" ahora dice lo que se midió (Bombeado y Otros son subconjuntos, 0 remitos
   nuevos) en vez de "dejaba afuera dos tercios de las entregas reales". El cartel de "Volumen
   por camión" en Base de Datos ya no afirma que sumando el detalle "se llega a los mismos
   números" (falso: difiere en los meses donde el export de Loop viene incompleto) — ahora
   explica que es un control de totales y qué hacer cuando no coincide.

## Limpieza de directorio (03/09/2026)

Borrados por no aportar nada al análisis (verificado: cero referencias en el proyecto):
`js/ui/dashboard.js`, `js/ui/cards.js`, `js/export/exporter.js` (los tres eran reexports/stubs
obsoletos desde la unificación en `panel.js`, documentada arriba en la ronda del 13/08).
Borrados también los 7 docs históricos de la reparación vía Roo Code
(`.agent.md`, `.instructions.md`, `.prompt.md`, `PLAN_ROO_CODE.md`, `ROO_CODE_SETUP.md`,
`DIAGNOSTICO_NORMALIZACION.md`, `RESUMEN_EJECUTIVO.md`) — su contenido queda superado por este
archivo y disponible en el historial de git si hace falta. CLAUDE.md actualizado para no
referenciarlos.

## 03/09/2026, tercera tanda — un bug de normalización real, y el detector de tipeo que casi se pasa de listo

1. **Bug de normalización real: Horómetro se guardaba 24 veces más chico** (`handleGPS()` en
   xlsx-parser.js). El GPS empezó a exportar esta columna en el archivo de julio 2026, con la
   MISMA codificación que Tiempo en ralentí/movimiento (fracción de día de Excel, formato de
   celda `[h]:mm`) — pero se leía con `parseNumber()` en vez de `parseExcelHours()`. Verificado
   contra el archivo real: el crudo `1343.4488…` de BM-07 muestra "32242:46" en Excel
   (`1343.4488 × 24 = 32242,77` hs) pero quedaba guardado como `1343.45` — un número que hoy no
   alimenta ningún cálculo (Horómetro está documentado como "nunca leer como horas del período"),
   pero que sería 24 veces menor a la primera vez que alguien lo use. Corregido para que
   comparta la misma normalización que el resto de los campos de tiempo del GPS.

2. **Detector de "código huérfano que parece error de tipeo"**, agregado a partir de un caso
   real: una carga con interno "GR01" — un chofer que esa semana cargó GE01, GE02 y GE03 (grupos
   electrógenos reales) escribió "GR01" una sola vez. "GR" no existe en ningún lado de la
   nomenclatura de la flota. `sugerirPosibleTypo()` (normalizer.js) compara cada código huérfano
   contra los internos reales del maestro; si está a un solo carácter de uno y su prefijo no es
   reconocido en ningún sentido (ni con equipos dados de alta, ni como categoría con nombre en
   `TIPO_POR_PREFIJO`), lo señala como sospechoso — nunca lo corrige solo. Aparece como hallazgo
   aparte ("parece error de tipeo") y `autocorreccion.js` lo excluye tanto del alta automática
   como de la aceptación como "así está bien", para no perder de vista que esos litros son de un
   equipo que sí existe.

   **Dos falsos positivos encontrados y corregidos antes de confiar en el detector**: la primera
   versión solo miraba "¿el prefijo tiene algún equipo YA dado de alta?" — con esa regla, "CL03"
   (un tercer caloventor, con CL-01 y CL-02 ya en el maestro) se marcaba como sospechoso de ser
   un tipeo de "CL01", cuando en realidad es sencillamente el equipo siguiente de la misma serie
   (mismo problema con "MT03"/"MT04"). Corregido excluyendo cualquier prefijo con equipos reales
   del chequeo. Con eso solo, aparecieron dos MÁS: "CA01" (11 cargas sostenidas, 1.345 L —
   consumo real de una caldera, no un tipeo aislado) y "LM02" se marcaban sospechosos de
   "CF01"/"BM02" porque CA y LM no tienen ningún equipo dado de alta todavía — pero SÍ son
   categorías reconocidas (`TIPO_POR_PREFIJO` las nombra). El filtro final exige que el prefijo
   sea desconocido en cualquier sentido, no solo "sin equipos en el maestro". Verificado: con el
   filtro final, de todos los huérfanos reales, únicamente GR01 queda señalado, sugiriendo
   correctamente GE01.

## 04/09/2026 — CA/LM en L/hora, Denominación en las tablas de movimientos, actividad estimada desde la tarjeta

1. **CA (CALDERA) y LM (LIMPIEZA) pasan a L/Hora** (`RULE_L_HORA` en analyzer.js). Decisión de
   negocio, confirmada con el usuario: consumen por tiempo de uso, no por distancia, igual que
   GE (GRUPO ELECTRÓGENO) — que tampoco tiene GPS y ya funciona por cálculo inverso. Antes
   quedaban sin ninguna regla de unidad, así que `PREFIJOS_CALCULABLES` (autocorreccion.js) los
   excluía del alta automática — no porque les faltara GPS, sino porque la app no sabía en qué
   unidad medirlos. Verificado: CA01, LM01 y LM02 pasan de "huérfano sin tocar" a "equipo nuevo
   dado de alta" (altas automáticas: 4 → 7).

2. **Denominación agregada a las tablas de movimientos** (Cargas, GPS, Entregas Loop) en Base de
   Datos — antes solo aparecía en Maestro y Consumo Real. Sale del maestro cuando el equipo
   existe (respeta lo editado a mano); si el código es huérfano, se cae al mismo
   prefijo-a-denominación que ya usa el resto de la app, así que un huérfano con forma de
   interno se lee igual de claro que uno dado de alta.

3. **Botón "Declarar km/horas estimados" directo en cada tarjeta**, no solo cuando lo dispara un
   hallazgo puntual (`sin_medicion`/`sin_gps_estimado`/`estimacion_inverosimil`). El mecanismo ya
   existía completo (`consumoDesdeActividadDeclarada`, store `actividadEstimada`, modal con rango
   min-máx por día hábil/mes/total, vista previa en vivo) — solo faltaba el acceso directo. Sirve
   para el caso "MT01: aproximadamente 2 hs/día" o "CL02: 6-9 hs/día" sin esperar a que la app
   levante un hallazgo primero.

**Confirmado, sin cambios**: "Consumo real" y "Cargas" en Base de Datos ya son la misma fuente —
`consumo_real` sale de `analizarFlota()` sobre las cargas reales de Cargas_Combustible, nunca de
un dato separado. El Maestro ya tenía las columnas Interno/Dominio/Denominación/Marca/Modelo/
Año/Potencia/Capacidad/Ubicación/Equipo asociado completas (verificado contra
`Equipos HSV SJ-MZA 2026.xlsx`: Marca vacía solo en 2 de 183 equipos, Año sin valores fuera de
rango 1972-2025, Modelo vacío en 8).

**Quedó pendiente, señalado como próximo paso**: diferenciar el cuerpo del email de reclamo GPS
por categoría (ralentí en camionetas vs. TR vs. otros) más allá de agrupar por el texto del
motivo (ya lo hace `mailtoReclamoConsolidado()`); y revisar qué otros pares de hallazgos
distintos podrían compartir una misma acción de resolución, más allá de huérfanos/alta que ya se
resuelve solo.

## 04/09/2026, segunda tanda — encabezados fieles al original, campo TIPO recuperado, Deshacer real

1. **Se deshace la fusión Interno+Dominio en una sola columna "Equipo"** (decisión de la ronda
   anterior, corregida a pedido del usuario: "deben ser todos iguales, al original"). Cargas,
   GPS y Entregas Loop en Base de Datos vuelven a mostrar **Interno** y **Dominio** como columnas
   separadas, más **Denominación** al lado (esa sí se mantiene — no está en el Excel original,
   pero no reemplaza nada, se agrega).

2. **Bug real encontrado: la columna TIPO de Cargas_Combustible existe en el Excel pero el
   parser nunca la extraía** — se perdía en el `datos` crudo sin quedar como campo propio.
   Verificado contra la planilla real: TIPO (BOMBAS/ARIDOS/PRODUCCION/MIXER/LABORATORIO/
   CEMENTO/TALLER/VENTAS/COMPRAS/GERENCIA/BOLSAS, + algunos nombres de sede) **no es la misma
   columna que SECTOR** — difieren en 927 de 4.412 filas (21%). Se agregó `tipo` como campo
   extraído en `handleCargas()` (xlsx-parser.js) y ambos ("Tipo" y "Sector") como columnas
   visibles en la tabla de Cargas. Ojo con cómo se extrajo: buscar por candidato fuzzy `'TIPO'`
   hubiera encontrado primero "TIPO DE COMBUSTIBLE" (la contiene como substring) — se lee la
   clave exacta del objeto en vez de usar el buscador difuso, para ese campo puntual.
   De paso se agregó **Grupo** (columna real de Resumen de Flota, tampoco se mostraba) a la
   tabla de GPS.

3. **"Deshacer" real para el diagnóstico automático** (`deshacerAccionAutomatica()` en
   autocorreccion.js), no solo un enlace a "andá y corregilo en otro lado" como la ronda
   anterior. Revierte el dato real (borra el equipo dado de alta, destilda el código de "así
   está bien", o vacía la meta alineada) y marca la fila de `accionesAutomaticas` como
   `deshecha: true` **sin borrarla** — si se borrara, el siguiente `renderPanel()` volvería a
   ver las mismas condiciones y aplicaría la misma acción de nuevo, y "Deshacer" no habría
   durado ni una recarga. `aplicarCorreccionesAutomaticas()` ahora recibe las acciones previas y
   salta cualquier código ya deshecho. Protección extra: si el equipo dado de alta ya se editó a
   mano después, o la meta ya no es la que puso la alineación automática, el deshacer NO
   sobrescribe ese trabajo posterior — solo marca la acción como deshecha y avisa por qué no
   tocó el dato. Verificado en vivo en el navegador: deshacer el alta de CL03 lo borró del
   maestro (190 → 189 equipos) y, tras un `renderPanel()` completo posterior, **no volvió a
   aparecer** — confirma que el "no reaplicar" funciona de punta a punta, no solo en el momento.

**Hallazgos de la revisión de "qué se escapa" pedida por el usuario** (verificados contra datos
reales, sin tocar código todavía):
- **"Equipo asociado"** en el Maestro es un campo editable que **no existe en el Excel original**
  (no está en el header real de `Equipos HSV SJ-MZA 2026.xlsx`) y **no lo lee ninguna lógica** —
  se puede escribir, pero hoy no hace nada. Si la idea es vincular equipos entre sí (ej. una
  bomba con su camión, un acoplado con su tractor), falta construir esa lógica; si no, es un
  campo fantasma que conviene sacar.
- **Chofer** solo se usa para identidad/duplicados — no hay ninguna vista de consumo por chofer,
  pese a haber 85 choferes distintos en las cargas reales. Es la palanca más accionable que
  queda sin explotar: el mismo equipo con dos choferes distintos consume distinto.
- **Precio por lugar de carga — corregido en la ronda siguiente (ver 04/09/2026, tercera
  tanda)**: la afirmación de esta línea ("GRIS/ARIDOS/TUNUYAN pagan ~6% más que San Martín") era
  incorrecta. Verificado contra las 4.412 cargas reales: **el precio por litro es fijo por
  combustible en toda la planilla, sin excepción** (ni varía por lugar ni por mes). La diferencia
  de ~6% medida en la primera auditoría no era un sobreprecio por lugar: era la mezcla de
  productos de cada sitio (GRIS compra más Quantium Diesel, que es más caro que YPF 500) — un
  efecto de mezcla, no de negociación. Ver el desglose real por lugar más abajo.
- Pendiente de la ronda anterior, todavía sin tocar: diferenciar el cuerpo del reclamo GPS por
  categoría más allá de agrupar por texto de motivo; unificar los botones de acción de los
  hallazgos con selección múltiple donde tenga sentido.

## 04/09/2026, tercera tanda — desglose por lugar de carga y chequeo de precio fuera de lista

El usuario confirmó a mano la clasificación de marca/lugar (ARIDOS y TUNUYAN cargan Infinia
Diesel por clima extremo; San Martín y Godoy Cruz cargan YPF 500; GRIS, EE SS Coronel Díaz y GNC
Godoy Cruz son estaciones de terceros bandera Axion con X10/Quantium Diesel/Quantium Nafta/Nafta
Super). Verificado contra las 4.412 cargas reales: **coincide exactamente** con lo que ya estaba
codificado en `getBandera()`/`tipoLugarCarga()` (normalizer.js) desde una ronda anterior — no
hubo que corregir la clasificación, solo faltaba una vista que la mostrara agrupada por lugar en
vez de solo por combustible.

1. **Nuevo desglose `totales.lugar_desglose`** (analyzer.js), igual que `combustible_desglose`
   pero agrupado por sitio físico en vez de por producto: litros, costo, precio promedio y qué
   combustible(s) usa cada uno. Accesible desde el KPI "Costo total" → "Desglose por lugar de
   carga". Verificado en vivo contra los datos reales: Godoy Cruz (sede) mezcla YPF 500 (mayoría)
   e Infinia Diesel (250 cargas, no es 100% YPF 500 puro como parecía a primera vista); Áridos y
   Tunuyán son 100% Infinia Diesel; San Martín 100% YPF 500; Altamira es un caso de una sola
   carga (201 L).
2. **Confirmado con datos reales, no supuesto**: el precio por litro de cada combustible es
   **fijo en toda la planilla** — mismo precio en los 9 meses, en los 8 lugares. Lo que hace
   parecer "más caro" a un lugar es la mezcla de productos que compra ahí, nunca una tarifa
   distinta para el mismo producto (esto corrige la lectura de la ronda anterior, ver arriba).
3. **Nuevo chequeo de calidad `precios_inconsistentes`** (diagnostico.js): como el precio es fijo
   por combustible, una carga futura con un precio distinto al del resto de ese mismo combustible
   es evidencia de error de tipeo — o el arranque real de un aumento, que hay que confirmar contra
   el comprobante. No corrige nada solo (a diferencia de las correcciones automáticas de
   autocorreccion.js): solo junta la evidencia para decidir a mano. Sobre los datos reales de hoy
   da 0 hallazgos (el precio nunca varía), que es lo esperado — queda como guardarraíz para la
   próxima carga de datos.

Verificado con el arnés (`node tools/verificar-datos-reales.mjs`: sigue OK contra
`invariantes.json`, 20 hallazgos sin cambios — el nuevo chequeo no dispara con los datos reales
de hoy) y en vivo en el navegador subiendo Cargas + Equipos + Consumos Estimados reales: el
desglose por lugar mostró los 8 lugares con los litros y combustibles correctos.

**Sigue pendiente**: diferenciar el cuerpo del reclamo GPS por categoría más allá de agrupar por
texto de motivo; unificar los botones de acción de los hallazgos con selección múltiple; decidir
qué hacer con el campo fantasma "Equipo asociado"; construir una vista de consumo por chofer.

## 04/09/2026, cuarta tanda — feedback de uso real sobre el diagnóstico en producción

Tanda grande de correcciones puntuales, todas motivadas por casos reales que el usuario vio
usando la app con los archivos de `ARCHIVOS/` (ver equipos concretos citados abajo).

1. **KPI "Sobre la meta" en 0 bloqueaba "Ajustar metas"**: `acciones` del KPI era `[]` entero
   cuando `sobre_meta === 0`, así que no había forma de llegar a "Ajustar sus metas" desde ahí
   aunque el usuario quisiera revisar/cargar metas sin que nadie estuviera excedido todavía.
   Ahora "Ajustar metas" siempre está disponible (abre con filtro "todos" en vez de "excedidos"
   cuando no hay nadie sobre la meta); "Ver estos equipos" y el zoom por equipo siguen
   condicionados a que haya al menos uno excedido. (`panel.js`)

2. **`<small>L</small>`/`<small>km</small>` se veían como texto literal al abrir el popover de
   cálculo de un KPI**: `calcpopover.js` escapaba `d.valor` con `esc()`, pero ese valor lo arma
   siempre la app (nunca texto libre de una planilla) y algunos KPI incluyen HTML intencional
   para el sufijo de unidad — el mismo patrón que `<strong>`/`<code>` en `diagnostico.js` y
   `modals.js`. Se dejó de escapar, igual que ya no se escapaba en la tarjeta del dashboard.

3. **"Vehículos con patente pero sin interno en el padrón" se leía como error fijo**: la
   severidad era `media` y el texto asumía que siempre son unidades propias que faltan dar de
   alta. En la práctica varios son vehículos ajenos (préstamo/alquiler/tercero) que jamás van a
   tener interno propio — no es un dato faltante. Bajada la severidad a `baja` (igual que el
   resto de "consumo fuera de la flota") y reescrito el texto para nombrar el caso real y guiar
   a "Así está bien" en vez de sonar a pendiente.

4. **"Así está bien" no admitía selección múltiple**: para huérfanos con patente, servicios de
   planta u "otros" solo se podía aceptar código por código. Se agregó el mismo patrón de
   checkbox + acción en bloque que ya usa ralentí (`btn-nofl-valido-lote`, reutiliza el checkbox
   `chk-ralenti-promedio`). Además, el hallazgo "código huérfano parece error de tipeo"
   (`huerfanos_typo`) ahora también acepta "Así está bien" — caso real: **ST01**, un interno dado
   de alta fuera de flota para imputar la limpieza/calibración del surtidor del lugar de carga,
   que el detector de tipeo señalaba como posible "ST0_" real sin forma de aceptarlo.

5. **Duplicados posibles no consideraban la hora**: la planilla de Cargas trae en varias filas
   reales la fracción de hora dentro de `FECHA` (verificado: **TR32** tiene dos cargas el mismo
   día a las 01:23 y a las 12:13, litros casi iguales, importe apenas distinto — claramente dos
   eventos reales, no una repetida). El parser no extraía esa hora y el chequeo de "posible
   repetida" no la usaba como campo de identidad. Se agregó `parseHoraDeFecha()`
   (normalizer.js, devuelve `''` si la fecha no trae fracción real) y se sumó `hora` a
   `CAMPOS_IDENTIDAD` en `auditarCalidadCargas()` — ahora aparece en "Difiere en" cuando las dos
   cargas tienen horarios bien distintos, reforzando que no es una repetida.

6. **"Declarar actividad estimada" en lote forzaba el mismo valor a todos los equipos**: al abrir
   el modal para varios equipos (ej. un grupo de 9), guardaba el mismo rango min–max para todos.
   Caso real: dentro de un grupo la mayoría trabaja 10-12 hs/día pero **GE04** trabaja 6. Se
   agregó una tabla "Por equipo" (solo cuando hay más de un equipo seleccionado) con un
   min/máximo opcional por fila que, si se completa, pisa el valor general SOLO para ese equipo;
   el resto de los campos (unidad, período, temporada, litros, nota) se siguen compartiendo.
   (`panel.js`)

7. **"Declarar km/horas estimados" faltaba en dos hallazgos**: `datos_parciales` (equipos con
   datos de solo una parte del período) solo ofrecía "revisar equipo por equipo", y `bajo_uso`
   (equipos con 1-3 cargas y sin ningún registro de GPS — caso real citado: **GE04**, 6 hs/día en
   vez del promedio del grupo) no tenía ninguna acción propuesta más que "Comparar estos
   equipos". Agregada la acción a los dos. (No confundir con `sin_gps_estimado`, un hallazgo
   distinto — "equipos sin GPS con actividad estimada que sí pasa el control de razonabilidad" —
   que ya la tenía y a propósito no necesita más acción: el usuario confirmó que ese caso está
   bien así, mejora solo con más datos con el tiempo.)

8. **"Cargas anómalas" sin forma de ver el registro**: el hallazgo de cargas muy por encima de lo
   habitual no tenía ningún botón por fila — no había manera de ir a la tabla a comparar contra
   el resto de las cargas del equipo. Agregado "Ver y comparar cargas" (mismo botón que ya usan
   los hallazgos de "consumo fuera de la flota").

9. **"sin_medicion" sin reclamo GPS**: un equipo que carga combustible pero el GPS no reporta ni
   un km ni una hora en todo el período es, en la práctica, el mismo tipo de problema que
   ralentí/ignición inconsistentes — un reclamo al proveedor de GPS con el dato en la mano.
   Sumado a `puedeReclamarGPS` (checkbox, botón por fila, "Reclamo GPS (selección)" y el listado
   de reclamos generados), con un motivo sugerido propio (`motivoReclamoGPS()`).

Syntax-check limpio en los 5 módulos tocados (`node --input-type=module --check`) y
`npm run verificar` corrido contra los archivos reales de `ARCHIVOS/` antes de commitear.

### No implementado en esta tanda (evaluado y descartado por alcance/riesgo, o pendiente de una decisión del usuario)

- **Sugerir un equipo par por marca/modelo/año/potencia cuando la estimación por cálculo inverso
  no es creíble** (caso citado: CM43 sin GPS, usar CM48 o similar como referencia — el mismo
  criterio que ya se aplicó a mano entre CF38 y CF37). Requiere una función nueva de selección de
  par (hoy `estimacionCreible()` compara contra la mediana del grupo por denominación, pero no
  ofrece un equipo concreto como sustituto) y verificación contra el maestro real de qué campos
  de marca/modelo/potencia están cargados y con qué calidad. Queda para una tanda propia.
- **Remitos de Loop que no coinciden entre sí**: llevar al registro en la tabla y generar un
  pedido de revisión a Loop (mismo patrón que el reclamo GPS). El hallazgo de inconsistencia ya
  existe; falta el botón de acción y la plantilla de reclamo hacia Loop. Pendiente.
- **Acciones extra en "correcciones que se aplicaron solas"**: agregar "eliminar registro" y
  "marcar como fuera de flota + ignorar automáticamente cuando el código no aparece en todos los
  archivos analizados", además del "Deshacer" que ya existe. La función de borrado
  (`deleteRawRecord`) ya existe y se usa en duplicados; falta decidir la regla exacta de "no
  aparece en todos los archivos" antes de automatizarla. Pendiente.
- ~~Cambiar el encabezado "Denominación" por "TIPO" en Base de Datos~~ — resuelto abajo, quinta
  tanda: lo que hacía falta no era renombrar la columna sino corregir el valor de TR.
- **"Faltan los Resumen de Flota de N meses que sí tienen cargas"**: el usuario aclaró que esto
  no es un bug — el período analizado es la intersección común a todos los archivos cargados por
  diseño (`alinearCargasYGps()`/`filtrarPorPeriodo()`, ver invariante 1 en `CLAUDE.md`). No se
  tocó código; se deja constancia acá para no volver a interpretarlo como dato faltante.

## 04/09/2026, quinta tanda — denominación de TR corregida contra la cédula real

El usuario aclaró la duda de la tanda anterior sobre "Denominación" vs "TIPO" trayendo la cédula
de identificación del automotor real de tres equipos. No pedía cambiar de columna: pedía corregir
el **valor** de la denominación canónica de TR, que estaba genérica.

10. **TR pasa de "TRACTOR" a "TRACTOR C/CABINA"** (`TIPO_POR_PREFIJO`, normalizer.js): la cédula
    real de un TR (Iveco AS490S44TT14) dice en el campo `Tipo` oficial "94-TRACTOR C/ CABINA
    DORMITORIO". Se adopta "TRACTOR C/CABINA" (sin el detalle de "dormitorio", que es
    equipamiento, no tipo de vehículo). Confirmado con el usuario que **MX no cambia**: su cédula
    (Scania P94CB) dice "58-CAMION HORMIGONERO", ya equivalente a "MIXER" (la denominación
    actual). Verificado con `npm run verificar` — sin cambios en los invariantes, porque ningún
    hallazgo ni cálculo compara contra el string "TRACTOR".
    **Corrección sobre esta misma entrada**: la nota anterior decía que "TRACTOR" a secas era un
    valor genérico incompleto. El usuario aclaró que no era eso — un TR es específicamente la
    cabeza tractora que se combina con un semirremolque (BA/TO/CR/SR: batea, tolva, carretón,
    semirremolque), que son los que efectivamente van remolcados y **no tienen motor ni tanque
    propio**. Eso ya está bien modelado: `RULE_NO_TANK = ['BA', 'CR', 'SR', 'TO']`
    (analyzer.js) los deja en `tipo_calculo: 'No Aplica'`, y sus denominaciones (BATEA, TOLVA,
    CARRETÓN, SEMIRREMOLQUE) ya eran específicas, no genéricas. El único ajuste real seguía
    siendo agregarle "C/CABINA" a TR para que coincida con el texto de la cédula — no se tocó
    nada de BA/TO/CR/SR porque ya estaban correctos.
