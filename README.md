# FlotaControl — Control de Consumo de Combustible

Aplicación web (HTML/CSS/JS vanilla, sin build step) para controlar y visualizar el
consumo de combustible de la flota de HSV Logística. Los datos se procesan y guardan
100% en el navegador (IndexedDB) — no hay backend propio de datos, salvo el proxy de IA
descripto más abajo.

> Para el historial de qué se diagnosticó y corrigió (y por qué), ver
> [`CORRECCIONES_APLICADAS.md`](./CORRECCIONES_APLICADAS.md).

## ✨ Características

- **Carga de datos**: arrastrá o seleccioná archivos Excel (.xlsx) de Equipos, Cargas de Combustible y GPS/Resumen de Flota.
- **Detección automática**: el sistema reconoce el tipo de cada archivo por sus columnas.
- **Dashboard interactivo**: stats generales y periodo auto-alineado entre Cargas y GPS.
- **Tarjetas de equipos**: vista en grilla con filtros por tipo y búsqueda, comparando consumo real vs. meta de fábrica.
- **Modal de análisis por equipo**: historial de cargas, cálculo inverso, comparación con la meta.
- **Asistente IA ("Antigravity")**: chat con Claude (Anthropic) con acceso real a los datos de la flota y research web.
- **Exportación**: a Excel desde las tablas de datos.

## 🚀 Uso local

**Importante**: `index.html` carga `js/app.js` como módulo ES6 (`<script type="module">`).
Los navegadores bloquean la carga de módulos vía `file://` por política CORS — **no
alcanza con abrir `index.html` con doble clic**, hace falta un servidor local:

```bash
npm install       # una vez
npm run dev       # sirve la app en http://localhost:8080
```

(o cualquier otro servidor estático: `python -m http.server 8080`, la extensión "Live
Server" de VS Code, etc.)

El chat con IA (`/api/chat`) **no** funciona en local sin backend — ver la sección de
IA más abajo.

1. Abrí `http://localhost:8080/index.html`.
2. Cargá los archivos Excel de tu flota.
3. Procesá los datos con el botón "🚀 Procesar y Analizar".
4. Explorá el Dashboard y las tarjetas de equipos.

## 📊 Archivos Excel esperados

- **Equipos**: `Equipos HSV*.xlsx` — lista de la flota (INTERNO, DOMINIO, MARCA, MODELO, TIPO).
- **Cargas de Combustible**: `Cargas_Combustible_*.xlsx` — historial diario (INTERNO-DOMINIO, FECHA, LITROS, CENTRO DE COSTO, LUGAR DE CARGA).
- **GPS / Resumen de Flota**: `Resumen de Flota*.xlsx` — reporte mensual (UNIDAD, Tiempo en ralentí, Tiempo en movimiento, Kilómetros recorridos).
- **Consumos Estimados**: `Consumos Estimados*.xlsx` — meta de fábrica por equipo (INTERNO, CONSUMO ESTIMADO).

## 🤖 Asistente IA (Claude vía backend propio)

El chat usa la API de Anthropic a través de una función serverless (`api/chat.js`), para
que la API key nunca quede expuesta en el navegador. Pensado para desplegar en Vercel:

1. `console.anthropic.com` → API Keys → generar una key.
2. En el proyecto de Vercel: Settings → Environment Variables → `ANTHROPIC_API_KEY`.
3. (Opcional) `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_WEB_SEARCHES` — ver `.env.example`.
4. Redesplegar.

El asistente tiene acceso real a toda la flota cargada (no solo a un resumen) vía
tool-use, y puede investigar en internet (precios de gasoil, normativa, etc.) vía la
tool `web_search` de Anthropic — esto último tiene costo aparte por búsqueda.

Esto **no** es tu suscripción de chat de claude.ai (Pro/Max): es la API de Anthropic,
facturada por uso.

## 📁 Estructura

```
index.html            Entrada de la app
js/
  app.js               Bootstrap, navegación
  data/                normalizer.js, database.js (IndexedDB), analyzer.js (reglas de negocio)
  parsers/              xlsx-parser.js
  ui/                    cards.js, dashboard.js, modals.js, upload.js, datatable.js, config.js
  ai/                    chat.js (cliente del asistente IA)
  export/                exporter.js
api/
  chat.js               Proxy serverless a la API de Anthropic (Vercel)
styles/                 main.css, upload.css, components.css
ARCHIVOS/               Excel de ejemplo/reales (gitignored)
```

## Licencia

Uso interno — HSV Logística
