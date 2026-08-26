# Comandos para subir cambios al repo (PowerShell en Windows)

> **Importante:** estos comandos son para **PowerShell**. Un `git commit -m` con el mensaje
> partido en varias líneas deja la consola colgada en el prompt `>>` esperando la comilla de
> cierre. Por eso acá el mensaje va siempre en **una sola línea**, o en varios `-m` seguidos.
> Si alguna vez quedás atrapado en `>>`, salí con **Ctrl+C**.

## 1. Ver qué cambió

```powershell
cd "C:\Users\Usuario\Desktop\ESCRITORIO\NO TOCAR\CONSUMO DE COMBUSTIBLE\flotacontrol-repo\repo"
git status
git diff --stat
```

## 2. Preparar y commitear

```powershell
git add -A
git commit -m "Duplicados exactos que se corrigen solos, y actividad declarada por dia habil o por mes con litros estimados"
git push origin main
```

(Los commits anteriores de esta lista ya se hicieron — no hace falta repetirlos.)

`git add -A` toma todos los archivos modificados sin tener que listarlos uno por uno (así no
falla si alguno de la lista no cambió).

## 3. Si querés el detalle en el cuerpo del commit

Cada `-m` es un párrafo. Todo en una sola línea de consola, sin saltos:

```powershell
git commit -m "Auditoria de calidad del dato de cargas" -m "Nuevo hallazgo meses_sin_gps: detecta meses con cargas y sin Resumen de Flota subido. Con los datos reales son julio y agosto: 736 cargas (18%), 113.312 L y 253 millones sin poder controlar. Explica de una la mayoria de los sin dato de actividad, periodos desalineados y cobertura baja." -m "Nuevo hallazgo cargas_sin_valorizar: cargas con precio unitario o costo total en cero. Son 38 filas y 5.196 L: todos los importes de la app estaban subestimados en eso." -m "Nuevo hallazgo calidad_planilla: mismo combustible escrito de dos formas (YPF 500 / YPF500) y filas repetidas (mismo equipo, fecha y litros)." -m "FIX: la regla comparaba cantidad de cargas contra dias habiles. Cargar dos veces el mismo dia es normal y las cargas de sabado, domingo o feriado son legitimas. Ahora compara dias distintos con carga descontando los no habiles." -m "Nuevo modal Como lo resuelvo: un veredicto por equipo con la accion que le corresponde, sobre todos los equipos del hallazgo." -m "Correccion masiva real: Aplicar lo sugerido le aplica a cada equipo SU accion, no la misma a todos." -m "Registros en cero descartados del analisis; siguen visibles en la tabla." -m "Nuevo hallazgo datos parciales, con pantalla para decidir equipo por equipo." -m "Correcciones de cargas: interno opcional, alta de internos nuevos como equipo fuera de flota, centro de costo propuesto desde lugar o sector." -m "Base de Datos: el filtro de anio/mes ya no esconde las filas de planillas sin fecha; los archivos con nombre opaco ya no titulan la pestana con un hash." -m "Estilo: botones chicos unificados en diagnostico, Seguimiento y modales."
```

### Detalle de esta tanda (Base de Datos: Consumo Real, Ajustar metas, normalización reforzada)

```powershell
git commit -m "Base de Datos - Maestro: nuevas columnas Consumo real, Cargas y vs Meta calculadas en vivo desde el ultimo analisis; ya no hace falta ir a Seguimiento para verlas." -m "Ajustar metas ahora disponible desde Base de Datos (Maestro y Consumo Real), no solo desde Seguimiento." -m "Nueva pestana Consumo Real en Base de Datos: misma logica de normalizacion que Consumos Estimados pero con litros medidos, cantidad de cargas, confiabilidad y comparacion contra la meta actual, para investigar metas fila por fila." -m "Nueva accion Unificar variantes en el hallazgo de calidad de planilla: detecta combustible, lugar de carga, centro de costo y chofer escritos con espacios, guiones o mayusculas distintas, y ofrece un modal para elegir la forma correcta equipo por equipo. Nunca corrige solo: cada fila se aplica o se deja como esta a criterio del usuario." -m "Nuevo hallazgo Codigos nuevos de Mendoza: cuando aparece un prefijo de interno que no esta en la base oficial (CL03, CA, LM, MT03, MT04, etc) lo agrupa, muestra litros/costo/centro de costo y ofrece darlo de alta con su denominacion. Restringido a Mendoza a proposito, verificado contra el centro de costo real de cada carga." -m "Se agregaron CA (CALDERA) y LM (LIMPIEZA) a los prefijos oficiales conocidos." -m "FIX de normalizacion: la deteccion de consumo fuera de flota y de codigos nuevos comparaba el interno crudo contra cargas indexadas por interno normalizado, y con codigos con cero adelante (CL03, GR01, etc) nunca encontraba sus cargas reales; el costo y centro de costo daban vacios. Ahora normaliza antes de buscar, en los dos lugares." -m "Investigacion profunda: el modal de investigar una meta ahora tiene un boton para mandar el equipo (marca, modelo, potencia, consumo real) directo al Asistente de Flota, que ya busca en fuentes web reales por su herramienta nativa de busqueda."
```

