/**
 * Diagnóstico automático que se resuelve solo — no todo termina en una lista para que alguien
 * la procese a mano. Dos categorías, las únicas donde el siguiente paso es inequívoco:
 *
 * 1. Cargas huérfanas (sin equipo en el maestro): si el código tiene forma de interno válida Y
 *    la app sabe calcularle algo (su prefijo tiene una regla de L/100km, L/hora o "sin tanque"
 *    — ver PREFIJOS_CALCULABLES abajo), es un equipo real que falta dar de alta y se da de alta
 *    solo. Si el código no tiene forma de interno NI de patente (no hay nada más que
 *    determinar), se acepta como "así está bien" para dejar de repreguntarlo cada sesión. Dos
 *    casos quedan para revisión manual, sin tocar: una patente real sin interno en el padrón
 *    (requiere saber a mano de qué equipo se trata — ver clasificarNoFlota en diagnostico.js),
 *    y un código con forma de interno pero un prefijo que la app no sabe calcular (ver abajo).
 * 2. Metas vacías: un equipo sin meta cargada pero con consumo real medible y confiable se
 *    alinea a su propio consumo real la primera vez, en vez de quedar "sin meta" indefinidamente.
 *    No se marca `editado_manual` a propósito: si más adelante se importa el valor de fábrica
 *    real en "Consumos Estimados", tiene que poder pisar esta alineación automática sin que
 *    nadie tenga que ir a destildar nada primero.
 *
 * Cada acción se aplica directamente (no pide confirmación previa — eso volvería todo manual
 * otra vez) y queda anotada en `accionesAutomaticas` para poder revisarla o deshacerla después.
 */
import { normalizeEquipoKey, clasificarIdentificador, getPrefijo, sugerirPosibleTypo } from './normalizer.js';
import {
    upsertEquipos, setNoFlotaAceptado, quitarNoFlotaAceptado, updateEquipo, deleteEquipo,
    registrarEdicion, registrarAccionAutomatica, marcarAccionDeshecha, getAllEquipos
} from './database.js';
import { metaDesdeConsumoReal } from './diagnostico.js';
import { RULE_L_100KM, RULE_L_HORA, RULE_NO_TANK } from './analyzer.js';

// Prefijos que la app sabe calcular (tienen una regla de L/100km, L/hora, o "sin tanque"
// declarada — ver analyzer.js). Un código con forma de interno válida pero un prefijo AFUERA
// de estas tres listas no se da de alta solo: verificado contra datos reales, "CA" (CALDERA) y
// "LM" (LIMPIEZA) están en TIPO_POR_PREFIJO —tienen nombre y son gasto real— pero en NINGUNA
// regla de cálculo, así que un alta automática los dejaría con "tipo_calculo" sin resolver, una
// tarjeta rota, en vez de la clasificación como gasto de planta que clasificarNoFlota() ya les
// da. "Tiene forma de interno" no es lo mismo que "es un equipo que la app sabe medir": onboardear
// a ciegas por forma solamente cambiaba un huérfano explicado por un equipo roto sin explicar.
const PREFIJOS_CALCULABLES = new Set([...RULE_L_100KM, ...RULE_L_HORA, ...RULE_NO_TANK]);

/**
 * @param {Array} equipos         maestro actual (para saber qué internos ya existen)
 * @param {Array} huerfanos       totales.huerfanos de analizarFlota()
 * @param {Array} filas           filas de analizarFlota() (equipo + metrics + confirmed)
 * @param {Set}   codigosAceptados  códigos ya marcados "así está bien" (noFlotaAceptados)
 * @param {Array} accionesPrevias  accionesAutomaticas ya registradas (para no repetir una que
 *                                 alguien deshizo a mano — ver marcarAccionDeshecha)
 * @returns {{altas: number, aceptados: number, metas: number}}
 */
