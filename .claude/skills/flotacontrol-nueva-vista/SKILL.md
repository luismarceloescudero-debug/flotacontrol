---
name: flotacontrol-nueva-vista
description: >
  Aplicar cuando se cree un archivo nuevo en js/ui/ o se agregue una pestaña al panel.
  Contiene el patrón obligatorio para que la vista se integre sin duplicar lógica.
---

## Estructura obligatoria de una vista nueva

1. **Un archivo en `js/ui/`** que exporta una función `renderXxx(container, analisis)`.
2. **Registrar en `app.js`** como una entrada de navegación.
3. **Copiar el helper `esc()`** al inicio (no importarlo — la convención del proyecto
   es duplicarlo, ver CLAUDE.md sección "XSS convention").
4. **Registrar cada cálculo** con `registrarCalculo(id, { titulo, valor, pasos, fuentes, acciones })`
   si el número va a ser clickeable. Nunca un número sin sus pasos a la vista.
5. **Publicar `window.renderXxx`** si tiene que ser abrible desde el panel de diagnóstico.
6. **Agregar un grupo al arnés `auditar-declarados.mjs`** si la vista tiene lógica pura
   (mediana, cobertura, agregación) que se pueda probar sin Excel ni IndexedDB.

## Qué NO hacer en una vista nueva

- **No importar `database.js` directamente** si se puede pasar `analisis` como parámetro.
  La vista debe poder construirse con datos ya procesados — eso permite probarla.
- **No reimplementar `mediana()`, `coberturaEquipo()`, `utilizacion()`, `confiabilidad()`**.
  Importarlas de `diagnostico.js` (invariante 2).
- **No agregar almacenamiento propio** salvo que la vista sea el dueño natural del dato.
  Si la vista necesita persistencia, se agrega un store en `database.js` con su comentario
  de versión (v15, v16, ...) y una justificación escrita.