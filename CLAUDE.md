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

### Verifying a change (there is no test suite, so this is the substitute)

Syntax-check an edited module without a bundler:

```bash
node --input-type=module --check < js/data/analyzer.js
```

Real spreadsheets to test against live **outside the repo**, in `../../ARCHIVOS/` (the folder
next to `flotacontrol-repo/`): the four core files, the three Loop logistics files, and several
monthly `Resumen de Flota` plus a consolidated one. They are gitignored by pattern
(`Cargas_Combustible_*.xlsx`, `Equipos HSV*.xlsx`, `Resumen de Flota*.xlsx`,
`Consumos Estimados*.xlsx`, `Informe Entregas Loop*.xlsx`, `Exportado informe de Viajes*.xlsx`,
`Informe Volumen entregado*.xlsx`) so they can be copied into the served directory temporarily
without any risk of committing fleet data — but delete the copy when done.

Anything touching consumption math must be verified against those files, not reasoned about:
a wrong formula still runs and still prints a plausible number.

**`node tools/verificar-datos-reales.mjs`** (`npm run verificar`) is the automated way to do
that. It does not reimplement parsing or analysis — it runs the real pipeline
(`xlsx-parser.js` → `database.js` → `analyzer.js` → `diagnostico.js`) against the real files in
`ARCHIVOS/`, with `fake-indexeddb` standing in for the browser's IndexedDB (Node has none), and
compares the result against `tools/invariantes.json`. `npm run verificar:actualizar` rewrites
that file when a number changed on purpose. Run it **before** committing anything that touches
`js/data/` or `js/parsers/` — the hook pushes on commit, there is no staging step to catch a
regression later. This harness is what caught a real bug on its first run: a race condition in
`insertEntregasLoop()` (see `CORRECCIONES_APLICADAS.md`, 03/09/2026) that silently dropped 43%
of the Loop delivery volume. A hand-reasoned check of the same code would not have caught it —
the bug only shows up when you exercise IndexedDB's actual async request ordering, which is
exactly what this harness does and a human re-reading the code does not.

**`node tools/auditar-calculos.mjs`** is the second harness, and it answers a different
question. `verificar-datos-reales.mjs` asks *"do the totals still match yesterday's?"* — it
compares against a frozen `invariantes.json`, so it catches a number that **changed**, never a
formula that was **wrong from day one**. `auditar-calculos.mjs` recomputes every number from its
own definition and confronts it with what the pipeline produced: ~3.300 checks covering
per-equipment metrics (the ratio really is `litros_alineados ÷ actividad_alineada`), the
traceability steps (the `450,2 ÷ 51,3` shown to the user must actually produce the number on the
card, with the aligned operands — not merely land on the same result), fleet aggregation
(**every KPI must equal Σ cards + `totales.sin_asignar`, exactly**), reconciliation against the
spreadsheet (`total_litros + fuera_de_periodo.litros` = the file's liters), the diagnostic layer
(coverage, utilization, excess-vs-target, implicit activity), and master-key collisions that
`indexarMaestro()` would silently swallow. Run **both** before committing anything in
`js/data/`: they fail on different things and neither subsumes the other. On its first run this
one found four real defects (see `CORRECCIONES_APLICADAS.md`, 07/09/2026), including
`calcularExceso()` comparing all of the period's liters against only the GPS months' activity —
a violation of invariant 1 that had been shifting the headline "sobreconsumo" figure by millions
of pesos while every regression check stayed green.

**`node tools/auditar-declarados.mjs`** (`npm run declarados`) is the third harness and covers
what the other two structurally cannot. Both of them run the pipeline over the real spreadsheets
— but **activity declared by hand never appears in a spreadsheet**, so no invariant and no
pipeline run ever exercises `consumoDesdeActividadDeclarada()`, the only path by which an
equipment without GPS gets a consumption at all. That number is displayed with the same face as
a measured one: an expansion bug (declaring "10 hs per day" and multiplying by months instead of
by business days) yields a consumption 20× off with nothing failing anywhere. The same blind spot
covered `coberturaEquipo()` (1 check in `auditar-calculos.mjs`) and `utilizacion()` (2) — exactly
the two formulas whose denominator changed when Saturdays started counting 0.5. This harness
builds its inputs by hand and calls the pure functions directly: **no Excel, no IndexedDB, runs
in under a second**. It also holds the regression test for "declaring activity removes the
equipment from the sin-medición findings", which is behaviour no totals check would ever notice.

**The two spreadsheet harnesses take several minutes, and that is `fake-indexeddb`, not the app.**
`auditar-declarados.mjs` is instant — run it first, it fails fastest. Measured:
`fake-indexeddb` maintains each index linearly on `put()`, so 1.381 `get()`+`put()` on a store
with `raw_records`' four indexes take **25,6 s**, against **58 ms** on the same store with no
indexes — a 440× penalty a browser's B-tree-backed IndexedDB does not pay. The merge loop inside
`insertEntregasLoop()` is 1 ms for those same rows. Don't "optimize" the import code chasing
this.

For anything the harness doesn't cover yet (a specific card's rendering, an interaction), fall
back to the browser: load the files, then read the result out of `window.ultimoAnalisis`
(published by `renderPanel`) — `.totales` for fleet figures and `.filas[].metrics` for
per-equipment ones — and check that the card's displayed formula divides to the consumption it
shows next to it.

**Cómo cargar las planillas reales en el navegador sin clickear.** `.claude/launch.json` levanta
el server (`preview_start` con `name: "flotacontrol"`). Después, copiar los Excel a
`_datos_prueba/` (gitignoreado, ver .gitignore) y empujarlos al input desde la consola — es la
forma de verificar una interacción que los arneses no cubren:

```js
const dt = new DataTransfer();
for (const n of nombres) {
  const r = await fetch('/_datos_prueba/' + encodeURIComponent(n));
  dt.items.add(new File([await r.arrayBuffer()], n));
}
const inp = document.getElementById('file-input');
inp.files = dt.files;
inp.dispatchEvent(new Event('change', { bubbles: true }));
document.getElementById('btn-process-all').click();
```

