# PLAN MAESTRO — FlotaControl, roadmap de mejora y cierre

Fecha: 14/09/2026
Estado actual: pipeline estable (los 3 arneses en verde), 20 hallazgos, invariantes congelados.
Base técnica: 100% browser, ES modules, sin build step, sin framework. IndexedDB crudo.

## Principio rector

Este plan NO reescribe la capa de persistencia ni el core de cálculo. Esos funcionan y están
cubiertos por 3 arneses (`auditar-declarados`, `verificar-datos-reales`, `auditar-calculos`).
La app se mejora en las capas que hoy NO tienen red de seguridad y donde el usuario ya reportó
fricción: la tabla de Base de Datos, la visualización del panel, y las reglas de negocio que
todavía viven en la cabeza del operador (ítems 9–11 del roadmap original).

La lección de Dexie (14/09/2026): "un fix estructural no vale si rompe la migración
incremental o supera el beneficio medido". Se aplica a todo lo que sigue.

---

## Parte 1 — Repos a incorporar (por orden de impacto)

Cada repo entra como vendorizado (archivo único, sin npm, sin build step), respetando la regla
de oro del `package.json`: **NO agregar `"type": "module"`**.

### 1. Tabulator (~6.5k estrellas, MIT) — https://github.com/olifolkerd/tabulator

**Qué resuelve:** el ítem 12 del roadmap original ("tablas totalmente editables") casi por completo.

**Qué aporta hoy que ya existe en el código:** edición celda por celda y borrado de fila — ambas
ya funcionan.

**Qué aporta NUEVO:**
- Mover columnas de lugar arrastrando.
- Renombrar encabezados sin código a medida.
- Filtros por columna sin escribir HTML.
- Ordenamiento por click.
- Paginación virtual (más eficiente que la paginación a mano actual).
- Selección múltiple nativa.
- Exportación a Excel/CSV/PDF integrada.

**Cómo entra:** `vendor\tabulator.mjs` bajado de `https://unpkg.com/tabulator-tables@6/dist/js/tabulator_esm.mjs`.
Se usa SOLO en `datatable.js`, y de a poco: primero la pestaña "Movimientos" de cargas (donde
el 70% de la lógica actual es cosmético), después el resto si funciona.

**Costo estimado:** 1 semana de trabajo para migrar las 4 vistas de `datatable.js`, sin tocar
`panel.js`, `analyzer.js` ni `diagnostico.js`.

### 2. Chart.js (~64k estrellas, MIT) — https://github.com/chartjs/Chart.js

**Qué resuelve:** los ítems 9, 10 y 11 del roadmap original, que hoy son tablas que el usuario
tuvo que pedir en formato visual.

**Qué aporta:**
- Gráfico de líneas para la banda ciclo/motor de Loop (ítem 9).
- Scatter con mediana para L/m³ por mixer (ítem 10).
- Barras por chofer para consumo comparado (ítem 11).

**Cómo entra:** `vendor\chart.mjs` bajado de `https://cdn.jsdelivr.net/npm/chart.js@4/+esm`.
Se usa SOLO donde hoy no hay ningún gráfico — no reemplaza ninguna tabla.

**Costo estimado:** 2-3 días por ítem, una vez que los datos están calculados (ya lo están).

### 3. NO se incorpora nada más

Anthropic tiene skills oficiales, pero no resuelven problemas concretos de FlotaControl. Alpine,
Lit, Vue, React — descartados. La app es imperativa y esa decisión ya está tomada.

---

## Parte 2 — Habilidades (skills) a crear para Claude Code

Una habilidad (skill) es una carpeta con un `SKILL.md` + recursos, que Claude Code carga cuando
la tarea coincide. No es un framework, no es código de producción: es un contexto persistente
para que Claude trabaje con las reglas del proyecto sin tener que re-descubrirlas.

Ubicación: `.claude/skills/<nombre-skill>/SKILL.md`

### Skill 1: `flotacontrol-reglas-negocio`

**Para qué sirve:** codifica las 3 invariantes del `CLAUDE.md` + las decisiones cerradas del
roadmap (14 reglas), para que ninguna futura sesión de Claude las viole por accidente.

**Contenido del SKILL.md:**

```markdown
---
name: flotacontrol-reglas-negocio
description: >
  Aplicar cuando se toque cualquier cálculo, agregación, hallazgo o corrección automática
  en FlotaControl. Contiene las invariantes que ningún cambio puede violar.
---

## Invariantes (ver CLAUDE.md "Three invariants that keep the numbers honest")

1. **Mismo período en los dos lados de una razón.** `consumo_real = litros_alineados ÷
   actividad_alineada`. `calcularExceso()` también compara litros vs actividad del MISMO
   tramo. Nunca total_litros vs horas de solo los meses con GPS.
1b. **KPI = Σ tarjetas + sin_asignar.** Cualquier huérfano aporta litros, km Y horas, no
   solo litros. Cualquier nuevo total necesita su `totales.sin_asignar` y su paso en la
   trazabilidad del KPI.
2. **Una definición por concepto.** `mediana()` se importa, no se reimplementa.
   `coberturaEquipo()` es la única fuente de cobertura. `utilizacion()` es la única de
   horas/día hábil. `JORNADA_REFERENCIA` es la única referencia de jornada.
3. **Un número bajo necesita contexto antes de ser conclusión.** Toda métrica que sea
   una razón (L/día, km/hora, $/carga) lleva `esTasa: true` y se marca "⚠ base floja"
   cuando `confiabilidad()` dice que no se sostiene. Los totales no se marcan.

## Decisiones cerradas (ver CLAUDE.md roadmap, no volver a discutir)

- INTERNO SIN DOMINIO y DOMINIO SIN INTERNO **no son errores**. Nunca advertencia.
- Faltar un mes **no es error**. Se analiza la intersección de meses.
- Subir 3 meses o el año completo **no es error**. El cálculo declara el período.
- Los km de Loop **nunca** son denominador de consumo (miden viaje cargado, no recorrido).
- Solo se autocorrigen códigos **CON litros** en la planilla de Cargas. Un código sin litros
  ni km ni horas se descarta.
- "Posible repetida" **no es un hallazgo**. Solo el duplicado exacto tiene corrección obvia.
- Los remitos de Loop en conflicto **no son parte del análisis de combustible**.
- Dar de alta un equipo nuevo **es la normalidad**, no un aviso.
- Odómetro y horómetro de Wara **quedan fuera del alcance**.
- El cruce con Informe de Ignición **está eliminado**.
- `Informe Volumen entregado por camión` **es solo control de totales**, no fuente nueva.

## Reglas de escaping (XSS)

`const esc = (s) => ...` está duplicado verbatim en panel.js, datatable.js, modals.js,
comparativa.js, metas.js, seguimiento.js, upload.js, calcpopover.js, diagnostico.js.
Cuando se agrega un archivo nuevo que arma innerHTML desde datos del usuario, se COPIA
el mismo helper. Se escapa en el punto donde el dato entra — no el template entero.
En `diagnostico.js` específicamente: los `<strong>` literales quedan, solo los valores
interpolados pasan por `esc()`.

## Verificación

Antes de commitear algo en `js/data/` o `js/parsers/`:
1. `node tools/auditar-declarados.mjs` — <1s, falla rápido.
2. `node tools/verificar-datos-reales.mjs` — 4-6 min, la red de seguridad real.
3. `node tools/auditar-calculos.mjs` — 5-8 min, coherencia de fórmulas.

Un bug de persistencia rompe (2). Un bug de fórmula rompe (3). Un bug de función pura rompe (1).
Ninguno subsuma a los otros.