### Detalle de esta tanda (Consumos Estimados con el real, Confiabilidad partida, estimado por grupo, seguimiento)

```powershell
git commit -m "Consumos Estimados: se agregaron las columnas Consumo real y vs real (lo medido en el periodo vigente del Panel), que antes solo estaban en Maestro. Encabezados renombrados a Estimado (planilla) y Meta actual (maestro) para que quede claro que son dos valores distintos a proposito." -m "Consumo Real: la columna Confiabilidad se partio en Confiable (Si/No) y Cobertura (la proporcion exacta, ej. 42/120 dias habiles = 35%), con el umbral explicado en el tooltip del encabezado." -m "Estimado por grupo: cuando un equipo tiene pocas cargas propias (ej. CM30 con 1 carga/mes) pero hay pares comparables confiables por marca+modelo o denominacion, se muestra la mediana de esos pares al lado del consumo medido, en vez de dejarlo en 0." -m "Marcar para seguimiento: nuevo boton por equipo y accion masiva por grupo en Consumo Real. Anota el motivo de la poca base (fuera de servicio, cambio de sucursal, baja de produccion, carga fuera de la empresa) sin excluir al equipo del analisis. No lo vuelve confiable por si solo: la cobertura real sigue siendo la que manda." -m "Acciones masivas en Consumo Real: seleccionar por filtro de denominacion + Todos permite marcar/quitar seguimiento o adoptar el estimado por grupo como meta a un grupo entero de una." -m "FIX: el selector de accion masiva quedaba con las opciones de la ultima pestana visitada (Cargas o Consumo Real) al volver a Maestro/Estimados. Ahora cada pestana restaura sus propias opciones." -m "DB version 10: nuevo store seguimientoEquipos."
```

### Detalle de esta tanda (Ralentí consolidado, reclamo GPS en GPS vs Ignición, Estado del equipo)

```powershell
git commit -m "Ralenti (inverosimil, camionetas, general): se sacaron los botones Como lo resuelvo, Ignorar e Ignorar todos de estas tarjetas. Marcar aceptable y Reclamo GPS (por fila y en seleccion) ya eran las dos resoluciones reales; ahora son los unicos botones, renombrados Investigar y marcar aceptable / Investigar y reclamar GPS." -m "GPS vs Ignicion: ahora tiene boton de reclamo GPS por fila (antes solo existia el de seleccion en bloque), y boton Reclamos GPS para ver los generados. El texto del hallazgo nombra las fuentes explicitamente: Informe de Ignicion (Loop, via API de Wara) y Resumen de Flota (Wara, directo) - antes decia 'el Informe de Ignicion' y 'el Resumen de Flota' sin aclarar el origen. El reclamo por mail ya citaba las fuentes correctamente desde antes; esto corrige el texto que se ve en la tarjeta." -m "Nuevo boton Estado por equipo en las tarjetas de ralenti, GPS vs ignicion, sin actividad y estimacion no creible: anota Fuera de servicio, Taller externo, Taller interno, Temporada baja, Sin chofer asignado, Backup o motivo libre, sin excluir al equipo del analisis. Reutiliza el store seguimientoEquipos (el mismo de Marcar para seguimiento en Consumo Real) para no duplicar el mecanismo. Queda visible como insignia en la fila una vez guardado."
```

### Detalle de esta tanda (fuera de flota, actividad declarada, cadencia, normalizaciones)