Tarda ~30 s en procesar. Después `window.ultimoAnalisis` tiene el análisis y el panel está
renderizado. **Borrar `_datos_prueba/` al terminar**: son datos de flota.

**El truco del puerto distinto NO sirve con el Browser pane**, porque proxea todo por un mismo
puerto y el origen no cambia. Ahí el síntoma es brutal y confuso: los Excel parsean bien (se ven
los `[CARGAS] … 4511 filas` en consola) pero el panel no renderiza nada y la consola tira
`does not provide an export named 'X'` — el módulo viejo cacheado no tiene el export que el
módulo nuevo importa. Lo que sí funciona es forzar la revalidación del caché HTTP y recién ahí
recargar:

```js
for (const m of ['/js/app.js','/js/data/database.js','/js/ui/panel.js', /* …todos los tocados */])
    await fetch(m, { cache: 'reload' });   // 'reload' ignora el caché Y lo actualiza
location.reload();
```

Y si el cambio incluye un bump de `DB_VERSION`, borrar antes la base
(`indexedDB.deleteDatabase('FlotaControlDB')`) — pero **sin abrirla vos** después para
inspeccionarla: un `indexedDB.open()` sin versión crea una base v1 vacía y te deja mirando un
estado que fabricaste vos. Para ver qué versión hay sin tocarla, `await indexedDB.databases()`.

**Browser module cache will lie to you.** `python -m http.server` sends no `Cache-Control`, and
the browser keeps ES modules from a previous run of the same origin, so edits appear to have no
effect and you end up debugging code that isn't running. Confirm what's actually loaded
(`import('/js/data/analyzer.js?probe=' + Date.now())` and check for your new export), and if it's
stale, **serve on a different port** — a new origin gets a fresh module cache and a fresh, empty
IndexedDB, which also makes the import path a clean test.

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
   The GPS export writes time in **two different formats depending on the report's span**:
   monthly files give an Excel fraction of a day (`0.5` = 12 h), while a consolidated
   multi-month file gives text like `"3 days, 10:53:03"` (= 82.88 h). `parseExcelHours()` /
   `parseDuration()` handle both; a parser that only splits on `:` silently drops the whole-day
   part, which is 72 of those 82 hours. Same trap applies to any new time column — **any GPS
   column that Excel formats as `[h]:mm` (elapsed hours) is a fraction-of-a-day serial number
   and needs `parseExcelHours()`, never `parseNumber()`**, or it comes out 24× too small.
   Horómetro (added to the GPS export starting with the July 2026 file) once had exactly this
   bug: verified against that real file, its raw value `1343.4488…` displays as `32242:46` in
   Excel (`1343.4488 × 24 = 32242.77` h) but was being read with `parseNumber()`, storing the
   day count instead of hours — silently wrong by 24× the moment anything computes with it,
   even though nothing did yet. Fixed in `handleGPS()` (xlsx-parser.js) to use
   `parseExcelHours()`, same as ralentí/movimiento, so every time-like field in a GPS record
   shares one unit (hours) — Odómetro stays on `parseNumber()`, it's plain kilometers, no
   day-serial encoding involved.
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
   resolution, fleet-wide KPI aggregation. `totales.combustible_desglose` and
   `totales.lugar_desglose` are the two fleet-wide money breakdowns (by product/brand and by
   physical site respectively) — both computed straight from `cargas`, both purely additive
   (adding one never changes the other's numbers). `getBandera()`/`tipoLugarCarga()`
   (normalizer.js) classify every combustible/lugar against an explicit list checked by hand
   against the real file, not a name pattern — a new lugar or combustible not yet in either list
   falls back to `''`/`'Sede'` and should be added to the list, not inferred from its name.
5. `js/data/diagnostico.js` (~2000 lines) — the automatic diagnostic engine. Runs ~20 rule
   functions (`detectarXxx`) over the analyzed fleet and produces a `hallazgos` (findings)
   array consumed by the Panel view. Each finding has a `titulo` (escaped on render) and a
   `detalle` (**rendered as raw HTML in `panel.js`, on purpose**, so findings can wrap numbers
   in `<strong>`). Any free-text value taken from an uploaded spreadsheet (combustible name,
   centro de costo, chofer, etc.) that gets concatenated into `detalle` **must** be passed
   through this file's local `esc()` first — the literal `<strong>` tags in the template stay
   unescaped, only the interpolated data does. This is the one recurring foot-gun in this file;
   grep for `detalle:` when adding a new finding and check what you're interpolating.
   `auditarCalidadCargas()`'s price-consistency check (`preciosInconsistentes` →
   `precios_inconsistentes` finding) is grounded in a real, verified fact: every combustible name
   in `Cargas_Combustible_HSV_2026.xlsx` has exactly ONE `precio_unitario` for the entire year,
   with zero variance by lugar or by month (checked against all ~4,400 real rows). So any future
   carga with a different non-zero price for a combustible the fleet already has a majority price
   for is flagged for review — it never auto-corrects, because it could just as well be the start
   of a real price increase, which only a person can confirm against the comprobante.
