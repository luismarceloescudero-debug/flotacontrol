---
name: ciclo-de-entrega
description: Ciclo completo de entrega de FlotaControl — revisar, arreglar, testear, verificar en el navegador, auditar seguridad y publicar a producción sin pedir confirmación. Usar SIEMPRE que el pedido sea "arreglá esto", "revisá el repo", "testeá", "subilo", "actualizá el repo", "mejorá X", "seguí con el plan", o cualquier reporte de bug o pedido de cambio sobre la app. También al retomar trabajo después de una interrupción, para saber qué quedó a medias. No usar para preguntas que solo piden leer o explicar algo sin tocar código.
---

# Ciclo de entrega — de un pedido a producción, sin preguntar

En este repo, `git commit` **es un deploy**: hay un hook `post-commit` que pushea a `origin main`
y Vercel publica. No hay staging entre el commit y la app real.

Eso obliga a mover la confirmación a otro lado. En vez de preguntarle al usuario "¿lo subo?"
—que es una pregunta que él no puede contestar mejor que la evidencia— **el permiso lo dan los
arneses y la verificación en el navegador**. Si están verdes, se sube. Si no, no se sube y se
dice por qué. Preguntar cuando la evidencia ya decidió es hacerle perder el tiempo; subir sin
esa evidencia es romperle la producción.

Todo lo de abajo existe porque falló al menos una vez.

## Antes de tocar nada

Retomá el estado real, no el recordado. Una sesión puede haberse cortado a la mitad:

```bash
git status --short && git log --oneline -3 && git ls-remote origin refs/heads/main
```

Si hay cambios sin commitear, son trabajo previo: leelos antes de escribir encima. Si el remoto
está adelante del local, alguien más publicó.

**Si el cambio toca un número** —litros, km, horas, m³, consumos, metas, desvíos, costos, o una
regla de diagnóstico— cargá primero la skill `calculos-combustible`. No es opcional: ahí están
las reglas de período común, de qué sirve cada planilla y de qué nunca se hace. Un cálculo mal
hecho igual corre e igual imprime un número creíble.

## Los tres arneses

```bash
npm run declarados   # ~1 s   · funciones puras, sin Excel ni IndexedDB
npm run verificar    # minutos · pipeline real vs tools/invariantes.json
npm run auditar      # minutos · ~3.300 chequeos de coherencia interna
npm run probar       # los tres, en ese orden
```

Corré `declarados` primero siempre: es instantáneo y falla antes. Los otros dos tardan varios
minutos y eso es `fake-indexeddb`, no la app — no los "optimices".

**Obligatorios antes de commitear si tocaste `js/data/` o `js/parsers/`.** Si solo tocaste UI
(`js/ui/`, `styles/`) alcanza con `declarados` más la verificación en el navegador, porque los
arneses lentos no ejercitan la UI.

Si `verificar` falla por números que cambiaron **a propósito**, `npm run verificar:actualizar`
fija los nuevos. Antes de hacerlo, mirá la diferencia y convencete de que la explicás: ese
archivo es la única red que detecta un cambio silencioso.

## Verificar en el navegador

Los arneses no ven la UI. Todo lo que se renderiza se prueba corriendo la app.

```
preview_start { name: "flotacontrol" }
```

Después, **bustear el caché de módulos antes de cargar datos**. Esto no es opcional y es la
trampa más cara de este repo: `python -m http.server` no manda `Cache-Control`, el Browser pane
proxea todo por un mismo origen (así que el truco del puerto distinto no sirve), y el navegador
te sirve el módulo viejo. El síntoma engaña: los Excel parsean bien —se ven los `[CARGAS] … 4511
filas` en consola— pero el panel no renderiza y la consola tira `does not provide an export
named 'X'`.

```js
for (const m of ['/js/app.js','/js/data/database.js','/js/data/diagnostico.js',
                 '/js/data/analyzer.js','/js/ui/panel.js','/js/ui/datatable.js',
                 '/js/ui/comparativa.js','/index.html']) {
    try { await fetch(m, { cache: 'reload' }); } catch (e) {}   // 'reload' ignora el caché Y lo actualiza
}
location.reload();
```

Pedí de a pocos archivos por vez: una ráfaga de 20 fetch en paralelo tira
`ERR_INSUFFICIENT_RESOURCES` y te deja creyendo que el error es de la app.

Cargar las planillas reales sin clickear (copialas antes a `_datos_prueba/`, que está
gitignoreado):

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

Tarda 30-60 s según cuántos archivos. Después `window.ultimoAnalisis` tiene el análisis.
**Borrá `_datos_prueba/` al terminar**: son datos de flota.

Si el cambio bumpea `DB_VERSION`, borrá la base antes
(`indexedDB.deleteDatabase('FlotaControlDB')`) — pero **no la abras vos** para inspeccionarla:
un `indexedDB.open()` sin versión crea una base v1 vacía y te deja mirando un estado que
fabricaste vos. Para ver qué versión hay sin tocarla: `await indexedDB.databases()`.

## Qué mirar cuando verificás

No alcanza con "renderiza y no hay errores en consola". Las fallas caras de este repo pasaron
todas esa prueba:

- **Los números, contra el dato crudo.** Si la pantalla dice "3,11 L/día", reconstruí la
  división desde `window.ultimoAnalisis` y confirmá que da eso. Una fórmula mal escrita imprime
  un número plausible.
