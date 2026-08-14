/**
 * Motor de diagnóstico automático.
 *
 * Genera conclusiones accionables sobre la flota SIN usar ninguna API de IA: todo se calcula
 * a partir de los datos ya cruzados. La ventaja frente a un chatbot no es solo el costo —
 * un cálculo no puede equivocarse en una cifra, siempre está disponible y no depende de que
 * un servicio externo esté pago y en línea.
 *
 * Cada hallazgo tiene: severidad, título, detalle, impacto en pesos (cuando aplica) y la
 * lista de equipos involucrados, para poder actuar sobre ellos.
 */

import { getPrefijo } from './normalizer.js';

const TOLERANCIA = 0.15;        // 15% de margen antes de considerar que un equipo se pasó
const META_SOSPECHOSA_ALTA = 2.5; // real > 2.5x meta  -> la meta probablemente está mal
const META_SOSPECHOSA_BAJA = 0.4; // real < 0.4x meta  -> idem

/**
 * Litros que un equipo "debería" haber consumido según su meta, y el exceso real.
 * Devuelve null si no hay forma de calcularlo (sin meta, sin actividad o sin consumo).
 */
export function calcularExceso(fila) {
    const { metrics: m, confirmed } = fila;
    if (!confirmed || !confirmed.valor || confirmed.valor <= 0) return null;
    if (!m.consumo_real || m.consumo_real <= 0) return null;

    let litrosEsperados;
    if (m.tipo_calculo === 'L/100Km') {
        if (m.total_km <= 0) return null;
        litrosEsperados = (confirmed.valor * m.total_km) / 100;
    } else if (m.tipo_calculo === 'L/Hora') {
        if (m.total_horas <= 0) return null;
        litrosEsperados = confirmed.valor * m.total_horas;
    } else {
        return null;
    }

    const excesoLitros = m.total_litros - litrosEsperados;
    // Precio por litro real de ESTE equipo; si no hay costo cargado, no se estima en pesos.
    const precioLitro = m.total_litros > 0 ? m.total_costo / m.total_litros : 0;

    return {
        litros_esperados: litrosEsperados,
        exceso_litros: excesoLitros,
        exceso_costo: excesoLitros * precioLitro,
        precio_litro: precioLitro
    };
}

const fmt = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

const mediana = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Sugiere una meta de consumo para un equipo a partir del consumo real MEDIDO de sus pares
 * del mismo tipo.
 *
 * Por qué la mediana de la propia flota y no una ficha técnica: el consumo de fábrica se
 * mide en condiciones de ensayo, mientras que estos números salen de las mismas rutas, el
 * mismo ralentí y la misma operación real. Para controlar la flota, un objetivo alcanzable
 * y comparable vale más que un número de catálogo. Se usa la mediana (no el promedio) para
 * que un equipo con una falla no arrastre el objetivo de todo el grupo.
 *
 * @returns {null|{valor, unidad, n, minimo, maximo, base}}
 */
export function sugerirMeta(fila, todasLasFilas = []) {
    const tipo = fila.metrics.tipo_calculo;
    if (tipo !== 'L/Hora' && tipo !== 'L/100Km') return null;

    const pares = todasLasFilas.filter(f =>
        f.equipo.interno !== fila.equipo.interno &&
        f.equipo.denominacion === fila.equipo.denominacion &&
        f.metrics.tipo_calculo === tipo &&
        f.metrics.consumo_real > 0
    );

    // Con menos de 3 pares medidos la mediana no es representativa.
    if (pares.length < 3) return null;

    const valores = pares.map(f => f.metrics.consumo_real);
    const med = mediana(valores);
    if (med <= 0) return null;

    return {
        valor: Math.round(med * 100) / 100,
        unidad: tipo,
        n: pares.length,
        minimo: Math.min(...valores),
        maximo: Math.max(...valores),
        base: `mediana de ${pares.length} ${(fila.equipo.denominacion || 'equipos').toLowerCase()} medidos`
    };
}

/**
 * Produce la lista de hallazgos ordenada por impacto.
 * @param {Array} filas   Salida de analizarFlota().filas
 * @param {Object} totales Salida de analizarFlota().totales
 */
