---
name: calculos-combustible
description: Reglas de cálculo de consumo de combustible de FlotaControl. Usar SIEMPRE antes de escribir, cambiar o revisar cualquier código que calcule, agregue, promedie o compare litros, kilómetros, horas, m³, consumos, metas, desvíos o costos — y antes de agregar una métrica nueva o una regla de diagnóstico. También al interpretar un número que la app ya muestra, o al responder "¿por qué da esto?". No usar para cambios de estilo, texto o layout que no toquen una cifra.
---

# Cálculos de combustible — reglas que no se negocian

Un cálculo mal hecho igual corre e igual imprime un número creíble. Por eso estas reglas no se
razonan de nuevo cada vez: se aplican.

## 1. Período común, siempre

Toda razón (consumo, rendimiento, desvío) divide una cantidad por una actividad. **Las dos partes
tienen que venir de los mismos meses.**

- El período de análisis de un equipo es la **intersección** de los meses que tiene en cada fuente
  que interviene en ese cálculo. No la unión, no el máximo, no "lo que haya".
- Si una fuente cubre meses que la otra no cubre, esos meses **salen del cálculo**, no se prorratean.
  Prorratear inventa actividad que nadie midió.
- Un reporte multi-mes entra **entero o no entra**. No se puede partir un "Ene–Jul" para atribuirlo
  a un mes.
- `alinearCargasYGps()` en `js/data/analyzer.js` ya hace esto. Cualquier métrica nueva pasa por ahí
  o replica la regla; no se compara contra totales de período completo.

**No se le informa al usuario "falta el mes X".** Se calcula sobre el período común y se **declara
cuál es**: "consumo de mar–jun (4 meses comunes entre cargas y GPS)". El período es parte del
resultado, no una advertencia aparte.

**Trampa conocida:** el campo `periodo` de un registro es solo el mes de su fecha de inicio. Un GPS
Ene–Jul lleva `periodo: '2026-01'` y mide siete meses. Para atribuir un registro a meses se usa
`mesesDeRegistro(r)`. `periodo` solo es seguro en cargas, que son puntuales.

## 2. Todo número que es un resultado muestra sus pasos

Si una cifra salió de una operación, el usuario tiene que poder abrirla y ver:

1. **La fórmula** con nombres, no con símbolos: `litros ÷ km × 100`.
2. **Los valores que entraron**, con sus unidades: `1.494 L ÷ 1.575 km × 100`.
3. **El período** del que salieron esos valores.
4. **El origen**: qué archivo y, cuando se pueda, qué fila.

La fórmula mostrada tiene que **dar exactamente** el número que está al lado. Si no cierra, el bug
está en el cálculo, no en el cartel. `js/ui/calcpopover.js` es el lugar donde vive este patrón.

Un número sin pasos visibles no se publica en la UI.

## 3. Qué se le puede pedir a cada fuente

| Fuente | Sirve para | **No** sirve para |
|---|---|---|
| `Cargas_Combustible_*.xlsx` | litros, costo, precio, chofer, lugar, centro de costo | actividad |
| `Resumen de Flota` (Wara) | km recorridos, horas de ralentí y movimiento | litros (columna existe, viene `n/a`) |
| `Consumos Estimados` | la meta **y la unidad** (L/hora vs L/100km) de cada equipo | consumo real |
| `Equipos HSV` | interno, dominio, marca, modelo | el campo `TIPO` (dice "CAMION" a un tractor). `TQUE COMB` es **cantidad de tanques** (1 o 2), no capacidad en litros |
| Loop `Informe Entregas` | m³ entregados, nº de entregas, planta, obra, ciclo | **kilómetros** (ver abajo) |
| Loop `Exportado de Viajes` | horarios del viaje, parada en obra (solo ene–jun) | volumen, kilómetros |
| Loop `Volumen por camión` | **control de totales** contra el detalle | dato primario (es un agregado) |

**Los km de Loop no se usan nunca como denominador.** Medido contra el GPS en los mismos equipos y
meses: 110.858 km contra 215.658 km, un 51 %. Es distancia de viaje cargado, no recorrido total.
Usarla duplicaría el consumo de toda la flota.

**Horómetro y Odómetro** (aparecen en el export de Wara desde julio 2026) son **acumulados de vida
del equipo**, no del período — hay equipos con 1.343 días de horómetro. Nunca se leen como "horas
del mes". Sirven para mantenimiento por odómetro, no para consumo.

Filas con km `---` o `0` en Wara son **sin medición**, no cero: salen del denominador en lugar de
hundir el promedio. Son el 12 % de las filas equipo-mes.

## 4. Las unidades y cuándo usar cada una

- **L/100km** — métrica principal para lo que se mueve. Variación mes a mes medida: 13 %.
- **L/hora** — para lo que trabaja parado (bombas, generadores, plantas). La unidad la declara
  "Consumos Estimados"; el prefijo del interno es solo el fallback.
- **L/m³** — solo mixers, solo con entregas de Loop del mismo período. Variación medida: 18 %.
  Es **contexto**, no reemplazo: distingue "consume mucho" de "trabajó mucho".

Cuando existen los dos denominadores, se exponen las dos: `consumo_l_hora` y `consumo_l_100km`.
`consumo_real` es la de la unidad declarada del equipo.

Una razón calculada sobre **menos de un mes común** o sobre un equipo con cobertura baja se marca
como no representativa. Un número flojo con una etiqueta honesta es útil; sin la etiqueta, miente.

## 5. Números verificados contra los archivos reales

Si un cambio los mueve sin que se haya tocado esa lógica a propósito, hay un bug:

```
Cargas   4.412 filas · 677.281 L · 0 sin fecha/litros/costo · 101 códigos fuera del maestro
GPS      787 filas equipo-mes · 120 unidades ene–jun · 67 en julio · 12 % sin km usable
Loop     16.812 filas leídas → 7.037 registros · 9.775 fusiones · 6 remitos en conflicto
         55.364,5 m³ (hoja Hormigón; Bombeado y Otros son subconjuntos, aportan 0 remitos)
Resumen Loop  56.386,0 m³ — difiere 1.021,5 m³ del detalle en may–jul, coincide ene–abr
```

## 6. Lo que nunca se hace

- Prorratear actividad a meses sin medición.
- Dividir litros de un período por actividad de otro.
- Comparar dos equipos sobre períodos distintos sin decirlo.
- Cruzar equipos por igualdad de string en vez de `normalizeEquipoKey()`.
- Tratar un `---`, un `n/a` o un vacío como cero.
- Publicar un promedio de la flota sin decir cuántos equipos quedaron adentro y cuántos afuera.
- Escribir en un comentario o en un cartel de la UI una afirmación sobre los datos que no se
  verificó corriendo los archivos. Si no se midió, no se afirma.
