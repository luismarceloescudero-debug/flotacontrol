# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FlotaControl: a fleet fuel-consumption dashboard for HSV Logística. Runs 100% in the browser
(ES modules, no build step, no framework) — Excel files are parsed client-side and the data is
kept in IndexedDB, so nothing about the fleet leaves the user's machine except the summary sent
to the optional AI assistant. The only server-side piece is `api/chat.js`, a Vercel serverless
function that proxies the Anthropic API so the key never reaches the browser.

## Commands

There is no build, lint, or test tooling (`package.json` has empty `dependencies` and no
`scripts`). Development is:

```bash
python -m http.server 8080     # serve the app, then open http://localhost:8080
```

Opening `index.html` directly (`file://`) does **not** work — the browser blocks ES module
imports under CORS with no server.

To also exercise the AI assistant locally (needs the serverless function, not just a static
server):

```bash
vercel dev
```

Requires `ANTHROPIC_API_KEY` and `APP_SHARED_SECRET` (see `.env.example` and the comment block
at the top of `api/chat.js` — `APP_SHARED_SECRET` must exactly match `APP_SECRET_VALUE` in
`js/config/appSecret.js`, or `/api/chat` 401s every request including the app's own).

No automated tests exist in this repo.

## Architecture

### Data pipeline: 4 spreadsheets → one merged model

The app cross-references four independently-sourced Excel files by a normalized equipment key:

| File | Contributes | Join key |
|---|---|---|
| `Equipos HSV*.xlsx` | Fleet roster: interno, dominio, marca, modelo | `INTERNO` |
| `Cargas_Combustible_*.xlsx` | Liters, cost, location, cost center, driver | `INTERNO-DOMINIO` |
| `Resumen de Flota*.xlsx` (GPS) | Km driven, idle/moving hours | `UNIDAD` |
| `Consumos Estimados*.xlsx` | Target consumption **and its unit** (L/hora or L/100km) | `INTERNO` |

The four files disagree on how they write the same equipment code (`TR-21` vs `TR 21` vs
`TR21`, `CF1` vs `CF01`). `normalizeEquipoKey()` in `js/data/normalizer.js` is the single
source of truth for collapsing these into one key — every place that joins data across files
must go through it (or through `getCargasForEquipo`/`getGPSForEquipo` in `analyzer.js`, which
already do). Comparing raw string equality instead of the normalized key is a recurring bug
class in this codebase's history (see `CORRECCIONES_APLICADAS.md`).

Whether an equipment's consumption is measured in **L/hora** or **L/100km** is decided by the
unit declared in "Consumos Estimados" (the area's source of truth), with a prefix-based
fallback (`determineConsumptionType()` in `analyzer.js`) when no target is loaded. It can be
overridden by hand from the equipment card.

The `TIPO` column in the Equipos spreadsheet is not trustworthy (tractors are labeled
"CAMION"). Canonical denomination is derived from the `interno` prefix instead
(`getDenominacion()` in `normalizer.js`, prefix table also documented in `README.md`).

### Pipeline stages (read in this order to trace a bug)

1. `js/parsers/xlsx-parser.js` — detects which of the 4 file types was uploaded and extracts
   rows. Handles Excel's fraction-of-day hour encoding, several date formats, and columns
   that repeat (e.g. `TIPO` appears twice in the Equipos sheet — auto-renamed to `TIPO_2`).
2. `js/data/normalizer.js` — key normalization, denomination lookup, duration/meta parsing.
3. `js/data/database.js` — IndexedDB wrapper. Two conceptually different stores:
   - `equipos` (the "maestro"): one row per equipment, **persists across sessions**, merges
     non-destructively on reimport (a new upload only overwrites fields it actually carries a
     value for, and never overwrites a field the user already hand-edited —
     `editado_manual` tracks which fields are protected).
   - `raw_records` (the "movimientos" — cargas, GPS, etc.): **cleared automatically on every
     page load** (`clearMovimientos()` called from `app.js`'s `DOMContentLoaded`), because
     reprocessing without clearing would double-count liters/km/hours. This means a browser
     refresh mid-session requires re-uploading Cargas + GPS (the UI tracks which files were
     already processed and prompts for exactly the missing ones).
   Several other stores hold user corrections that survive reimports by keying off a stable
   "fingerprint" of a record (`huellaCarga()`: date+liters+importe+original-interno) rather
   than its assigned equipment — so correcting a mis-assigned charge doesn't lose the
   correction the next time that file is re-uploaded.
4. `js/data/analyzer.js` — core business rules: period alignment between Cargas and GPS
   (`calculateAlignedPeriod`), metric calculation (`calculateMetrics`), consumption-type
   resolution, fleet-wide KPI aggregation.
5. `js/data/diagnostico.js` (~2000 lines) — the automatic diagnostic engine. Runs ~20 rule
   functions (`detectarXxx`) over the analyzed fleet and produces a `hallazgos` (findings)
   array consumed by the Panel view. Each finding has a `titulo` (escaped on render) and a
   `detalle` (**rendered as raw HTML in `panel.js`, on purpose**, so findings can wrap numbers
   in `<strong>`). Any free-text value taken from an uploaded spreadsheet (combustible name,
   centro de costo, chofer, etc.) that gets concatenated into `detalle` **must** be passed
   through this file's local `esc()` first — the literal `<strong>` tags in the template stay
   unescaped, only the interpolated data does. This is the one recurring foot-gun in this file;
   grep for `detalle:` when adding a new finding and check what you're interpolating.
6. `js/ui/panel.js` (~4400 lines, the largest file) — the unified Panel: fleet KPIs, editable
   equipment cards, the diagnostic list, filters, period selection, meta-adjustment and
   equipment-comparison modals. `js/ui/datatable.js` (~2000 lines) is the separate
   spreadsheet-like editor/viewer for raw tables (Base de Datos view).

### Three invariants that keep the numbers honest

These were added after an audit found each one being violated somewhere. They're easy to break
again by accident, so check them when touching consumption math:

1. **Same period on both sides of a ratio.** A consumption rate divides liters by activity, so
   both must come from the same months. `alinearCargasYGps()` (analyzer.js) intersects each
   equipment's charge-months with its GPS-months and the rate is computed from that subset
   only (`litros_alineados` / `km_alineados` / `horas_alineadas`). The full-period totals
   (`total_litros`, `total_km`, `total_horas`) stay untouched — they're real spend/activity and
   feed fleet KPIs. A GPS report spanning months the charges don't cover is dropped rather than
   prorated (prorating would invent km nobody measured). The same "all its months or none" rule
   applies in `filtrarPorPeriodo()`, because a multi-month report like "Resumen de Flota
   Ene-Jul" cannot be attributed to a single selected month.

2. **One definition per concept.** Coverage lives only in `coberturaEquipo()` (distinct days
   with a charge ÷ business days of the analyzed period) and is used by the card, the detail
   modal, Seguimiento and the meta-adjustment gate. `mediana()` is exported from diagnostico.js
   and imported where needed. Both existed twice with different formulas and the same label,
   producing two different numbers for the same equipment.

3. **A low number needs its context before it's a conclusion.** `utilizacion()` compares hours
   per business day against `JORNADA_REFERENCIA` (analyzer.js: 10-12 h for áridos and mixers,
   from operations, not from the data). Without it, an equipment that barely worked looks
   identical to an efficient one, and normalizing its meta against that period bakes in the
   idle months. Equipment that doesn't follow a work day (generators, heaters, compressors,
   pumps) is excluded — hours/business-day is meaningless for them and produced >24 h/day.

Consumption is exposed in **both** units (`consumo_l_hora` and `consumo_l_100km`) whenever both
denominators exist; `consumo_real` is the one in the equipment's declared unit. Both are shown
together because operations that mix long distances with on-site idling (Tunuyán) need both.

### Duplicates are dropped at import, not reported afterwards

`insertRawRecords()` marks any charge or GPS row identical to one already stored
(`claveCargaExacta()` / `claveGpsExacta()` in normalizer.js) with `_dupe_exacta`, and
`registroExcluido()` keeps those out of the analysis. Rows are kept in IndexedDB and stay
visible in Base de Datos — nothing is deleted. This is what makes it safe to re-upload a file,
or to keep adding new months without clearing movements first.

### XSS convention

There is no shared escaping module — `const esc = (s) => ...` (escapes `&<>"`) is duplicated
verbatim at the top of every UI file that builds `innerHTML` from dynamic data (`panel.js`,
`datatable.js`, `modals.js`, `comparativa.js`, `metas.js`, `seguimiento.js`, `upload.js`,
`calcpopover.js`, and `diagnostico.js`). When adding a new file that renders spreadsheet-derived
text into the DOM, copy that same helper rather than inventing a new one, and escape at the
point where untrusted text is interpolated — not the whole template, since several places
intentionally mix literal `<strong>`/`<code>` tags with escaped data (see `diagnostico.js`
above, and `calcpopover.js`/`modals.js` for the "Datos tomados de" source-file list pattern:
`d.fuentes.map(f => \`<code>${esc(f)}</code>\`)`).

### AI assistant (`js/ai/chat.js` + `api/chat.js`)

Client never holds the Anthropic API key. `js/ai/chat.js` posts to `/api/chat` (same-origin,
no CORS needed — `api/chat.js` deliberately sends no `Access-Control-Allow-Origin` header) with
an `X-App-Secret` header checked via `crypto.timingSafeEqual` against `APP_SHARED_SECRET`; this
is anti-scraping, not real user auth (the shared value ships in the browser JS, documented as
such in `js/config/appSecret.js`). The backend exposes two tools to Claude: `get_equipo_detalle`
(resolved client-side against the local IndexedDB — the backend has no access to fleet data,
only the client does) and Anthropic's native `web_search`. `MAX_TOOL_ROUNDS` /
`MAX_TOKENS` caps exist because multi-equipment requests ("investigate and adjust 10 targets")
need one tool round-trip per equipment and can otherwise cut off before producing a final answer
— if you see reports of "the assistant didn't return a response," check `stopReason` handling
in `chat.js` before assuming the model is broken.

### IndexedDB schema changes

`database.js` uses a single incrementing `DB_VERSION` with a `onupgradeneeded` that only ever
**adds** object stores — there is no data-migration path for renaming/transforming an existing
field. Each version bump has an inline comment explaining what it added and why; keep that
convention when adding a new store.

### Historical docs — do not follow as current instructions

`.agent.md`, `.instructions.md`, `.prompt.md`, `PLAN_ROO_CODE.md`, `ROO_CODE_SETUP.md`,
`DIAGNOSTICO_NORMALIZACION.md`, and `RESUMEN_EJECUTIVO.md` document a prior repair attempt
(via Roo Code) and describe several things as "still to fix" that are already fixed.
**`CORRECCIONES_APLICADAS.md` is the up-to-date changelog and source of truth** for what's
actually been done and what's genuinely still pending — read it before assuming a documented
problem is real, and add to it (rather than the older docs) when you fix something non-trivial.

## Deployment

Vercel, connected to this GitHub repo (Git integration — pushing to `main` deploys
automatically, no `vercel.json` needed). GitHub Pages will not work: it can't run `api/chat.js`.
Required env vars in Vercel: `ANTHROPIC_API_KEY`, `APP_SHARED_SECRET`; optional:
`ANTHROPIC_MODEL`, `ANTHROPIC_MAX_WEB_SEARCHES`.
