---
name: flotacontrol-graficos
description: >
  Aplicar cuando se agregue cualquier visualización con Chart.js en FlotaControl.
  Define el estilo consistente con el resto del panel y qué métricas ameritan gráfico.
---

## Cuándo usar gráfico (y cuándo no)

**Sí amerita gráfico:**
- Serie temporal por equipo (ralentí mes a mes de MX100).
- Comparación multi-equipo con banda (mediana ± rango de pares).
- Distribución (L/m³ de los 25 mixers en un scatter con la mediana como línea).

**NO amerita gráfico:**
- Un solo número (es un KPI, no un gráfico).
- Datos sin contexto de referencia (un valor sin su banda es un punto solo).

## Qué colores usar (respetar el CSS de la app)

- Verde (`--accent-green`): dentro de la meta, cobertura OK.
- Ámbar (`--accent-amber`): atención, base floja.
- Rojo (`--accent-red`): sobreconsumo, error.
- Cian (`--accent-cyan`): ahorro, valor destacado.
- Gris (`--text-muted`): sin datos, referencia.

No agregar colores nuevos sin coordinarlos con `styles/`.

## Patrones por ítem del roadmap

**Ítem 9 — Banda ciclo/motor de Loop:**
Gráfico de líneas. X = mes, Y = % (Loop/Wara). Una serie por equipo. Línea horizontal en
la mediana del grupo (45%). Puntos fuera de la banda ±20% en rojo.

**Ítem 10 — L/m³ por mixer:**
Scatter. X = m³ entregados, Y = L consumidos. Línea de tendencia obligatoria (pendiente
= L/m³ promedio). Equipos con < 10 entregas en gris tenue (base floja).

**Ítem 11 — Consumo por chofer:**
Barras horizontales. Y = chofer (ordenado de mayor a menor consumo). X = L/100km.
Un grupo de barras por equipo si el chofer cambió de equipo en el período.