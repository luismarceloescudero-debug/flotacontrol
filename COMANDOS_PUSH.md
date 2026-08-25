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
git commit -m "Base de Datos: Consumo Real, Ajustar metas en Maestro, unificar variantes y codigos nuevos de Mendoza"
git push origin main
```

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

Pasa a la versión 9 (store nuevo `prefijosNoFlota`, para los códigos nuevos de Mendoza dados de
alta desde el modal de revisión). Se actualiza sola al abrir la app; no hay que borrar nada.