export function generarDiagnostico(filas = [], totales = {}) {
    const hallazgos = [];

    // Pre-cálculo del exceso de cada equipo
    const conExceso = filas.map(f => ({ fila: f, exceso: calcularExceso(f) })).filter(x => x.exceso);

    // ---------- 1. Sobreconsumo contra la meta, valorizado en pesos ----------
    const excedidos = conExceso
        .filter(x => x.fila.metrics.desvio_pct > TOLERANCIA * 100 && x.exceso.exceso_litros > 0)
        // Se excluyen las metas que a todas luces están mal cargadas: se reportan aparte.
        .filter(x => x.fila.metrics.consumo_real / x.fila.confirmed.valor < META_SOSPECHOSA_ALTA)
        .sort((a, b) => b.exceso.exceso_costo - a.exceso.exceso_costo);

    if (excedidos.length) {
        const litros = excedidos.reduce((s, x) => s + x.exceso.exceso_litros, 0);
        const costo = excedidos.reduce((s, x) => s + x.exceso.exceso_costo, 0);
        hallazgos.push({
            id: 'sobreconsumo',
            severidad: 'alta',
            icono: 'fa-fire',
            titulo: `${excedidos.length} equipos consumieron ${fmt(litros)} L por encima de su meta`,
            detalle: `Equivale a <strong>$${fmt(costo)}</strong> en el período analizado. El cálculo compara los litros realmente cargados contra los que corresponderían a la meta de cada equipo según su actividad (km u horas) registrada por GPS.`,
            impacto_costo: costo,
            equipos: excedidos.slice(0, 12).map(x => ({
                interno: x.fila.equipo.interno,
                denominacion: x.fila.equipo.denominacion,
                texto: `+${fmt(x.exceso.exceso_litros)} L · $${fmt(x.exceso.exceso_costo)}`,
                sub: `real ${fmt(x.fila.metrics.consumo_real, 2)} vs meta ${fmt(x.fila.confirmed.valor, 2)} ${x.fila.metrics.tipo_calculo} (${fmt(x.fila.metrics.desvio_pct, 0)}%)`
            }))
        });
    }

    // ---------- 2. Ahorro: equipos por debajo de la meta ----------
    const eficientes = conExceso
        .filter(x => x.fila.metrics.desvio_pct < -TOLERANCIA * 100 && x.exceso.exceso_litros < 0)
        .filter(x => x.fila.metrics.consumo_real / x.fila.confirmed.valor > META_SOSPECHOSA_BAJA)
        .sort((a, b) => a.exceso.exceso_costo - b.exceso.exceso_costo);

    if (eficientes.length) {
        const ahorro = -eficientes.reduce((s, x) => s + x.exceso.exceso_costo, 0);
        hallazgos.push({
            id: 'ahorro',
            severidad: 'ok',
            icono: 'fa-leaf',
            titulo: `${eficientes.length} equipos consumieron menos que su meta`,
            detalle: `Un ahorro equivalente a <strong>$${fmt(ahorro)}</strong>. Si el desvío es muy grande, conviene revisar que la meta no esté sobredimensionada o que no falten cargas por registrar.`,
            impacto_costo: -ahorro,
            equipos: eficientes.slice(0, 8).map(x => ({
                interno: x.fila.equipo.interno,
                denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.exceso.exceso_litros)} L · $${fmt(x.exceso.exceso_costo)}`,
                sub: `real ${fmt(x.fila.metrics.consumo_real, 2)} vs meta ${fmt(x.fila.confirmed.valor, 2)} ${x.fila.metrics.tipo_calculo}`
            }))
        });
    }

    // ---------- 3. Metas mal cargadas ----------
    // Un desvío enorme en cualquier dirección casi nunca es un problema del equipo: es la
    // meta que está cargada en otra unidad o con un valor equivocado en la planilla.
    const metasRaras = filas
        .filter(f => f.confirmed && f.confirmed.valor > 0 && f.metrics.consumo_real > 0)
        .map(f => ({ fila: f, ratio: f.metrics.consumo_real / f.confirmed.valor }))
        .filter(x => x.ratio >= META_SOSPECHOSA_ALTA || x.ratio <= META_SOSPECHOSA_BAJA)
        .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));

    if (metasRaras.length) {
        hallazgos.push({
            id: 'metas',
            severidad: 'media',
            icono: 'fa-bullseye',
            titulo: `${metasRaras.length} metas parecen mal cargadas`,
            detalle: `El consumo real difiere tanto de la meta que lo más probable es que el valor de "Consumos Estimados" esté equivocado o expresado en otra unidad, no que el equipo funcione mal. Se pueden corregir desde el botón de editar de cada tarjeta.`,
            equipos: metasRaras.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno,
                denominacion: x.fila.equipo.denominacion,
                texto: `real ${fmt(x.fila.metrics.consumo_real, 2)} vs meta ${fmt(x.fila.confirmed.valor, 2)}`,
                sub: x.ratio >= META_SOSPECHOSA_ALTA ? `consume ${fmt(x.ratio, 1)}× la meta` : `consume la ${fmt(x.ratio * 100, 0)}% de la meta`
            }))
        });
    }

    // ---------- 3b. Equipos sin meta, con sugerencia calculada ----------
    const sinMeta = filas
        .filter(f => !f.confirmed || !f.confirmed.valor)
        .filter(f => f.metrics.tipo_calculo === 'L/Hora' || f.metrics.tipo_calculo === 'L/100Km')
        .map(f => ({ fila: f, sug: sugerirMeta(f, filas) }))
        .filter(x => x.sug)
        .sort((a, b) => b.fila.metrics.total_litros - a.fila.metrics.total_litros);

    if (sinMeta.length) {
        hallazgos.push({
            id: 'sin_meta',
            severidad: 'media',
            icono: 'fa-bullseye-pointer',
            titulo: `${sinMeta.length} equipos no tienen meta cargada (hay sugerencia calculada)`,
            detalle: `Sin meta no se puede saber si consumen de más. La app propone un valor a partir de la <strong>mediana del consumo real de sus pares del mismo tipo</strong> en tu propia flota — un objetivo más realista que una ficha de fábrica, porque sale de tus rutas y tu operación. Se acepta con un click desde el botón de editar de cada tarjeta.`,
            equipos: sinMeta.slice(0, 12).map(x => ({
                interno: x.fila.equipo.interno,
                denominacion: x.fila.equipo.denominacion,
                texto: `sugerido: ${fmt(x.sug.valor, 2)} ${x.sug.unidad}`,
                sub: `${x.sug.base} · rango ${fmt(x.sug.minimo, 1)}–${fmt(x.sug.maximo, 1)}`
            }))
        });
    }

    // ---------- 4. Ralentí ----------
    const conRalenti = filas
        .filter(f => f.metrics.total_horas > 0 && f.metrics.horas_ralenti > 0)
        .map(f => ({ fila: f, pct: f.metrics.horas_ralenti / f.metrics.total_horas * 100 }))
        .sort((a, b) => b.fila.metrics.horas_ralenti - a.fila.metrics.horas_ralenti);

    if (totales.horas_ralenti > 0) {
        const pctGlobal = totales.horas_ralenti / (totales.horas_ralenti + totales.horas_movimiento) * 100;
        hallazgos.push({
            id: 'ralenti',
            severidad: pctGlobal > 40 ? 'alta' : 'media',
            icono: 'fa-hourglass-half',
            titulo: `${fmt(pctGlobal, 1)}% de las horas de la flota fue en ralentí`,
            detalle: `Son <strong>${fmt(totales.horas_ralenti)} horas</strong> de motor encendido sin desplazamiento, contra ${fmt(totales.horas_movimiento)} horas en movimiento. Es combustible quemado sin producción y es la variable más fácil de bajar sin invertir en nada: depende de hábitos de operación.`,
            equipos: conRalenti.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno,
                denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.fila.metrics.horas_ralenti)} hs en ralentí`,
                sub: `${fmt(x.pct, 0)}% de sus ${fmt(x.fila.metrics.total_horas)} hs totales`
            }))
        });
    }

    // ---------- 5. Comparación contra los pares del mismo tipo ----------
    // Compara cada equipo contra la MEDIANA de su denominación. Es más justo que compararlo
    // contra una meta teórica: son máquinas iguales haciendo el mismo trabajo.
    const porDeno = new Map();
    filas.filter(f => f.metrics.consumo_real > 0).forEach(f => {
        const k = f.equipo.denominacion;
        if (!porDeno.has(k)) porDeno.set(k, []);
        porDeno.get(k).push(f);
    });

    const peoresDelGrupo = [];
    porDeno.forEach((grupo, deno) => {
        if (grupo.length < 3) return; // con menos de 3 la mediana no dice nada
        const valores = grupo.map(f => f.metrics.consumo_real).sort((a, b) => a - b);
        const mediana = valores[Math.floor(valores.length / 2)];
        if (mediana <= 0) return;
        grupo.forEach(f => {
            const ratio = f.metrics.consumo_real / mediana;
            if (ratio > 1.25) {
                peoresDelGrupo.push({ fila: f, deno, mediana, ratio, grupo: grupo.length });
            }
        });
    });
    peoresDelGrupo.sort((a, b) => b.ratio - a.ratio);

    if (peoresDelGrupo.length) {
        hallazgos.push({
            id: 'pares',
            severidad: 'media',
            icono: 'fa-code-compare',
            titulo: `${peoresDelGrupo.length} equipos consumen más que sus pares del mismo tipo`,
            detalle: `Comparación contra la mediana de cada denominación, no contra la meta teórica. Cuando una máquina consume bastante más que otras iguales haciendo el mismo trabajo, suele apuntar a un problema mecánico, a la forma de operarla o a cargas mal imputadas.`,
            equipos: peoresDelGrupo.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno,
                denominacion: x.deno,
                texto: `${fmt(x.fila.metrics.consumo_real, 2)} vs ${fmt(x.mediana, 2)} del grupo`,
                sub: `${fmt((x.ratio - 1) * 100, 0)}% sobre la mediana de ${x.grupo} ${x.deno.toLowerCase()}s`
            }))
        });
    }

    // ---------- 6. Combustible sin asignar ----------
    if (totales.huerfanos && totales.huerfanos.length) {
        const litros = totales.huerfanos.reduce((s, h) => s + h.litros, 0);
        if (litros > 0) {
            hallazgos.push({
                id: 'huerfanos',
                severidad: 'media',
                icono: 'fa-link-slash',
                titulo: `${fmt(litros)} L cargados a códigos que no existen en el padrón`,
                detalle: `Aparecen en la planilla de Cargas pero no en la de Equipos, así que ese combustible no se le imputa a ninguna máquina y queda fuera de todo control de consumo. Conviene darlos de alta en el padrón o corregir el código en la planilla de cargas.`,
                equipos: totales.huerfanos.filter(h => h.litros > 0).slice(0, 10).map(h => ({
                    interno: h.interno,
                    denominacion: 'sin padrón',
                    texto: `${fmt(h.litros)} L`,
                    sub: `${h.cargas} cargas sin equipo asignado`
                }))
            });
        }
    }

    // ---------- 7. Equipos que cargan pero no se pueden medir ----------
    const sinMedicion = filas.filter(f =>
        f.metrics.total_litros > 0 &&
        f.metrics.consumo_real === 0 &&
        f.metrics.tipo_calculo !== 'No Aplica'
    ).sort((a, b) => b.metrics.total_litros - a.metrics.total_litros);

    if (sinMedicion.length) {
        const litros = sinMedicion.reduce((s, f) => s + f.metrics.total_litros, 0);
        hallazgos.push({
            id: 'sin_medicion',
            severidad: 'media',
            icono: 'fa-eye-slash',
            titulo: `${sinMedicion.length} equipos cargan combustible pero no se puede calcular su consumo`,
            detalle: `Suman <strong>${fmt(litros)} L</strong> sin control posible. Falta el dato de actividad (km u horas) del Resumen de Flota para el período, normalmente porque el equipo no tiene GPS instalado o no reportó.`,
            equipos: sinMedicion.slice(0, 10).map(f => ({
                interno: f.equipo.interno,
                denominacion: f.equipo.denominacion,
                texto: `${fmt(f.metrics.total_litros)} L`,
                sub: f.metrics.motivo_sin_calculo || 'sin datos de actividad'
            }))
        });
    }

    // ---------- 8. Cargas anómalas ----------
    // Una carga muy por encima de lo habitual PARA ESE equipo puede ser un error de tipeo,
    // una carga a un tanque distinto o un desvío. Se compara contra la mediana del equipo.
    const anomalas = [];
    filas.forEach(f => {
        if (f.cargas.length < 5) return;
        const litros = f.cargas.map(c => parseFloat(c.litros) || 0).filter(l => l > 0).sort((a, b) => a - b);
        if (litros.length < 5) return;
        const mediana = litros[Math.floor(litros.length / 2)];
        if (mediana <= 0) return;
        f.cargas.forEach(c => {
            const l = parseFloat(c.litros) || 0;
            if (l > mediana * 3) {
                anomalas.push({ equipo: f.equipo, carga: c, mediana, veces: l / mediana });
            }
        });
    });
    anomalas.sort((a, b) => b.veces - a.veces);

    if (anomalas.length) {
        hallazgos.push({
            id: 'anomalas',
            severidad: 'baja',
            icono: 'fa-magnifying-glass-chart',
            titulo: `${anomalas.length} cargas individuales muy por encima de lo habitual`,
            detalle: `Cargas que superan el triple de lo que ese mismo equipo carga normalmente. Puede ser legítimo (tanque vacío, viaje largo) o un error de tipeo o de imputación. Vale la pena revisarlas de a una.`,
            equipos: anomalas.slice(0, 10).map(a => ({
                interno: a.equipo.interno,
                denominacion: a.equipo.denominacion,
                texto: `${fmt(a.carga.litros, 1)} L el ${a.carga.fecha}`,
                sub: `${fmt(a.veces, 1)}× su carga habitual de ${fmt(a.mediana, 1)} L · ${a.carga.lugar_carga || 'sin lugar'}`
            }))
        });
    }

    const orden = { alta: 0, media: 1, baja: 2, ok: 3 };
    hallazgos.sort((a, b) => (orden[a.severidad] - orden[b.severidad]) || (Math.abs(b.impacto_costo || 0) - Math.abs(a.impacto_costo || 0)));

    return hallazgos;
}