- **El caso desparejo, no el normal.** Dos equipos con el mismo período nunca muestran un error
  de denominador. Buscá el par más desigual que exista en los datos reales —el que tiene 1 carga
  contra el que tiene 169— y probá con ese. Así apareció un error de 7,8× que un test sintético
  con dos equipos parejos dejó pasar.
- **Los totales, después del cambio.** `verificar` compara contra invariantes: si un total se
  movió y no sabés por qué, hay un bug aunque todo lo demás esté verde.
- **La consola, distinguiendo lo viejo de lo nuevo.** El buffer retiene errores de cargas
  anteriores. Si dudás, recargá y mirá si la app arranca (`typeof window.renderPanel ===
  'function'` prueba que el grafo de módulos importó completo).

## Seguridad

Dos escaneos, los dos rápidos:

**1. Interpolación sin escapar en HTML crudo.** El campo `detalle` de cada hallazgo se renderiza
con `innerHTML` a propósito (panel.js, `${h.detalle}` sin `esc()`), para que los hallazgos puedan
poner `<strong>` en los números. Cualquier texto que venga de una planilla y se concatene ahí
tiene que pasar por `esc()` primero. Los campos `texto` y `sub` **sí** se escapan al renderizar,
así que no son vector — conviene saberlo para no perseguir falsos positivos.

```bash
grep -nE '\$\{[^}]*(marca|modelo|centro_costo|chofer|lugar|obra|cliente|planta|combustible|dominio)[^}]*\}' js/data/diagnostico.js | grep -v 'esc('
```

**2. Claves y comparaciones de identidad.**

```bash
grep -rnE "sk-ant|api[_-]?key\s*[:=]\s*['\"][A-Za-z0-9_-]{20,}" --include="*.js" .
grep -rnE "\.(interno|dominio)\s*===\s*[a-zA-Z_$][\w$]*\.(interno|dominio)" js/ --include="*.js" | grep -v "_key"
```

El segundo busca cruces por igualdad de string en vez de `normalizeEquipoKey()` — la clase de bug
más repetida en la historia de este repo. Lo esperable es cero.

Lo que **no** es un hallazgo nuevo: `APP_SECRET_VALUE` viaja en el JS del navegador. Está
documentado como anti-scraping, no como autenticación, y la falta de rate limiting en
`/api/chat` es deuda conocida y aceptada. No lo reportes como si fuera un descubrimiento.

## Publicar

Cuando los arneses que correspondan están verdes y la verificación en el navegador confirmó el
comportamiento, **commiteá sin preguntar**. El commit pushea y deploya solo.

Antes de commitear, mirá qué estás incluyendo:

```bash
git status --short          # ¿quedó _datos_prueba/ o algún .xlsx?
git diff --stat
```

Nunca commitees planillas de flota. Están gitignoreadas por patrón, pero un nombre nuevo puede
escaparse.

El mensaje de commit tiene que servirle a alguien que abra este archivo dentro de seis meses:
qué cambió, **por qué**, y qué evidencia lo respalda. Si arreglaste un bug, decí cuánto medía el
error y cómo lo encontraste — eso es lo que evita que vuelva.

```
área: qué cambió en una línea

El problema concreto que había, con el número que lo prueba.
La decisión de diseño y por qué esa y no la obvia.

Verificado en el navegador con las planillas reales: <lo que se comprobó>.
Arneses: N + M chequeos, invariantes sin cambios.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Después confirmá que el push salió de verdad — el hook puede fallar en silencio:

```bash
git ls-remote origin refs/heads/main
```

`git push` diciendo "Everything up-to-date" justo después de commitear **no** significa que
falló: el hook ya lo hizo.

## Cuándo sí frenar y preguntar

La autonomía es para ejecutar, no para decidir por el usuario. Frená cuando:

- **Una invariante o decisión cerrada del CLAUDE.md sale perdiendo** con el cambio pedido. Ahí no
  hay que elegir por él: mostrale la contradicción y que decida.
- **Hay que actualizar `invariantes.json` y no podés explicar la diferencia.** Fijar un número
  que no entendés convierte la red de seguridad en un sello de goma.
- **La única forma de hacer pasar un test es debilitarlo.** Eso no es arreglar.
- **El pedido implica borrar datos del usuario** — cargas, correcciones guardadas, el maestro.
- **Los arneses quedan rojos y no sabés por qué.** No se publica a ciegas.

Fuera de esos casos, avanzá. "¿Querés que lo suba?" después de que todo pasó no es prudencia:
es devolverle al usuario una decisión que la evidencia ya tomó.

## Dejar el terreno mejor

Dos cosas valen tanto como el arreglo:

**Un chequeo que atrape la regresión.** Si el bug no lo agarró ningún arnés, el arnés tenía un
hueco. Agregá el caso a `tools/auditar-declarados.mjs` —que es instantáneo y no necesita Excel—
con un comentario que diga qué error concreto existe para atrapar. Un test sin esa explicación
se borra la primera vez que molesta.

**El CLAUDE.md al día.** Es la memoria del proyecto entre sesiones. Cuando midas algo —cuánto
daba el error, cuántas filas afectaba, qué par de equipos lo reproduce— escribilo ahí con el
número. Una afirmación sobre los datos que no se verificó corriendo los archivos no se escribe:
si no se midió, no se afirma.