6. `js/data/autocorreccion.js` — runs once per `renderPanel()`, right after the first
   `analizarFlota()` and before anything renders. Applies the diagnostic corrections that have
   no ambiguity (onboard a charge code shaped like a valid interno that isn't in the maestro
   yet; accept a code that's neither interno- nor dominio-shaped as non-fleet spend; align an
   equipment's empty meta to its own measured consumption the first time) directly — no
   confirmation step — and logs every action to the `accionesAutomaticas` store so it surfaces
   as a "se aplicó sola" finding (`generarDiagnostico`'s `extra.accionesRecientes`) instead of
   disappearing silently. If anything was applied, `renderPanel()` re-fetches `equipos` and
   re-runs `analizarFlota()` before rendering, so the fix is visible immediately, not next
   reload. The one huérfano case it deliberately never touches: a valid patente with no interno
   match (`clasificarNoFlota`'s `vehiculo_sin_interno`) — which real equipment that belongs to
   is a judgment call only a person can make, so it stays queued for manual review. It also skips
   a huérfano within one edit of a real interno whose prefix is unknown to the fleet in every
   sense (`sugerirPosibleTypo()`, normalizer.js) — a likely typo (e.g. "GR01" for "GE01") gets its
   own "parece error de tipeo" finding instead of being onboarded or accepted as noise. Only
   prefixes with an actual consumption rule (`PREFIJOS_CALCULABLES`, the union of
   `RULE_L_100KM`/`RULE_L_HORA`/`RULE_NO_TANK` in analyzer.js) get auto-onboarded — a prefix in
   `TIPO_POR_PREFIJO` with no rule (true of CA/LM until they were added to `RULE_L_HORA`) would
   onboard into a broken, uncalculable card, so it's left alone instead.

   Undoing an automatic action (`deshacerAccionAutomatica()`) reverts the underlying data
   (deletes the onboarded equipo, un-accepts the code, or clears the auto-set meta) and marks
   that `accionesAutomaticas` row `deshecha: true` — never deleted, because deleting it would
   let the same conditions re-trigger the same action on the very next `renderPanel()`.
   `aplicarCorreccionesAutomaticas()` skips any tipo+codigo pair already marked `deshecha`. An
   undo that would destroy later work (the equipo was hand-edited since, or the meta was already
   replaced) refuses to touch the data and only marks the log entry.
7. `js/ui/panel.js` (~4400 lines, the largest file) — the unified Panel: fleet KPIs, editable
   equipment cards, the diagnostic list, filters, period selection, meta-adjustment and
   equipment-comparison modals. `js/ui/datatable.js` (~2000 lines) is the separate
   spreadsheet-like editor/viewer for raw tables (Base de Datos view).

### Three invariants that keep the numbers honest

These were added after an audit found each one being violated somewhere. They're easy to break
again by accident, so check them when touching consumption math:

1. **Same period on both sides of a ratio — and of any subtraction against a target.** A
   consumption rate divides liters by activity, so both must come from the same months. The same
   applies to `calcularExceso()` (diagnostico.js), which subtracts "liters the target predicts
   for the measured activity" from the liters actually burned: it uses the **aligned** base for
   both sides. It did not, until 07/09/2026 — it compared all of the period's liters against the
   activity of only the months with GPS, so the fuel of unmeasured months was counted as excess.
   That fed the headline `sobreconsumo` and `ahorro` figures for 26 equipment. Any new
   comparison against a meta must take its liters and its activity from the same `alineacion`.

   `alinearCargasYGps()` (analyzer.js) intersects each
   equipment's charge-months with its GPS-months and the rate is computed from that subset
   only (`litros_alineados` / `km_alineados` / `horas_alineadas`). The full-period totals
   (`total_litros`, `total_km`, `total_horas`) stay untouched — they're real spend/activity and
   feed fleet KPIs. A GPS report spanning months the charges don't cover is dropped rather than
   prorated (prorating would invent km nobody measured). The same "all its months or none" rule
   applies in `filtrarPorPeriodo()`, because a multi-month report like "Resumen de Flota
   Ene-Jul" cannot be attributed to a single selected month.

   The trap that made this bug invisible: a record's `periodo` field is only the month of its
   **start date**, so a Jan–Jul GPS report carries `periodo: '2026-01'` while actually measuring
   seven months. Grouping or filtering by `r.periodo` therefore counts it as January, and its
   seven months of hours end up divided by one month of charges. Use `mesesDeRegistro(r)`
   (analyzer.js) — which expands `fecha`..`fecha_hasta` into every month covered — anywhere you
   attribute a record to a month; `periodo` alone is only safe for charges, which are
   point-in-time.

1b. **Every fleet KPI must equal Σ cards + what is not assigned to any card.** Records that
   match no equipment (`totales.huerfanos`) still feed the fleet totals, so they must be
   accumulated in full — not just their liters. Until 07/09/2026 they weren't: a GPS unit named
   `PORTATIL` contributed 6.903 km and 3.180 h with zero liters, so it was invisible in every
   finding (the non-fleet one groups by liters) while the km KPI read 6.903 higher than the sum
   of the cards, with nothing to explain the gap. `totales.sin_asignar` now publishes
   `{litros, km, horas, codigos}` and the km/hours traceability steps name it. Anything new that
   lands in a fleet total needs the same treatment, and `auditar-calculos.mjs` enforces it.

   The other half of the same rule: what falls **outside** the analyzed period. The period is
   the Cargas∩GPS overlap, so months with charges and no GPS are excluded from the KPIs —
   correct for the ratio, invisible to whoever compares the panel against the spreadsheet.
   `totales.fuera_de_periodo` publishes those liters, cost and months; the liters KPI has a step
   for it and the `meses_sin_gps` finding says it in words. In the real 2026 files that is
   86.439 L, 12,8% of the year's fuel.

2. **One definition per concept.** Coverage lives only in `coberturaEquipo()` (distinct days
   with a charge ÷ business days of the analyzed period) and is used by the card, the detail
   modal, Seguimiento and the meta-adjustment gate. `mediana()` is exported from diagnostico.js
   and imported where needed. Both existed twice with different formulas and the same label,
   producing two different numbers for the same equipment. It happened twice more and was caught
   on 07/09/2026: `ratioPotenciaFlota()` (diagnostico.js) and panel.js's "typical charge" each
   wrote `arr.sort()[Math.floor(n/2)]` inline — which returns the upper of the two middle values
   on an even-sized set instead of their average — and panel.js already had `mediana` imported
   at the top of the file. **Never write a median, a coverage figure or a business-day count
   inline; import the one that already exists.**

3. **A low number needs its context before it's a conclusion.** `utilizacion()` compares hours
   per business day against `JORNADA_REFERENCIA` (analyzer.js: 10-12 h for áridos and mixers,
   from operations, not from the data). Without it, an equipment that barely worked looks
   identical to an efficient one, and normalizing its meta against that period bakes in the
   idle months. Equipment that doesn't follow a work day (generators, heaters, compressors,
   pumps) is excluded — hours/business-day is meaningless for them and produced >24 h/day.

   The same `JORNADA_REFERENCIA` also backs the one inference the app is allowed to make:
   when an equipment has no GPS at all, `actividadImplicita()` (diagnostico.js) estimates its
   activity as litros ÷ meta — a number that lives or dies by whether the loaded meta is
   correct. It's cross-checked against a second, independent estimate: business days the
   equipment *actually charged fuel on* (never an invented range) × the reference hours/day for
   that equipment or sector. `estimacionCreible()` treats a mismatch between the two as a third,
   independent reason to distrust the estimate — on top of the existing peer-median and
   declared-power checks. Both estimates and the comparison are always shown with their formula
   next to the number (card, equipment overlay, and the estimation-comparison table).

Consumption is exposed in **both** units (`consumo_l_hora` and `consumo_l_100km`) whenever both
denominators exist; `consumo_real` is the one in the equipment's declared unit. Both are shown
together because operations that mix long distances with on-site idling (Tunuyán) need both.

### Duplicates are dropped at import, not reported afterwards

`insertRawRecords()` marks any charge or GPS row identical to one already stored
(`claveCargaExacta()` / `claveGpsExacta()` in normalizer.js) with `_dupe_exacta`, and
`registroExcluido()` keeps those out of the analysis. Rows are kept in IndexedDB and stay
visible in Base de Datos — nothing is deleted. This is what makes it safe to re-upload a file,
or to keep adding new months without clearing movements first.

Loop delivery rows (`type: 'entrega'`) merge across sources by remito number instead
(`insertEntregasLoop()`, database.js) — a real remito can legitimately show up more than once
in the same import (Hormigón/Bombeado/Otros are subsets of each other, not distinct deliveries)
and again in the other Loop file. **When a merge touches the same already-stored record more
than once inside one call, accumulate the changes into one `Map<id, cambios>` and do a single
`get()`+`put()` per id at the end — never one `get()`+`put()` per touch.** IndexedDB fires the
queued `get()`s before the first `put()` resolves, so parallel touches to the same record each
read the same pre-update snapshot; the last `put()` to resolve wins and silently overwrites
whatever the earlier ones had just written with fields it never saw. This is exactly how a
race condition dropped 43% of Loop's delivery volume (31.822 m³ shown instead of ~55.365 m³)
without a single error anywhere — `tools/verificar-datos-reales.mjs` is what caught it, see
`CORRECCIONES_APLICADAS.md` (03/09/2026). The same rule applies to any future code that batches
IndexedDB updates keyed by something other than the row being inserted.

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

### Changelog

**`CORRECCIONES_APLICADAS.md` is the up-to-date changelog and source of truth** for what's
actually been done and what's genuinely still pending — read it before assuming a documented
problem is real, and add to it when you fix something non-trivial.

(`.agent.md`, `.instructions.md`, `.prompt.md`, `PLAN_ROO_CODE.md`, `ROO_CODE_SETUP.md`,
`DIAGNOSTICO_NORMALIZACION.md` and `RESUMEN_EJECUTIVO.md` documented a prior repair attempt via
Roo Code and described several things as "still to fix" that were already fixed by the time
anyone read them again — removed 03/09/2026, their content is superseded by this file and by
git history if it's ever needed.)


## Roadmap acordado con el usuario (07/09/2026)

Esta sección es el plan vigente, acordado punto por punto. Está en castellano a propósito: la
escribe y la lee el dueño del proyecto. **Antes de empezar cualquier ítem, releerla** — varias
entradas existen porque una suposición razonable resultó equivocada al medirla.

### Decisiones cerradas (no volver a discutirlas)

1. **Que falte un mes NO es un error.** El análisis se hace sobre el período que comparten los
   archivos subidos. Si el usuario quiere analizar solo julio, sube solo el Resumen de Flota de
   julio. En la tabla de Cargas se muestran **todos** los meses, incluidos los incompletos; el
   cálculo se hace sobre el período común y **se declara cuál es**. Nunca se le informa al usuario
   "falta el mes X" como si fuera un problema suyo. El hallazgo `meses_sin_gps` está mal
   encuadrado (dice "Faltan…" con severidad alta) y hay que bajarlo a informativo — ver ítem 0.

2. **Odómetro y horómetro de Wara quedan FUERA del alcance.** ✅ Hecho 07/09/2026. Ya no se
   leen ni se guardan en `handleGPS()` (xlsx-parser.js). De Wara solo se extrae: km recorridos,
   horas de ralentí y horas de movimiento.

3. **El cruce con el Informe de Ignición está eliminado del código.** ✅ Hecho 07/09/2026.
   `cruzarIgnicion()`, `handleIgnicion()`, el hallazgo `gps_vs_ignicion`, el case
   `reclamo_ignicion` y `CONSEJOS.gps_vs_ignicion` eliminados de los tres archivos. El control
   que ese cruce buscaba dar ahora sale del **ciclo de Loop** (ítem 9).

4. **`Informe Entregas` (Loop) e `Informe de Viajes` (Loop) se conservan y suman dato real.**
   Entregas: m³, remitos, planta, obra, ciclo — fuente primaria para L/m³ (ítem 10) y remitos en
   conflicto (ítem 13). Viajes: "Parada Prohibida" (494 filas, 163 hs) — detención no autorizada
   medida por Loop, independiente del GPS. El único informe de Loop eliminado es el de Ignición
   (no tiene archivo fuente). Cualquier informe futuro que no aporte dato nuevo ni sirva de control
   de totales, no se importa.

5. **`Informe Volumen entregado por camión` se conserva, pero solo como control de totales.** No
   aporta dato primario (es un agregado de lo que ya está en `Informe Entregas`), pero detectó una
   diferencia real de 1.021,5 m³ contra el detalle en may–jul. Queda marcado como derivable, como
   está hoy. Cualquier otro informe futuro que no sume dato nuevo ni sirva de control, no se
   importa.

5. **Los kilómetros de Loop nunca se usan como denominador.** Ya estaba en la skill
   `calculos-combustible` y se reconfirma: 110.858 km contra 215.658 km del GPS en los mismos
   equipos y meses (51%). Es distancia de viaje cargado, no recorrido total. Lo que se descartó en
   su momento fue **esa columna**, no el archivo de Loop entero — distinción importante, porque el
   `Ciclo` del mismo archivo sí sirve.

### Reglas permanentes — no volver a discutirlas

- **INTERNO SIN DOMINIO no es un error. DOMINIO SIN INTERNO no es un error.** Nunca se marca
  como advertencia ni se le pide al usuario que corrija. El análisis avanza con lo que hay.
- **Subir 3 meses o subir el año completo no es un error.** Se analiza la intersección de los
  meses que tienen datos en ambas fuentes, aunque sea un solo mes. Nunca se informa "falta el mes
  X" ni se pide subir los meses restantes.

### Decisiones cerradas nuevas (08/09/2026)

6. **Solo se autocorrigen códigos CON litros en la planilla de Cargas.** Un código que aparece
   únicamente en GPS o en Loop, sin ninguna carga de combustible, no se da de alta como equipo ni
   se acepta como "así está bien": se descarta. Implementado en `aplicarCorreccionesAutomaticas()`
   con un `continue` temprano si `h.litros <= 0`. Efecto medido sobre los archivos reales: 6
   aceptados menos, 1 alta menos, 16 huérfanos a revisión manual en vez de 15.

7. **"Posible repetida" no es un hallazgo.** Dos cargas del mismo equipo, el mismo día, con los
   mismos litros pero distinto importe u hora **son legítimas** (dos surtidores, dos turnos). Solo
   el duplicado **exacto** — idéntico en todos los campos hasta el centavo — tiene una corrección
   obvia, y esa ya se aplica sola. La sección `duplicadosPosibles` salió del hallazgo
   `calidad_planilla`. `auditarCalidadCargas()` los sigue calculando; simplemente no se reportan.

8. **Los remitos de Loop en conflicto NO son parte del análisis de combustible.** El hallazgo
   `entregas_conflicto_remito` se eliminó. Los datos siguen guardados en IndexedDB y visibles en
   "Entregas (Loop)" para el cruce de ciclo/ralentí (ítem 9), pero no ensucian el diagnóstico de
   consumo. **Esto reemplaza al viejo ítem 13, que queda cancelado.**

9. **Dar de alta un equipo nuevo es la normalidad, no un aviso.** Las acciones `alta_interno`
   salieron del hallazgo `acciones_automaticas`. Solo se reportan `aceptado_no_flota` y
   `meta_alineada`, que sí son decisiones que el usuario puede querer revertir.

10. **NUNCA agregar `"type": "module"` al package.json.** Medido el 08/09/2026: `xlsx.full.min.js`
    es UMD y los arneses lo cargan con `createRequire()`. Bajo `type:module` ese `require()`
    devuelve un objeto vacío, el parseo produce 0 filas y `verificar-datos-reales.mjs` mide
    **0 equipos en vez de 189 — sin lanzar un solo error**. Queda un `_comment` en el package.json
    diciéndolo. Es exactamente la clase de falla silenciosa que los arneses existen para atrapar.

### Pendiente de implementación — plan vigente (08/09/2026)

Ordenado por lo que el usuario pidió primero y por lo que más mueve la lectura del panel.

**A · El panel repite el mismo equipo en varios hallazgos.** ✅ **HECHO (08/09/2026).** Bloque
"REPARTO DE EQUIPOS ENTRE HALLAZGOS DE SITUACIÓN" al principio de `generarDiagnostico()`. Seis
hallazgos entran al reparto: `datos_parciales`, `sin_medicion`, `estimacion_inverosimil`,
`subutilizacion`, `bajo_uso`, `sin_gps_estimado`. Cada equipo lo reclama el primero de esa lista
que lo contenga; los demás lo omiten.

**El orden NO es la severidad, es la causalidad** — el hallazgo que explica *por qué* faltan
datos gana sobre el que solo constata que faltan. Por eso `datos_parciales` va primero aunque su
severidad empate con otros: su propio detalle ya decía *"van a seguir apareciendo en hallazgos
que no les corresponden"*, que era exactamente este problema. Y `sin_gps_estimado` va último
porque su propio texto dice *"no es una falla"*.

Las seis listas se calculan **juntas y arriba**, aunque cada tarjeta se arme más abajo donde
siempre estuvo: si se calcularan donde se arma cada una, el orden de reparto sería el del archivo
(subutilización primero) y no el de causalidad. Los títulos siguen contando bien porque el filtro
se aplica a la lista, no a la tarjeta ya armada.

El reparto **se declara**: `notaReparto(id)` agrega al detalle una frase que dice a dónde se
fueron los equipos cedidos ("Otros 4 equipos de este grupo se listan en «datos de solo una parte
del período»"). Cambiar un conteo sin explicarlo sería peor que el problema original.

Medido sobre los archivos reales: 28 equipos en los hallazgos repartidos, **0 repetidos** (antes
se repetían), y el total de hallazgos bajó de 21 a 20 porque `bajo_uso` y `estimacion_inverosimil`
quedaron vacíos — sus equipos ya estaban explicados por otro. Ningún total de flota se movió.
Regresión cubierta en `auditar-declarados.mjs` (grupo `reparto`, 5 chequeos).

**B · Todas las acciones en la misma ventana.** ✅ **HECHO (08/09/2026).**
`abrirRevisarDecidir(hallazgoId, analisis, rawRecords)` en panel.js, con un botón primario
"Revisar y decidir" en cada hallazgo que liste equipos.

Una sola ventana con la lista completa, checkbox por fila, "Tildar todos / Ninguno", contador en
vivo, y todas las acciones que apliquen al hallazgo operando sobre la selección: declarar
actividad, marcar estado, ralentí aceptable, reclamo GPS, "así está bien", comparar y marcar como
revisado. Qué acciones se ofrecen sale de un solo objeto `puede`, con los mismos criterios que
usa la barra de la tarjeta, para que no se desincronicen.

Dos detalles que importan:
- **La lista es la completa, no la recortada.** `h.equipos` viene con 10-15 filas para la
  tarjeta; el modal usa `internos_todos` cuando está. Se le agregó ese campo a `subutilizacion`,
  `bajo_uso`, `datos_parciales`, `sin_gps_estimado` y `estimacion_inverosimil` (`sin_medicion` ya
  lo tenía). Sin eso, un hallazgo de 40 equipos solo dejaba actuar sobre los primeros 12 y el
  resto quedaba inalcanzable — verificado en el navegador antes y después.
- **Al volver de una acción se reabre la ventana** con el hallazgo recalculado, porque encadenar
  decisiones sobre el mismo grupo es el caso normal.

**C · Equipo par por marca + modelo (ítem 8 del plan viejo).** ✅ **HECHO (08/09/2026).**
`parIdentico(fila, todas)` en diagnostico.js. La regla:

```
mismo marca + modelo  →  de esos, los que TENGAN datos medidos  →  el año más cercano
```

**El orden importa y no es intercambiable.** Filtrar por año antes que por datos habría devuelto
justo el par inútil: el gemelo de año exacto de `CM-43` (HILUX 2022) es `CM-46`, que tampoco
tiene GPS. El único par utilizable es `CM-48` (2023, con GPS) — el que el usuario venía usando a
mano. Hay un chequeo dedicado a esto en `auditar-declarados.mjs` (grupo `par`) que arma
justamente ese trío para que nadie invierta el orden sin que falle.

Devuelve los dos casos por separado porque sirven para cosas distintas: `conMeta` (gemelo con
meta oficial — para dos del mismo modelo la meta es el mismo número) y `conDatos` (gemelo con
consumo medido). **Este segundo era el que faltaba**: la búsqueda vieja exigía que el gemelo
tuviera meta cargada, y CM-48 no la tiene, así que CM-43 se quedaba sin ninguna referencia.

Lo usan `investigarMeta()` (como fuentes de orden 2 y 2.5) y el hallazgo `sin_gps_estimado`, que
ahora **nombra al par en pantalla**: "par: CM48 (2023) mide 9,31 L/100Km". Una sola definición
para los dos, por la invariante 2.

**D · Nombrar el referente en la sugerencia.** ✅ **HECHO (08/09/2026).** `sugerirMeta()` gana
`base_con_referentes`, `internos` y `ajustada`. La tarjeta pasó de *"mediana de 8 tractor
medidos"* a *"mediana de TR35, TR20, TR26 y 5 más"* — de cuántos son a cuáles son, que es lo que
permite verificar si la comparación tiene sentido.

Y se pueden corregir a mano: botón **"Elegir referentes"** → `abrirElegirReferentes()`. Destildar
el par que no es comparable, o sumar uno que la regla no eligió (otro modelo, otra denominación)
pero que quien opera sabe equivalente. La vista previa corre el **mismo** `sugerirMeta()` que se
va a guardar, no una fórmula paralela — si difirieran, la vista previa no serviría para nada.
Lo elegido se guarda por equipo en el store `referentesMeta` (DB v14) y la tarjeta lo declara
con "referentes elegidos a mano", para que un número ajustado nunca se lea como automático.
"Volver a la automática" borra la fila y manda de nuevo la regla.

**E · Comparación normalizada, no cruda.** ✅ **HECHO (09/09/2026).** La comparativa tiene dos
modos: **totales** (cuánto hizo cada equipo) y **ritmo** (a qué velocidad lo hizo), con
`METRICAS_NORMALIZADAS` en comparativa.js — L/día trabajado, L/carga, $/día, km/día, hs/día,
cargas/mes. El aviso de "cargas desigual" dejó de ser solo un cartel: lleva el botón que activa
el modo ritmo.

Dos cosas se declaran **siempre**, en los dos modos, porque comparar sobre períodos distintos sin
decirlo es lo que la regla 1 prohíbe:
- **"Meses con datos"** como primera fila, marcada cuando son desiguales.
- **"Días trabajados (denominador)"** como fila propia en modo ritmo, con los meses en el tooltip
  — sin eso "12,4 L/día" sería un número sin pasos, que la regla 2 no deja publicar.

**El denominador son los meses del PROPIO equipo, no los del período.** Esto costó un bug real,
encontrado en el navegador y no por los arneses: comparando `CM30` (datos en 1 de 8 meses) contra
`TR32` (8 de 8), los dos mostraban "179 días trabajados", porque el denominador salía de
`coberturaEquipo()` sobre el período completo. Los 71,6 L de CM30 son de **un** mes; dividirlos
por los días hábiles de ocho daba 0,40 L/día cuando el ritmo real es 3,11 — **7,8× de error**,
numerador y denominador de períodos distintos. Se corrigió con `diasHabilesDeMeses()` (la misma
función que usa `actividadImplicita()`, ahora exportada — no una segunda definición) sobre
`coberturaMensual().listaMeses`. Hay chequeos dedicados en `auditar-declarados.mjs` (grupo
`normalizado`) que fallan si alguien vuelve al denominador del período.

**F · Botón "Actualizar meta al consumo actual" por equipo.** ✅ **HECHO (09/09/2026).**
`abrirActualizarMeta()` en panel.js, botón en la tarjeta en edición y en el overlay, visible solo
cuando el equipo **tiene consumo real medido** (si no, no hay a qué alinear).

Sigue en pie la decisión de fondo: la autocorrección alinea **solo las metas vacías**, y esto es
de a un equipo. Por eso el modal muestra, antes de guardar: la meta actual con su origen, la
nueva, el % de diferencia, la división que la produce con sus operandos y período, un aviso si la
base es floja (`metaDesdeConsumoReal().confiable`), y la advertencia de que alinear la meta al
consumo actual **deja el desvío en cero y puede tapar un sobreconsumo real**. Queda marcada en
`editado_manual` para que una reimportación no la pise, y registrada en `edicionesLog`.

De paso se eliminó `metaDesdeConsumoRealLocal()` de panel.js, que era una copia recortada de
`metaDesdeConsumoReal()` — dos definiciones del mismo concepto, justo lo que la invariante 2
prohíbe.

### Deuda técnica conocida (medida, no supuesta)

- **`/api/chat` no tiene rate limiting.** El `APP_SECRET_VALUE` viaja en el JS del navegador y está
  documentado como anti-scraping, no como autenticación. Quien lea el archivo puede gastar la
  `ANTHROPIC_API_KEY`. Los topes de tamaño (`MAX_TOKENS`, `MAX_CONTEXT_CHARS`,
  `MAX_HISTORY_MESSAGES`, `MAX_TOTAL_JSON_CHARS`) acotan el costo **por request**, no la cantidad
  de requests. Cerrarlo de verdad requiere Vercel Deployment Protection o un login real; mientras
  tanto, el techo de gasto se pone en la consola de Anthropic, no en el código.
- **`panel.js` tiene 4.867 líneas.** Es el archivo más grande del repo por lejos y concentra el
  panel entero. Los ítems A y B lo van a tocar fuerte: conviene extraer primero el modal de
  hallazgos a su propio módulo antes de agregarle una pestaña más.

### El orden del pipeline, tal como lo definió el usuario

```
1. NORMALIZAR       duplicados fuera · formatos corregidos y convertidos
                    cruce por INTERNO + DOMINIO (las dos únicas columnas comunes
                    a las cuatro planillas; el resto es diferencial por planilla)
2. ALINEAR PERÍODOS intersección de meses, por equipo
3. CORRECCIONES     buscar las guardadas y aplicarlas
4. TABLAS           columnas comunes primero, después las diferenciales
5. BADGES           qué aporta cada planilla, por separado
6. CRUCES           Loop contra Resumen de Flota
7. SECUNDARIOS      m³, L/m³, por chofer, por obra
```

### Plan, en orden de ejecución

> **Estado al 08/09/2026:** los ítems **0 a 7 están hechos** (commits `5516593`, `50612aa`,
> `d97bd8b`, `3fecc4c`). El **13 quedó cancelado** por pedido del usuario. Siguen abiertos los
> ítems **8 a 12 y 14**, reordenados y ampliados en "Pendiente de implementación — plan vigente"
> más arriba: lo que era el ítem 8 ahora es el punto **C** de ese plan.

**0 · Reencuadrar `meses_sin_gps`** ✅ **HECHO (07/09/2026).** Severidad bajó a 'baja', título
"Período analizado: N meses en común", frase "Ojo con los totales" eliminada. El dato está:
`totales.fuera_de_periodo` y el paso del KPI de litros intactos. Arnés de coherencia actualizado
para verificar el nuevo texto.

**1 · Corregir el maestro cuando se asigna un dominio a un interno** (tanda corta). Es el caso
`vehiculo_sin_interno` / "sin asignar": cargas con dominio (patente) que no tiene interno
asociado en el maestro. Hoy la corrección se guarda por huella **de esa carga**; el maestro no
se entera y el mismo dominio vuelve a salir huérfano en la próxima planilla. Lo correcto: al
asignar interno a un dominio, escribir ese dominio en la fila del equipo — y desde ahí cruza
solo para siempre. **Quedan 15 códigos por 5.085,8 L, de los cuales 4.914 L son patentes sin
interno.** Ya se verificó que no hay colisiones de claves en el maestro.

**2 · Días trabajados como denominador** (tanda corta-media). Es la pieza que habilita los ítems 3
y 8, y la pidió el usuario así: *"19 cargas / 22 días laborales o trabajados"*. Hoy el denominador
de cobertura y utilización son los **días hábiles** del calendario. Tiene que pasar a ser:

```
días trabajados = días hábiles − días marcados como fuera de servicio / taller /
                  sin chofer / backup / temporada baja
```

Las siete categorías **ya existen** (`CATEGORIAS_SEGUIMIENTO` en panel.js: fuera_servicio,
taller_ext, taller_int, temporada_baja, sin_chofer, backup, otro) y el store `seguimientoEquipos`
las guarda. Lo que falta es que lleven **rango de fechas** — hoy es una fila por interno, sin
fechas, y el usuario necesita marcar "operativo pero sin chofer **en los días que no cargó**". Con
eso, un equipo con 19 cargas en 22 días trabajados deja de parecer un equipo con 19 cargas en 142
días hábiles.

**3 · Selección múltiple en todos los hallazgos, con motivo por fila** (tanda corta). Hoy los
checkboxes solo aparecen en los hallazgos de ralentí y `sin_medicion`, y en los de fuera de flota
(`puedeReclamarGPS || esNofl`, panel.js ~línea 972). Faltan en **subutilización (34 equipos)**,
`datos_parciales`, `sin_gps_estimado` y `bajo_uso`, que son justamente donde hay que marcar en
bloque backup / taller / sin chofer. Y cada equipo tiene que poder llevar un **motivo
distinto** en la misma tanda: valor por defecto + override por fila, el mismo patrón que ya se usó
en "Declarar actividad estimada".

**4 · Tramo alineado visible en la tarjeta** (tanda corta). 26 equipos calculan su consumo sobre
menos meses de los que cargaron. Hoy eso solo se ve abriendo "ver cálculo"; tiene que decirlo al
lado del número — "6 de 7 meses" — porque cambia cómo se lee ese consumo y ahora también cambia su
exceso valorizado.

**5 · Columnas comunes vs diferenciales, explícito** (tanda corta). INTERNO y DOMINIO primero en
las cuatro vistas; después lo propio de cada planilla. Hoy el criterio existe implícito y disperso
(`COLS_MOV` en datatable.js). Es la base de los ítems 6 y 12.

**6 · Badges por planilla** (tanda corta-media). Qué aporta cada archivo, de un vistazo: horas y km
del Resumen de Flota · litros, combustible y precios de Cargas · m³, remitos y clientes de Loop ·
metas de Consumos Estimados. Todo ya está calculado; es presentación.

**7 · Arranque limpio y correcciones con período** (tanda propia, toca el esquema). Pedido textual:
la app arranca sin datos precargados; desde el segundo análisis se aplican los cambios guardados
**si los archivos o al menos el período coinciden**; al cambiar el período solo persisten algunas
cosas. Hoy los movimientos se limpian en cada carga (bien) pero el **maestro persiste completo** y
las correcciones se guardan por huella, sin período. Hay que agregarle período a las correcciones y
clasificar cada tipo:

- **permanente**: alta de interno, dominio asociado al equipo, unidad de cálculo, denominación.
- **del período**: actividad declarada, estado del equipo (backup/taller/sin chofer), aceptación de
  ralentí, aceptación de código fuera de flota.

**8 · Equipo par por marca + modelo** (tanda corta-media). Verificado contra el maestro real, ya no
hace falta investigarlo antes. La regla **no es "mismo año"**:

```
mismo marca + modelo  →  de esos, los que TENGAN datos medidos  →  el año más cercano
```

Verificado: `CM-43` (TOYOTA / HILUX 4X4 DC SR 2.8 TDI 6 MT / 2022, sin GPS) tiene a `CM-46` con
año exacto — pero CM-46 **tampoco tiene GPS**, así que el único par utilizable es `CM-48` (2023,
con GPS), que es justamente el que el usuario venía usando a mano. **Para comparar CM-43 vs CM-48
en igualdad de período, el usuario subirá el Resumen de Viaje de un mes específico de CM-43
(un mes reciente que también esté cubierto por el Resumen de Flota de CM-48).** `CF-38` (HYUNDAI / 757 / 2017)
tiene dos pares exactos con datos: `CF-36` y `CF-37`. `CM-35` **sí tiene GPS** y no necesita par —
no confundirlo con CM-43. Calidad del maestro: 193 equipos, 191 con marca, 185 con modelo, 182 con
año, y 32 grupos de marca+modelo con 2 o más equipos.

**9 · Banda ciclo/motor de Loop como control del ralentí** (tanda media). Medido el 07/09 sobre 146
pares equipo-mes de 25 mixers:

```
TOTAL    Loop 9.527 hs de ciclo   ·   Wara 24.081 hs de motor   ·   39,6%
por par  p10 6%  ·  mediana 45%  ·  p90 57%  ·  máx 61%
pares donde Loop supera a Wara (imposible):  0
MX100    ene 45% · feb 51% · mar 56% · abr 53% · may 56% · jun 54% · jul 49%
```

**El ciclo NO reemplaza a las horas del GPS** — mide de inicio de carga a vuelta a planta, el motor
está encendido bastante más, y 40% es coherente, no un error. **Sí sirve como control**: la
relación es muy estable por equipo, y el que se sale de su propia banda está reportando horas que
no existieron o trabajando sin remito. Dos límites a respetar: **1.378 de 7.035 filas no tienen
ciclo legible** (20%), y los pares de p10 son meses con pocas entregas donde el ratio no significa
nada — exigir un mínimo de entregas antes de emitir el hallazgo.

Extra del mismo archivo: `Parada Prohibida (min)` del Informe de Viajes tiene **494 filas con valor,
163 horas** en total. Es detención no autorizada medida por Loop, independiente del GPS. Y los dos
archivos de Viajes cubren ene–jun **y julio**, no solo ene–jun.

**10 · L/m³ por mixer, comparable** (tanda media). Ya está sancionado por la skill
`calculos-combustible` (solo mixers, mismo período, variación medida 18%, es **contexto** y no
reemplaza a L/hora). 55.364,5 m³ y 25 mixers con entregas. Requisito que puso el usuario: no
comparar equipos sueltos sino **mismo período y mismas circunstancias** — de ahí que el ítem 2 sea
previo. La comparación se expresa siempre normalizada: `19 cargas / 22 días trabajados`, no `19
cargas` a secas.

**11 · Consumo por chofer** (tanda media). `CHOFER` está en Cargas y `Conductor` en los dos
archivos de Loop; hoy no se cruzan. Comparar el **mismo equipo con distintos choferes** es la única
forma de separar un problema mecánico de uno de conducción, y hoy no se puede hacer.

**12 · Tablas totalmente editables** (tanda propia, la más grande). Ya existe: edición celda por
celda en las cuatro vistas, borrar filas del maestro, corregir/asignar cargas huérfanas individual
y en lote, columnas propias. **No existe**: mover columnas arrastrando, renombrar encabezados,
borrar fila como botón genérico en toda tabla. Es el ítem más grande y el que menos mueve los
números — por eso va después de los que sí los mueven.

**13 · Remitos de Loop que no coinciden → reclamo.** ❌ **CANCELADO (08/09/2026).** El usuario:
*"NO CORRESPONDE ANÁLISIS, porque estamos analizando cargas de combustible"*. El hallazgo
`entregas_conflicto_remito` se eliminó de `generarDiagnostico()`. Las filas en conflicto siguen
guardadas y visibles en "Entregas (Loop)" — el dato no se perdió, solo dejó de reportarse como
problema de combustible. Ver decisión cerrada 8.

**14 · Consumo por obra / cliente / planta** (tanda media, secundario). Loop trae Planta, Cliente,
Proyecto, Obra, Localidad, Provincia. Permite ver qué obra sale cara en combustible.

### Ya está hecho — no volver a plantearlo

- **Mail de reclamo único y agrupado.** Botón "Guardar y sumar al reclamo único": junta todos los
  reclamos abiertos, **los agrupa por motivo**, incluye la evidencia medida de cada unidad y abre
  el mail dirigido a `soportewara@waragps.com`.
- **Declarar horas/km estimados**, desde la tarjeta chica y desde la vista de detalle, con rango,
  período y base día/mes/total.
- **Revisar y decidir equipo por equipo**, en todos los hallazgos.
- **Omitir duplicados, convertir formatos, aplicar correcciones guardadas al reimportar.**

## Deployment — and why `git commit` is not a local-only action here

Vercel, connected to this GitHub repo (Git integration — pushing to `main` deploys
automatically, no `vercel.json` needed). GitHub Pages will not work: it can't run `api/chat.js`.
Required env vars in Vercel: `ANTHROPIC_API_KEY`, `APP_SHARED_SECRET`; optional:
`ANTHROPIC_MODEL`, `ANTHROPIC_MAX_WEB_SEARCHES`.

**There is a `post-commit` hook installed in `.git/hooks/` that auto-pushes to `origin main`
after every successful commit** (and runs `git gc --auto`, logging to
`.git/post-commit-sync.log`). Combined with the Vercel Git integration, that makes any commit on
`main` a production deploy: commit → push → deploy, with no further confirmation. Two
consequences worth internalizing:

- `git push` reporting "Everything up-to-date" right after you commit does **not** mean the push
  failed — the hook already did it. Verify with `git ls-remote origin refs/heads/main` (asks the
  server) rather than trusting the local ref.
- Don't commit half-finished work "just to save it". There is no staging environment between
  the commit and the live app.

The hook never force-pushes and leaves the commit intact if the push is rejected; it only warns
in its log. Remove it by deleting `.git/hooks/post-commit`.