export async function aplicarCorreccionesAutomaticas({ equipos = [], huerfanos = [], filas = [], codigosAceptados = new Set(), accionesPrevias = [] }) {
    const resultado = { altas: 0, aceptados: 0, metas: 0 };
    const internosExistentes = new Set(equipos.map(e => normalizeEquipoKey(e.interno)));
    // Una acción deshecha a mano NO se vuelve a aplicar aunque las condiciones que la
    // dispararon sigan iguales — si no, "Deshacer" no duraría ni hasta el próximo render.
    const deshechas = new Set(accionesPrevias.filter(a => a.deshecha).map(a => `${a.tipo}|${a.codigo}`));

    // Internos reales del maestro TAL COMO ESTÁN (no la clave normalizada): sugerirPosibleTypo
    // normaliza los dos lados internamente, y necesita el valor original para poder devolverlo
    // como sugerencia legible.
    const internosReales = equipos.map(e => e.interno).filter(Boolean);

    for (const h of huerfanos) {
        if (codigosAceptados.has(h.interno)) continue; // ya resuelto en una pasada anterior
        // Si no tiene litros reales en la planilla de Cargas, no se auto-da de alta ni acepta:
        // puede ser un código que solo aparece en GPS/Loop y no corresponde a nuestra flota.
        if (!h.litros || h.litros <= 0) continue;
        const clas = clasificarIdentificador(h.interno);

        // Un código a un solo tipeo de un interno real (ver GR01 vs GE01, el caso que motivó
        // esto) no se toca en absoluto: ni se da de alta como equipo nuevo, ni se acepta como
        // "así está bien" — las dos acciones estarían adivinando en vez de confirmar contra el
        // comprobante. Queda como huérfano común; generarDiagnostico() lo señala aparte con la
        // sugerencia, para que se corrija a mano desde "Corregir" en Base de Datos.
        if (sugerirPosibleTypo(h.interno, internosReales)) continue;

        if (clas.tipo === 'interno' && PREFIJOS_CALCULABLES.has(getPrefijo(clas.valor)) && !deshechas.has(`alta_interno|${clas.valor}`)) {
            const key = normalizeEquipoKey(clas.valor);
            if (internosExistentes.has(key)) continue; // ya se dio de alta (misma sesión u otra)
            await upsertEquipos([{
                interno: clas.valor, dominio: h.dominio || '',
                alta_automatica: true, fecha_alta_automatica: new Date().toISOString()
            }]);
            internosExistentes.add(key);
            await registrarAccionAutomatica({
                tipo: 'alta_interno', codigo: clas.valor,
                motivo: 'Código con forma de interno válida, sin fila en el maestro — se dio de alta como equipo nuevo.',
                detalle: `${h.cargas} carga${h.cargas === 1 ? '' : 's'} · ${h.litros.toFixed(1)} L${h.dominio ? ` · dominio ${h.dominio}` : ''}`
            });
            resultado.altas++;
        } else if ((clas.tipo === 'desconocido' || clas.tipo === 'vacio') && !deshechas.has(`aceptado_no_flota|${h.interno}`)) {
            await setNoFlotaAceptado(h.interno, 'Sin forma de interno ni de patente — aceptado automáticamente, no hay más dato para resolverlo.');
            await registrarAccionAutomatica({
                tipo: 'aceptado_no_flota', codigo: h.interno,
                motivo: 'No se pudo identificar como interno ni como patente.',
                detalle: `${h.cargas} carga${h.cargas === 1 ? '' : 's'} · ${h.litros.toFixed(1)} L`
            });
            resultado.aceptados++;
        }
        // clas.tipo === 'dominio': patente real sin interno en el padrón — se necesita saber a
        // mano de qué equipo se trata. Queda para revisión manual, sin tocar.
    }

    const maestroPorInterno = new Map(equipos.map(e => [e.interno, e]));
    for (const f of filas) {
        if (f.confirmed) continue; // ya tiene meta (de fábrica, o ya alineada antes)
        if (!['L/Hora', 'L/100Km'].includes(f.metrics.tipo_calculo)) continue;
        if (deshechas.has(`meta_alineada|${f.equipo.interno}`)) continue;
        const sug = metaDesdeConsumoReal(f);
        if (!sug || !sug.confiable) continue;

        // Se parte del registro CRUDO del maestro (no de f.equipo, que ya trae la denominación
        // de respaldo calculada) para no terminar grabando en la base un campo que el equipo
        // nunca tuvo — mismo cuidado que usa el ajuste masivo de metas.js.
        const base = maestroPorInterno.get(f.equipo.interno);
        if (!base) continue;
        const eq = { ...base };
        const unidadTexto = f.metrics.tipo_calculo === 'L/Hora' ? 'L/hora' : 'L/100km';
        eq.meta_valor = sug.valor;
        eq.meta_unidad = f.metrics.tipo_calculo;
        eq.meta_texto = `${sug.valor} ${unidadTexto}`;
        eq.meta_origen = `${sug.base} (alineada automáticamente la primera vez)`;
        eq.meta_auto_alineada = true;
        await updateEquipo(eq);
        await registrarEdicion({
            tabla: 'maestro', registroId: eq.interno, etiqueta: eq.interno,
            campo: 'meta_valor', valorAnterior: '', valorNuevo: `${eq.meta_texto} (automática)`
        });
        await registrarAccionAutomatica({
            tipo: 'meta_alineada', codigo: eq.interno,
            motivo: 'Sin meta cargada: se alineó a su propio consumo real medido.',
            detalle: `${eq.meta_texto} · ${sug.base}`
        });
        resultado.metas++;
    }

    return resultado;
}

