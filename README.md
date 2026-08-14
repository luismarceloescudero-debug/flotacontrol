# FlotaControl — Control de Consumo de Combustible

Aplicación web para controlar y analizar el consumo de combustible de la flota (HSV Logística).
Corre 100% en el navegador: los archivos Excel se procesan localmente y los datos quedan
guardados en IndexedDB (el almacenamiento del propio navegador). Nada de la flota se sube a
ningún servidor, salvo el resumen que se le pasa al asistente de IA si se lo usa.

## Cómo funciona

Se cargan cuatro planillas y la app las cruza entre sí:

| Planilla | Aporta | Clave de cruce |
|---|---|---|
| `Equipos HSV*.xlsx` | Padrón: interno, dominio, marca, modelo | `INTERNO` |
| `Cargas_Combustible_*.xlsx` | Litros, costo, lugar, centro de costo, chofer | `INTERNO-DOMINIO` |
| `Resumen de Flota*.xlsx` (GPS) | Km recorridos, horas de ralentí y de movimiento | `UNIDAD` |
| `Consumos Estimados*.xlsx` | Meta de consumo **y su unidad** (L/hora o L/100km) | `INTERNO` |

El cruce se hace por una **clave normalizada** del interno: `TR-21`, `TR 21` y `TR21` se
tratan como el mismo equipo.

### Cómo se decide L/Hora vs L/100Km

Por la **unidad declarada en Consumos Estimados**, que es la fuente de verdad del área
(ej. `8 L/hora` → se mide por hora; `9,5 L/100km` → se mide por distancia).
Si un equipo no tiene meta cargada, se cae a una regla por prefijo de interno.
Se puede sobrescribir a mano desde la tarjeta del equipo.

### Denominaciones

La columna `TIPO` del Excel de Equipos tiene valores inconsistentes (los TR figuran como
"CAMION" siendo tractores). La app usa una denominación canónica según el prefijo del interno:

`AE` Autoelevador · `AU` Automóvil · `BA` Batea · `BM` Bomba · `CF` Cargadora frontal ·
`CH` Camión hidrogrúa · `CL` Caloventor · `CM` Camioneta · `CR` Carretón · `EX` Excavadora ·
`FG` Furgón · `GE` Grupo electrógeno · `MC` Minicargadora · `MH` Productora de hielo ·
`MS` Semi mixer · `MT` Motocompresor · `MX` Mixer · `RE` Retrocargadora · `SR` Semirremolque ·
`TO` Tolva · `TP` Topador · `TR` Tractor · `VL` Volcador

## Uso

1. Abrir la app (ver *Desarrollo local* o la URL desplegada).
2. Ir a **Carga de Datos**, arrastrar las cuatro planillas (se pueden subir varios
   "Resumen de Flota" para abarcar más meses).
3. **Procesar y Analizar** → la app salta al **Panel de Flota**.

En el panel están juntos los indicadores globales y las tarjetas por equipo, con filtros por
denominación, estado y orden. Cada tarjeta es editable (denominación, meta y unidad) y abre un
detalle con el desglose del cálculo, las últimas cargas y la actividad GPS.

**Re-analizar** (arriba a la derecha) borra los datos guardados en el navegador y deja todo
listo para reprocesar. Es necesario cuando quedaron datos de una versión anterior de la app,
porque reprocesar sin limpiar duplicaría litros, km y horas.

## Desarrollo local

`index.html` carga los módulos como ES modules, así que **no funciona abriéndolo con doble
clic** (`file://`): el navegador bloquea los módulos por CORS. Hay que servirlo por HTTP:

```bash
python -m http.server 8080     # y abrir http://localhost:8080
```

El asistente de IA necesita además el backend (`/api/chat`), que no corre con un servidor
estático. Para probarlo localmente hace falta `vercel dev`.

## Asistente de IA

Usa Claude a través de una función serverless en `api/chat.js`. La API key vive únicamente
en la variable de entorno `ANTHROPIC_API_KEY` del hosting, nunca en el código del navegador.
Ver `.env.example`.

El asistente tiene acceso real a: el resumen de la flota, el detalle de cualquier equipo bajo
demanda (tool `get_equipo_detalle`) y búsqueda web (tool `web_search` de Anthropic, con costo
aparte por búsqueda).

## Despliegue

Vercel, conectado al repo. GitHub Pages **no** sirve porque no puede ejecutar `api/chat.js`.
Variables de entorno necesarias: `ANTHROPIC_API_KEY` (obligatoria),
`ANTHROPIC_MODEL` y `ANTHROPIC_MAX_WEB_SEARCHES` (opcionales).

## Estructura

```
index.html              Página única (Carga de Datos + Panel de Flota)
xlsx.full.min.js        SheetJS, servido localmente (no desde CDN)
api/chat.js             Backend del asistente (función serverless)
js/app.js               Arranque, navegación, botón Re-analizar
js/data/normalizer.js   Normalización, denominaciones, parseo de horas y metas
js/data/analyzer.js     Reglas de negocio y análisis de toda la flota
js/data/database.js     IndexedDB
js/parsers/             Detección de formato y extracción de cada planilla
js/ui/panel.js          Panel unificado (KPIs + tarjetas editables)
js/ui/datatable.js      Visor/editor de tablas
js/ui/modals.js         Detalle por equipo
js/ai/chat.js           Cliente del asistente
```

## Licencia

Uso interno — HSV Logística.
