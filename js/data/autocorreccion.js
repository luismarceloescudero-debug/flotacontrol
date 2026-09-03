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
import { normalizeEquipoKey, clasificarIdentificador, getPrefijo } from './normalizer.js';
import {
    upsertEquipos, setNoFlotaAceptado, updateEquipo, registrarEdicion, registrarAccionAutomatica
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
 * @returns {{altas: number, aceptados: number, metas: number}}
 */
export async function aplicarCorreccionesAutomaticas({ equipos = [], huerfanos = [], filas = [], codigosAceptados = new Set() }) {
    const resultado = { altas: 0, aceptados: 0, metas: 0 };
    const internosExistentes = new Set(equipos.map(e => normalizeEquipoKey(e.interno)));

    for (const h of huerfanos) {
        if (codigosAceptados.has(h.interno)) continue; // ya resuelto en una pasada anterior
        const clas = clasificarIdentificador(h.interno);

        if (clas.tipo === 'interno' && PREFIJOS_CALCULABLES.has(getPrefijo(clas.valor))) {
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
        } else if (clas.tipo === 'desconocido' || clas.tipo === 'vacio') {
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