```powershell
git commit -m "FIX del bug de fondo: asignar un interno a una carga escribia el interno en el registro pero no creaba la ficha en el maestro, y como el analisis resuelve cada registro contra el maestro, el codigo seguia contando como huerfano por mas veces que se lo asignara. Eso era el no se normaliza aunque asignemos interno." -m "Nueva alta de codigos huerfanos como equipo FUERA DE FLOTA (prestamo/alquiler tipo DEMO SCANIA, herramienta, servicio de planta): crea la ficha de verdad con las dos claves (interno y dominio) cuando el huerfano trae las dos, con centro de costo propuesto desde sus propias cargas y vigencia opcional. Dejan de figurar como codigo sin padron, salen de los hallazgos de consumo (no tienen ni pueden tener meta) y su gasto se reporta aparte agrupado por centro de costo. Verificado: los huerfanos bajaron de 15 a 14 y el equipo conservo sus 9 cargas, 1.087 L y 2.608.800 imputados a PTY." -m "Nueva actividad declarada a mano (km u horas) por equipo, por grupo y por mes, con rango minimo-maximo y temporada normal/baja/alta. Es el calculo inverso para los equipos que no reportan GPS: los litros ya estan, faltaba contra que dividirlos. Verificado con CM30: 71,64 L / 800 km x 100 = 8,96 L/100km." -m "FIX: un equipo con cargas y 0 km / 0 hs de GPS mostraba 0,00 L/100km, que no es consumo cero sino ausencia de dato haciendose pasar por medicion, y ademas daba un -100% contra la meta. Ahora dice sin medir en Consumo Real y en Consumos Estimados, y ofrece el estimado por actividad declarada o por grupo." -m "Nueva cadencia de cargas: un equipo que carga una vez por mes todos los meses tiene 5% de cobertura sobre dias habiles y sin embargo su patron es estable. La cadencia manda sobre el porcentaje cuando el ritmo es regular (cargo en al menos 3 meses y en 75% de los meses del periodo)." -m "Nuevo bloque de normalizaciones ya aplicadas, con el conteo real sobre los archivos y la funcion que lo hace: interno y dominio separados de una celda, espacios/guiones/ceros a la izquierda, mayusculas y acentos, horas de Excel a decimal, fechas, numeros, registros en cero apartados, denominacion por prefijo y correcciones que sobreviven a la reimportacion. Aclara que lo que se detecta pero no se corrige solo sigue como hallazgo pendiente." -m "FIX en parseNumber: un decimal con punto se rompia. 9.5 daba 95, un error de diez veces silencioso en litros, importes o precios. Ahora el punto se interpreta por la forma del numero. Solo afectaba valores que llegan como texto." -m "FIX en parseDuration: 07:30 devolvia 7 y se perdian los minutos. Ahora soporta HH:MM ademas de HH:MM:SS." -m "DB version 11: nuevo store actividadEstimada."
```

### Detalle de esta tanda (duplicados exactos y declaracion por dia/mes)

```powershell
git commit -m "Duplicados: se separan en EXACTOS (coinciden equipo, fecha, litros, importe, precio, combustible, lugar, centro de costo y chofer) y POSIBLES (coinciden equipo, fecha y litros pero difiere algun otro campo). Los exactos ya no son una decision: dos cargas reales del mismo equipo el mismo dia no coinciden hasta el centavo, asi que se corrigen con un boton, conservando una de cada par. Los posibles se listan con el campo que difiere y se deciden a mano." -m "IMPORTANTE: la correccion de duplicados NO usa la accion eliminar. Las dos filas de un duplicado exacto tienen la MISMA huella, asi que un eliminar habria salteado las dos al reimportar y se habria perdido tambien la carga buena. Se agrego la accion dedupe, que conserva las primeras N apariciones de esa huella y descarta las copias. Verificado con los datos reales: 3 duplicados exactos (271 L, 641.300), las cargas pasaron de 4270 a 4267, y tras reimportar siguen 4267." -m "Actividad declarada: nuevo selector de base. Se puede declarar POR DIA HABIL (ej. trabaja 10 a 12 hs por dia), POR MES (ej. carga 1 vez por mes unos 70 L) o el total del periodo. La app multiplica por los dias habiles o los meses que correspondan; declarar el total de un semestre de memoria no es realista." -m "Nuevo campo de LITROS declarados: para el equipo que carga fuera de la empresa y cuyo ticket no entra a la planilla. Los litros registrados subestiman el consumo real; si se declara el promedio, se usa ese para el calculo y se muestran los dos numeros, nunca se pisa el registrado en silencio. Caso CM30 verificado: 71,64 L/mes por 6 meses = 429,8 L estimados contra 71,6 registrados, sobre 4.800 km declarados = 8,96 L/100km contra su meta de 8,50." -m "FIX: la columna vs Meta comparaba contra el consumo real 0 de un equipo sin actividad medida y daba -100%, contradiciendo al estimado que se mostraba al lado. Ahora compara contra el estimado declarado y lo marca como est., o dice sin base cuando no hay con que comparar." -m "La vista previa del formulario corre exactamente el mismo calculo que despues se guarda, no una formula paralela, y avisa cuando el resultado se aparta mas de 50% de la meta."
```

## Sobre las advertencias de CRLF

```
warning: in the working copy of '...', LF will be replaced by CRLF
```

Son normales en Windows y **no rompen nada**: git guarda los archivos con finales de línea Unix
y los escribe en tu disco con finales de línea Windows. Se pueden silenciar con:

```powershell
git config --global core.autocrlf true
```

## Verificación antes de pushear (opcional)

```powershell
node --check js/data/diagnostico.js
node --check js/data/analyzer.js
node --check js/data/database.js
node --check js/parsers/xlsx-parser.js
node --check js/ui/panel.js
node --check js/ui/datatable.js
node --check js/ui/seguimiento.js
node --check js/app.js
```

## Probar en local

Son módulos ES: abrir el `index.html` con doble click **no funciona**, hace falta un servidor.

```powershell
python -m http.server 8080
# abrir http://localhost:8080/index.html
```

## Nota sobre la base local del navegador

Pasa a la versión 11 (store nuevo `actividadEstimada`, para los km u horas declarados a mano;
la v10 había agregado `seguimientoEquipos` y la v9 `prefijosNoFlota`). Se actualiza sola al
abrir la app; no hay que borrar nada.