/**
 * Deshace una acción automática puntual — revierte el dato Y marca la acción como deshecha
 * (marcarAccionDeshecha), para que aplicarCorreccionesAutomaticas() no la vuelva a aplicar en
 * el próximo render con las mismas condiciones. Nunca borra a ciegas: si el equipo dado de alta
 * ya se editó a mano después (`editado_manual` tiene algo), o la meta ya no es la que puso la
 * alineación automática (alguien la reemplazó desde "Ajustar metas" o reimportando Consumos
 * Estimados), se deja el dato tal cual y solo se marca la acción como deshecha — no tiene
 * sentido destruir un trabajo posterior de la persona para "deshacer" algo que la app ya dejó
 * de sostener sola.
 *
 * @param {Object} accion   fila de accionesAutomaticas (id, tipo, codigo)
 * @returns {{revertido: boolean, motivo: string}}
 */
export async function deshacerAccionAutomatica(accion) {
    const { id, tipo, codigo } = accion;
    let revertido = false, motivo = '';

    if (tipo === 'alta_interno') {
        const actual = (await getAllEquipos()).find(e => e.interno === codigo);
        if (!actual) { motivo = 'El equipo ya no existe en el maestro.'; }
        else if (actual.editado_manual && actual.editado_manual.length) {
            motivo = `No se borró: el equipo ya se editó a mano (${actual.editado_manual.join(', ')}) después del alta automática. La acción queda marcada como deshecha, pero el equipo se conserva.`;
        } else {
            await deleteEquipo(codigo);
            revertido = true; motivo = 'Equipo borrado del maestro.';
        }
    } else if (tipo === 'aceptado_no_flota') {
        await quitarNoFlotaAceptado(codigo);
        revertido = true; motivo = 'Código destildado de "así está bien".';
    } else if (tipo === 'meta_alineada') {
        const actual = (await getAllEquipos()).find(e => e.interno === codigo);
        if (!actual) { motivo = 'El equipo ya no existe en el maestro.'; }
        else if (!actual.meta_auto_alineada) {
            motivo = 'La meta ya no es la que puso la alineación automática (se reemplazó desde otro lado) — no hay nada que revertir.';
        } else {
            await updateEquipo({ ...actual, meta_valor: 0, meta_unidad: '', meta_texto: '', meta_origen: '', meta_auto_alineada: false });
            revertido = true; motivo = 'Meta vaciada, vuelve a quedar "sin meta".';
        }
    }

    await marcarAccionDeshecha(id);
    return { revertido, motivo };
}
