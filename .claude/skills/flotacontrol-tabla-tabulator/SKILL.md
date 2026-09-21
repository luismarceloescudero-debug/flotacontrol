---
name: flotacontrol-tabla-tabulator
description: >
  Aplicar cuando se trabaje en js/ui/datatable.js o se migre alguna tabla a Tabulator.
  Contiene lo que Tabulator NO hace y hay que portar a mano.
---

## Qué es "de negocio" y hay que preservar

De las ~2000 líneas de `datatable.js`, ~30% es presentación de tabla (eso lo hace
Tabulator) y ~70% es lógica que Tabulator no sabe nada:

1. **Panel de corrección inline** (`buildCorrecionRow` + `conectarPanelCorreccion`):
   - Ranking de candidatos por score (mismo CC +2, mismo lugar +3, ya cargó ese día -3).
   - Detección de hermanos por dominio (checkbox "aplicar a todos los del mismo dominio").
   - Botón "Deshacer corrección" que restaura el estado original.
2. **Detección de huérfanas** (`esHuerfanaDe`): usa `resolverEquipo` + `indexarMaestro`,
   no `interno_key` solo.
3. **Filtros por tipo de problema** (`estado.filtroCorrec`): sin_valorizar, repetidas,
   no_habil, corregidas, sin_asignar. Son URLs desde el panel de diagnóstico.
4. **Selección masiva por registro** (no por interno) en cargas, con acciones que
   persisten correcciones por huella (`saveCorreccionCarga`).
5. **Renombrado de columnas** de movimientos con persistencia en `colLabelsMov`.

## Patrón de migración

Migrar UNA vista por vez, empezando por "Movimientos genéricos" (cubiertas, filtros,
insumos), donde el 70% de arriba no aplica. Esa migración es la de menor riesgo.

Después: "Cargas". Ahí sí hay que portar el panel de corrección completo.

Últimas: "Maestro", "Estimados", "Consumo Real". Tienen menos lógica custom.

## Lo que Tabulator hace por nosotros (borrar del código)

- Ordenamiento por click → `headerSort: true`.
- Filtros por columna → `headerFilter: 'input'`.
- Reordenamiento de columnas → `movableColumns: true`.
- Redimensionar columnas → `resizableColumns: true`.
- Selección múltiple → `selectableRows: true`.
- Paginación → `pagination: 'local'` con `paginationSize: 300`.
- Exportación → `table.download('xlsx', ...)`.
- Edición inline → `editor: 'input'` o `editor: 'number'`.
- Escape de HTML → Tabulator lo hace por defecto, no necesitamos `esc()` en el cell template.