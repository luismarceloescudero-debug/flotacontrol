# Comandos para subir estos cambios al repo

Pegar en Claude Code (o en una terminal) parado en la carpeta del repo:

```bash
cd "C:\Users\Usuario\Desktop\ESCRITORIO\NO TOCAR\CONSUMO DE COMBUSTIBLE\flotacontrol-repo\repo"

git status
git diff --stat

git add index.html js/app.js js/ui/panel.js js/ui/datatable.js js/ui/seguimiento.js js/data/diagnostico.js styles/panel.css COMANDOS_PUSH.md

git commit -m "Diagnostico: causa probable de metas raras, chequeo de periodo fuera de servicio, estimaciones por calculo inverso no creibles, vista Seguimiento y consejos por hallazgo

- Ralenti: camionetas (CM) separadas del resto, con seleccion multiple para aceptar o reclamar GPS en bloque
- Nueva regla: cargas que superan los dias habiles del mes, con link a la tabla filtrada por ese periodo
- Fix: la cobertura del periodo se capaba en 100% y tapaba los casos de mas cargas que dias habiles
- Metas mal cargadas: se etiqueta la causa probable (unidad / fuera de servicio / lejos de pares / pocos datos) y se ordena por completitud de datos
- Nuevo hallazgo: estimaciones por calculo inverso que no resisten el control de razonabilidad (caso GE04)
- Nueva vista Seguimiento y modales de ayuda por hallazgo"

git push origin main
```

Si `git push` pide credenciales, se resuelve con el helper de credenciales de Windows
(`git config --global credential.helper manager-core`) o con un Personal Access Token de GitHub.
No dejar el token escrito en ningún archivo del repo.

## Verificación rápida antes de pushear

```bash
node --check js/data/diagnostico.js
node --check js/ui/panel.js
node --check js/ui/seguimiento.js
node --check js/app.js
node --check js/ui/datatable.js
```

## Probar la app en local (hace falta servidor: son módulos ES, con `file://` no funciona)

```bash
python -m http.server 8080
# abrir http://localhost:8080/index.html
```
