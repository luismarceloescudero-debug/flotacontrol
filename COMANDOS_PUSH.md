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
git commit -m "Diagnostico accionable: veredicto y accion por equipo, correccion masiva real, y fix de la regla de cargas vs dias habiles"
git push origin main
```

`git add -A` toma todos los archivos modificados sin tener que listarlos uno por uno (así no
falla si alguno de la lista no cambió).

## 3. Si querés el detalle en el cuerpo del commit

Cada `-m` es un párrafo. Todo en una sola línea de consola, sin saltos:

```powershell
git commit -m "Diagnostico accionable y fix de la regla de cargas vs dias habiles" -m "FIX: la regla comparaba cantidad de cargas contra dias habiles. Cargar dos veces el mismo dia es normal y las cargas de sabado, domingo o feriado son legitimas. Ahora compara dias distintos con carga descontando los no habiles." -m "Nuevo modal Como lo resuelvo: un veredicto por equipo con la accion que le corresponde, sobre todos los equipos del hallazgo." -m "Correccion masiva real: Aplicar lo sugerido le aplica a cada equipo SU accion, no la misma a todos." -m "Registros en cero descartados del analisis; siguen visibles en la tabla." -m "Nuevo hallazgo datos parciales, con pantalla para decidir equipo por equipo." -m "Correcciones de cargas: interno opcional, alta de internos nuevos como equipo fuera de flota, centro de costo propuesto desde lugar o sector." -m "Base de Datos: el filtro de anio/mes ya no esconde las filas de planillas sin fecha; los archivos con nombre opaco ya no titulan la pestana con un hash." -m "Estilo: botones chicos unificados en diagnostico, Seguimiento y modales."
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

Pasa a la versión 8 (store nuevo `equiposExcluidos`). Se actualiza sola al abrir la app; no hay
que borrar nada.
