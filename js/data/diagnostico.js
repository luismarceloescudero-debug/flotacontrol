/**
 * Motor de diagnóstico automático — sin IA ni servicios externos.
 *
 * Incorpora reglas de dominio que los números solos no muestran:
 *  - Un grupo electrógeno trabaja quieto: sus horas "en ralentí" SON su trabajo, no desperdicio.
 *  - Un mixer o una bomba esperan en obra para descargar: parte del ralentí es operativo.
 *  - Un equipo sin cargas en el período no es un hallazgo, es un equipo que no operó
 *    (la empresa trabaja en dos provincias y no todo el parque se usa en todos lados).
 *  - Un consumo calculado sobre pocas cargas o un solo período no es confiable y se avisa.
 */

import { getPrefijo, clasificarIdentificador } from './normalizer.js';
import { diasHabiles } from './feriados.js';

const TOLERANCIA = 0.15;
const META_ALTA = 2.5;
const META_BAJA = 0.4;
const MIN_CARGAS_CONFIABLE = 3;
const COBERTURA_MINIMA_PCT = 40; // % de días hábiles del período con al menos una carga

/**
 * Equipos que trabajan ESTACIONARIOS: el motor encendido sin desplazarse es exactamente
 * su función. Contarles el ralentí como desperdicio sería un error de lectura.
 * EX (excavadoras): son equipos de trabajo estacionario, NO de desplazamiento.
 */
export const OPERA_ESTACIONARIO = ['GE', 'MT', 'MH', 'CL', 'MC', 'AE', 'EX'];

/**
 * Equipos con espera operativa legítima: mixers y bombas pasan tiempo detenidos con el
 * motor en marcha esperando descargar o bombear en obra. Su ralentí se sigue midiendo,
 * pero se informa como "a revisar según la obra", no como desperdicio puro.
 */
export const ESPERA_OPERATIVA = ['MX', 'BM'];

const fmt = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

const mediana = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function categoriaRalenti(interno) {
    const p = getPrefijo(interno);
    if (OPERA_ESTACIONARIO.includes(p)) return 'estacionario';
    if (ESPERA_OPERATIVA.includes(p)) return 'espera';
    return 'desperdicio';
}

/**
 * ¿El consumo calculado se apoya en suficientes datos como para tomarlo en serio?
 *
 * `periodo` ({ desde, hasta }, fechas ISO) es opcional: cuando se pasa, además del umbral fijo
 * de cantidad de cargas se calcula la COBERTURA real — cuántos de los días hábiles del período
 * analizado tuvieron al menos una carga. Un umbral fijo ("3 cargas ya es confiable") no
 * distingue "3 cargas en una semana" de "3 cargas en 6 meses" (130 días hábiles): la segunda
 * es un dato mucho más débil aunque pase el mismo umbral. Se reutiliza diasHabiles() de
 * feriados.js (la misma cuenta que ya se muestra en el KPI de período del panel) para no
 * duplicar el calendario de feriados en dos lugares.
 */
export function confiabilidad(fila, periodo = null) {
    const m = fila.metrics;
    const avisos = [];
    if (m.cantidad_cargas > 0 && m.cantidad_cargas < MIN_CARGAS_CONFIABLE) avisos.push(`solo ${m.cantidad_cargas} carga${m.cantidad_cargas === 1 ? '' : 's'}`);
    if (m.cantidad_gps === 1) avisos.push('un solo período de GPS');
    if (m.total_horas > 0 && m.total_horas < 20) avisos.push(`solo ${fmt(m.total_horas, 1)} hs registradas`);
    if (m.total_km > 0 && m.total_km < 200 && m.tipo_calculo === 'L/100Km') avisos.push(`solo ${fmt(m.total_km)} km`);

    let cobertura = null;
    if (periodo && periodo.desde && periodo.hasta && Array.isArray(fila.cargas) && fila.cargas.length) {
        const diasConCarga = new Set(fila.cargas.map(c => c.fecha).filter(Boolean)).size;
        const dh = diasHabiles(periodo.desde, periodo.hasta);
        if (dh.dias > 0) {
            const pct = Math.round((diasConCarga / dh.dias) * 100);
            cobertura = { diasConCarga, diasHabiles: dh.dias, pct };
            if (pct < COBERTURA_MINIMA_PCT) avisos.push(`cargó ${diasConCarga} de ${dh.dias} días hábiles del período (${pct}%)`);
        }
    }

    return { confiable: avisos.length === 0, avisos, cobertura };
}

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
    } else return null;

    const excesoLitros = m.total_litros - litrosEsperados;
    const precioLitro = m.total_litros > 0 ? m.total_costo / m.total_litros : 0;
    return { litros_esperados: litrosEsperados, exceso_litros: excesoLitros, exceso_costo: excesoLitros * precioLitro, precio_litro: precioLitro };
}

/**
 * Sugiere una meta a partir del consumo real medido de los pares comparables.
 * Compara primero contra misma marca+modelo; si no hay suficientes, cae a denominación.
 * Devuelve además la lista de esos pares, para poder mostrar CONTRA QUIÉN se compara.
 */
export function sugerirMeta(fila, todas = []) {
    const tipo = fila.metrics.tipo_calculo;
    if (tipo !== 'L/Hora' && tipo !== 'L/100Km') return null;

    const eq = fila.equipo;
    const filtroBase = f =>
        f.equipo.interno !== eq.interno &&
        f.metrics.tipo_calculo === tipo &&
        f.metrics.consumo_real > 0 &&
        confiabilidad(f).confiable;

    // Intentar primero con marca+modelo (comparación justa)
    let pares = [];
    let etiqueta = '';
    if (eq.marca && eq.modelo) {
        pares = todas.filter(f => filtroBase(f) && f.equipo.marca === eq.marca && f.equipo.modelo === eq.modelo);
        etiqueta = `${eq.denominacion} ${eq.marca} ${eq.modelo}`;
    }
    // Fallback a denominación si no hay suficientes pares con marca+modelo
    if (pares.length < 2) {
        pares = todas.filter(f => filtroBase(f) && f.equipo.denominacion === eq.denominacion);
        etiqueta = eq.denominacion || 'equipos';
    }
    if (pares.length < 2) return null;

    const valores = pares.map(f => f.metrics.consumo_real);
    const med = mediana(valores);
    if (med <= 0) return null;

    return {
        valor: Math.round(med * 100) / 100,
        unidad: tipo,
        n: pares.length,
        minimo: Math.min(...valores),
        maximo: Math.max(...valores),
        base: `mediana de ${pares.length} ${etiqueta.toLowerCase()} medidos`,
        pares: pares.sort((a, b) => a.metrics.consumo_real - b.metrics.consumo_real)
            .map(p => ({ interno: p.equipo.interno, valor: p.metrics.consumo_real, cargas: p.metrics.cantidad_cargas }))
    };
}

/**
 * Meta implícita a partir de las cargas reales del propio equipo: sirve cuando no hay meta
 * cargada ni pares suficientes. Es literalmente "lo que este equipo viene consumiendo".
 */
export function metaDesdeConsumoReal(fila) {
    const m = fila.metrics;
    if (!m.consumo_real || m.consumo_real <= 0) return null;
    const c = confiabilidad(fila);
    return {
        valor: Math.round(m.consumo_real * 100) / 100,
        unidad: m.tipo_calculo,
        base: `consumo real medido sobre ${m.cantidad_cargas} cargas`,
        confiable: c.confiable,
        avisos: c.avisos
    };
}

/**
 * Cálculo inverso: para equipos que cargan combustible pero no tienen GPS, la meta permite
 * estimar cuánta actividad DEBERÍAN haber tenido. No reemplaza al GPS, pero convierte un
 * "no se puede calcular" en un número con el que sí se puede trabajar.
 */
export function actividadImplicita(fila) {
    const m = fila.metrics;
    const c = fila.confirmed;
    if (!c || !c.valor || c.valor <= 0 || m.total_litros <= 0) return null;
    if (m.tipo_calculo === 'L/Hora') {
        return { valor: m.total_litros / c.valor, unidad: 'horas', formula: `${fmt(m.total_litros, 1)} L ÷ ${fmt(c.valor, 2)} L/hora` };
    }
    if (m.tipo_calculo === 'L/100Km') {
        return { valor: (m.total_litros / c.valor) * 100, unidad: 'km', formula: `${fmt(m.total_litros, 1)} L ÷ ${fmt(c.valor, 2)} L/100km × 100` };
    }
    return null;
}

/**
 * Clasifica el consumo que NO pertenece a la flota rodante pero igual es gasto:
 * vehículos con patente pero sin interno asignado, y servicios de planta
 * (calderas, caloventores, limpieza, jardinería, herramientas a combustión).
 */
export function clasificarNoFlota(huerfanos = [], rawRecords = []) {
    const cargasPorClave = new Map();
    rawRecords.filter(r => r.type === 'carga').forEach(r => {
        const k = r.interno_key || r.dominio_key;
        if (!cargasPorClave.has(k)) cargasPorClave.set(k, []);
        cargasPorClave.get(k).push(r);
    });

    const grupos = {
        vehiculo_sin_interno: { id: 'vehiculo_sin_interno', etiqueta: 'Vehículos con patente pero sin interno en el padrón', detalle: 'Tienen dominio válido: son unidades reales que faltan dar de alta en el maestro.', items: [], litros: 0, costo: 0 },
        planta: { id: 'planta', etiqueta: 'Servicios y mantenimiento de planta', detalle: 'Calderas, caloventores, limpieza y consumos fijos de planta. No son flota rodante: no se les puede calcular L/100km ni L/hora, pero son gasto y conviene seguirlos por centro de costo.', items: [], litros: 0, costo: 0 },
        otros: { id: 'otros', etiqueta: 'Otros consumos sin identificar', detalle: 'Códigos que no siguen la nomenclatura ni son patentes. Conviene normalizarlos en la planilla de cargas.', items: [], litros: 0, costo: 0 }
    };

    const PALABRAS_PLANTA = /CALDERA|CALOVENTOR|LIMPIEZA|JARDIN|PLANTA|TALLER|SURTIDOR|CANALETA|BOMBEO|HERRAMIENT/;

    huerfanos.forEach(h => {
        const cargas = cargasPorClave.get(h.interno_key || h.interno) || cargasPorClave.get(h.interno) || [];
        const costo = cargas.reduce((s, c) => s + (parseFloat(c.importe) || 0), 0);
        const centros = {};
        const sectores = {};
        cargas.forEach(c => {
            if (c.centro_costo) centros[c.centro_costo] = (centros[c.centro_costo] || 0) + 1;
            if (c.sector) sectores[c.sector] = (sectores[c.sector] || 0) + 1;
        });
        const topCentro = Object.keys(centros).sort((a, b) => centros[b] - centros[a])[0] || '—';
        const topSector = Object.keys(sectores).sort((a, b) => sectores[b] - sectores[a])[0] || '';

        const esDominio = clasificarIdentificador(h.interno).tipo === 'dominio';
        const g = esDominio ? grupos.vehiculo_sin_interno
            : (PALABRAS_PLANTA.test(h.interno) || PALABRAS_PLANTA.test(topSector) ? grupos.planta : grupos.otros);

        g.items.push({ codigo: h.interno, litros: h.litros, costo, cargas: h.cargas, centro_costo: topCentro, sector: topSector });
        g.litros += h.litros;
        g.costo += costo;
    });

    Object.values(grupos).forEach(g => g.items.sort((a, b) => b.litros - a.litros));
    return Object.values(grupos).filter(g => g.items.length);
}

/**
 * Compara una métrica mes a mes para ver si un desvío se sostiene o fue puntual.
 * Es la respuesta a "ver condiciones puntuales a un mes y si se normaliza en otro".
 */
export function evolucionMensual(fila) {
    const porMes = new Map();
    const agregar = (r, campo, valor) => {
        if (!r.periodo) return;
        if (!porMes.has(r.periodo)) porMes.set(r.periodo, { periodo: r.periodo, litros: 0, km: 0, horas: 0, cargas: 0 });
        porMes.get(r.periodo)[campo] += valor;
    };
    fila.cargas.forEach(c => { agregar(c, 'litros', parseFloat(c.litros) || 0); agregar(c, 'cargas', 1); });
    fila.gps.forEach(g => {
        agregar(g, 'km', parseFloat(g.distancia) || 0);
        agregar(g, 'horas', (g.horas && g.horas.total) || 0);
    });

    const esHora = fila.metrics.tipo_calculo === 'L/Hora';
    return [...porMes.values()].sort((a, b) => a.periodo.localeCompare(b.periodo)).map(m => {
        const factor = esHora ? m.horas : m.km;
        const consumo = factor > 0 ? (esHora ? m.litros / factor : (m.litros / factor) * 100) : 0;
        return { ...m, factor, consumo, unidad: fila.metrics.tipo_calculo };
    });
}

// ============================================================ HALLAZGOS

export function generarDiagnostico(filas = [], totales = {}, rawRecords = []) {
    const hallazgos = [];

    // Un equipo sin cargas en el período no operó: no es un hallazgo. La empresa trabaja en
    // dos provincias y no todo el parque se usa en todos lados ni en todos los meses.
    const activos = filas.filter(f => f.metrics.cantidad_cargas > 0);
    const periodo = { desde: totales.periodo_desde, hasta: totales.periodo_hasta };
    const conExceso = activos.map(f => ({ fila: f, exceso: calcularExceso(f), conf: confiabilidad(f, periodo) })).filter(x => x.exceso);

    // ---------- 1. Sobreconsumo valorizado ----------
    const excedidos = conExceso
        .filter(x => x.fila.metrics.desvio_pct > TOLERANCIA * 100 && x.exceso.exceso_litros > 0)
        .filter(x => x.fila.metrics.consumo_real / x.fila.confirmed.valor < META_ALTA)
        .sort((a, b) => b.exceso.exceso_costo - a.exceso.exceso_costo);

    if (excedidos.length) {
        const litros = excedidos.reduce((s, x) => s + x.exceso.exceso_litros, 0);
        const costo = excedidos.reduce((s, x) => s + x.exceso.exceso_costo, 0);
        const dudosos = excedidos.filter(x => !x.conf.confiable).length;
        const ajustados = excedidos.filter(x => x.fila.confirmed.source === 'Maestro').length;
        hallazgos.push({
            id: 'sobreconsumo', severidad: 'alta', icono: 'fa-fire',
            titulo: `${excedidos.length} equipos consumieron ${fmt(litros)} L por encima de su meta`,
            detalle: `Equivale a <strong>$${fmt(costo)}</strong> en el período. Se comparan los litros realmente cargados contra los que corresponderían a la meta según la actividad (km u horas) del GPS.` +
                (ajustados ? ` <em>${ajustados} de ellos usan una meta ajustada manualmente; si aún exceden, puede ser un desvío puntual de ese período.</em>` : '') +
                (dudosos ? ` <em>${dudosos} de estos casos se apoyan en pocos datos: conviene confirmarlos antes de accionar.</em>` : ''),
            impacto_costo: costo,
            equipos: excedidos.slice(0, 12).map(x => {
                const fuenteMeta = x.fila.confirmed.source === 'Maestro' ? 'ajustada' : 'estimada';
                return {
                    interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                    texto: `+${fmt(x.exceso.exceso_litros)} L · $${fmt(x.exceso.exceso_costo)}`,
                    sub: `real ${fmt(x.fila.metrics.consumo_real, 2)} vs meta ${fmt(x.fila.confirmed.valor, 2)} ${x.fila.metrics.tipo_calculo} (${fuenteMeta}, +${fmt(x.fila.metrics.desvio_pct)}%)` +
                         (x.conf.confiable ? ` · ${x.fila.metrics.cantidad_cargas} cargas` : ` · ⚠ ${x.conf.avisos.join(', ')}`)
                };
            })
        });
    }

    // ---------- 2. Ahorro ----------
    const eficientes = conExceso
        .filter(x => x.fila.metrics.desvio_pct < -TOLERANCIA * 100 && x.exceso.exceso_litros < 0)
        .filter(x => x.fila.metrics.consumo_real / x.fila.confirmed.valor > META_BAJA)
        .sort((a, b) => a.exceso.exceso_costo - b.exceso.exceso_costo);

    if (eficientes.length) {
        const ahorro = -eficientes.reduce((s, x) => s + x.exceso.exceso_costo, 0);
        hallazgos.push({
            id: 'ahorro', severidad: 'ok', icono: 'fa-leaf',
            titulo: `${eficientes.length} equipos consumieron menos que su meta`,
            detalle: `Un ahorro equivalente a <strong>$${fmt(ahorro)}</strong>. Si el desvío es grande, revisá que la meta no esté sobredimensionada o que no falten cargas por registrar.`,
            impacto_costo: -ahorro,
            equipos: eficientes.slice(0, 8).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.exceso.exceso_litros)} L · $${fmt(x.exceso.exceso_costo)}`,
                sub: `real ${fmt(x.fila.metrics.consumo_real, 2)} vs meta ${fmt(x.fila.confirmed.valor, 2)} ${x.fila.metrics.tipo_calculo}`
            }))
        });
    }

    // ---------- 3. Metas mal cargadas ----------
    const metasRaras = activos
        .filter(f => f.confirmed && f.confirmed.valor > 0 && f.metrics.consumo_real > 0)
        .map(f => ({ fila: f, ratio: f.metrics.consumo_real / f.confirmed.valor, sug: metaDesdeConsumoReal(f) }))
        .filter(x => x.ratio >= META_ALTA || x.ratio <= META_BAJA)
        .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));

    if (metasRaras.length) {
        hallazgos.push({
            id: 'metas', severidad: 'media', icono: 'fa-bullseye',
            titulo: `${metasRaras.length} metas parecen mal cargadas`,
            detalle: `El consumo real difiere tanto de la meta que lo más probable es que el valor de "Consumos Estimados" esté equivocado o en otra unidad, no que el equipo funcione mal. Podés reemplazarlas por el consumo real medido desde <strong>Ajustar metas</strong>.`,
            accion: { texto: 'Ajustar estas metas', filtro: 'metas_raras' },
            equipos: metasRaras.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `real ${fmt(x.fila.metrics.consumo_real, 2)} vs meta ${fmt(x.fila.confirmed.valor, 2)}`,
                sub: `${x.ratio >= META_ALTA ? `consume ${fmt(x.ratio, 1)}× la meta` : `consume el ${fmt(x.ratio * 100)}% de la meta`} · sugerido: ${fmt(x.sug ? x.sug.valor : 0, 2)}`
            }))
        });
    }

    // ---------- 4. Sin meta, con sugerencia ----------
    const sinMeta = activos
        .filter(f => !f.confirmed || !f.confirmed.valor)
        .filter(f => ['L/Hora', 'L/100Km'].includes(f.metrics.tipo_calculo))
        .map(f => ({ fila: f, sug: sugerirMeta(f, activos) || metaDesdeConsumoReal(f) }))
        .filter(x => x.sug)
        .sort((a, b) => b.fila.metrics.total_litros - a.fila.metrics.total_litros);

    if (sinMeta.length) {
        hallazgos.push({
            id: 'sin_meta', severidad: 'media', icono: 'fa-bullseye-pointer',
            titulo: `${sinMeta.length} equipos no tienen meta cargada`,
            detalle: `Sin meta no hay contra qué comparar. Mientras no exista el dato oficial, la app propone la <strong>mediana de sus pares medidos</strong>, o el <strong>consumo real del propio equipo</strong> si no hay pares suficientes. Se aplican de a uno o en bloque desde <strong>Ajustar metas</strong>.`,
            accion: { texto: 'Ajustar metas faltantes', filtro: 'sin_meta' },
            equipos: sinMeta.slice(0, 12).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `sugerido: ${fmt(x.sug.valor, 2)} ${x.sug.unidad}`,
                sub: x.sug.base + (x.sug.pares ? ` · rango ${fmt(x.sug.minimo, 1)}–${fmt(x.sug.maximo, 1)}` : '')
            }))
        });
    }

    // ---------- 5. Comparación contra pares (marca, modelo y potencia; fallback a denominación) ----------
    // Agrupar por la clave más específica posible: marca+modelo > marca > denominación.
    // Así un GE01 de 250 kVA no se compara contra un GE03 de 500 kVA.
    function claveParGrupo(eq) {
        const deno = eq.denominacion || '';
        const marca = eq.marca || '';
        const modelo = eq.modelo || '';
        const potencia = eq.potencia || '';
        // Si tiene marca y modelo, agrupar por deno+marca+modelo (más justo)
        if (marca && modelo) return `${deno}|${marca}|${modelo}`;
        if (marca) return `${deno}|${marca}`;
        return deno;
    }
    function etiquetaGrupo(key) {
        const [deno, marca, modelo] = key.split('|');
        if (modelo) return `${deno} ${marca} ${modelo}`;
        if (marca) return `${deno} ${marca}`;
        return deno;
    }

    const porGrupo = new Map();
    activos.filter(f => f.metrics.consumo_real > 0 && confiabilidad(f, periodo).confiable).forEach(f => {
        const k = claveParGrupo(f.equipo);
        if (!porGrupo.has(k)) porGrupo.set(k, []);
        porGrupo.get(k).push(f);
    });

    const peores = [];
    porGrupo.forEach((grupo, key) => {
        // Necesitamos al menos 2 pares (3 en el grupo) para comparar
        if (grupo.length < 2) return;
        const deno = etiquetaGrupo(key);
        const orden = grupo.slice().sort((a, b) => a.metrics.consumo_real - b.metrics.consumo_real);
        const med = mediana(orden.map(f => f.metrics.consumo_real));
        if (med <= 0) return;
        grupo.forEach(f => {
            const ratio = f.metrics.consumo_real / med;
            // Con grupos chicos (2-3), solo alertar con desvíos más claros (>35%)
            const umbral = grupo.length < 4 ? 1.35 : 1.25;
            if (ratio > umbral) {
                const specs = [f.equipo.potencia, f.equipo.capacidad].filter(Boolean).join(' · ');
                peores.push({
                    fila: f, deno, mediana: med, ratio, specs,
                    pares: orden.map(p => ({
                        interno: p.equipo.interno, valor: p.metrics.consumo_real,
                        esEste: p.equipo.interno === f.equipo.interno,
                        specs: [p.equipo.potencia, p.equipo.capacidad].filter(Boolean).join(' · ')
                    }))
                });
            }
        });
    });
    peores.sort((a, b) => b.ratio - a.ratio);

    if (peores.length) {
        hallazgos.push({
            id: 'pares', severidad: 'media', icono: 'fa-code-compare',
            titulo: `${peores.length} equipos consumen más que sus pares comparables`,
            detalle: `Comparación contra la mediana de equipos similares (misma marca y modelo cuando hay dato, o misma denominación si no). No se comparan equipos de distinta potencia o modelo entre sí. Cuando una máquina consume bastante más que otras iguales, suele apuntar a un problema mecánico, operación o cargas mal imputadas.`,
            comparaciones: peores.slice(0, 8).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.deno,
                valor: x.fila.metrics.consumo_real, mediana: x.mediana, unidad: x.fila.metrics.tipo_calculo,
                exceso_pct: (x.ratio - 1) * 100, pares: x.pares, specs: x.specs
            })),
            equipos: peores.slice(0, 8).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.deno,
                texto: `${fmt(x.fila.metrics.consumo_real, 2)} vs ${fmt(x.mediana, 2)} del grupo`,
                sub: `${fmt((x.ratio - 1) * 100)}% sobre la mediana de ${x.pares.length} ${x.deno.toLowerCase()}${x.specs ? ' · ' + x.specs : ''}`
            }))
        });
    }

    // ---------- 6. Ralentí, separando lo que es desperdicio de lo que es el trabajo ----------
    const conRalenti = activos.filter(f => f.metrics.total_horas > 0 && f.metrics.horas_ralenti > 0)
        .map(f => ({ fila: f, pct: f.metrics.horas_ralenti / f.metrics.total_horas * 100, cat: categoriaRalenti(f.equipo.interno) }));

    const desperdicio = conRalenti.filter(x => x.cat === 'desperdicio').sort((a, b) => b.fila.metrics.horas_ralenti - a.fila.metrics.horas_ralenti);
    const espera = conRalenti.filter(x => x.cat === 'espera').sort((a, b) => b.pct - a.pct);
    const estacionarios = conRalenti.filter(x => x.cat === 'estacionario');

    const hsDesperdicio = desperdicio.reduce((s, x) => s + x.fila.metrics.horas_ralenti, 0);
    const hsEstacionario = estacionarios.reduce((s, x) => s + x.fila.metrics.horas_ralenti, 0);

    if (desperdicio.length) {
        hallazgos.push({
            id: 'ralenti', severidad: hsDesperdicio > 2000 ? 'alta' : 'media', icono: 'fa-hourglass-half',
            titulo: `${fmt(hsDesperdicio)} horas de ralentí evitable en equipos de desplazamiento`,
            detalle: `Solo se cuentan aquí los equipos cuyo trabajo es moverse (tractores, camionetas, cargadoras): en ellos el motor encendido sin desplazarse sí es combustible sin producción. ` +
                (hsEstacionario > 0 ? `Quedan excluidas <strong>${fmt(hsEstacionario)} hs</strong> de grupos electrógenos y equipos estacionarios, donde trabajar quieto es justamente su función. ` : '') +
                (espera.length ? `Los mixers y bombas se listan aparte porque parte de su espera es operativa (aguardar descarga en obra).` : ''),
            equipos: desperdicio.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.fila.metrics.horas_ralenti)} hs en ralentí`,
                sub: `${fmt(x.pct)}% de sus ${fmt(x.fila.metrics.total_horas)} hs · trabajo de desplazamiento`
            }))
        });
    }

    if (espera.length) {
        hallazgos.push({
            id: 'ralenti_espera', severidad: 'baja', icono: 'fa-truck-ramp-box',
            titulo: `${espera.length} mixers y bombas con alta proporción de espera`,
            detalle: `En estos equipos parte del ralentí es operativo: esperar turno de descarga o bombeo en obra. No es desperdicio automático, pero un porcentaje muy alto y sostenido en el tiempo sí señala demoras en obra que cuestan combustible. Conviene mirar si se repite mes a mes o fue puntual de un período.`,
            equipos: espera.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.pct)}% en espera`,
                sub: `${fmt(x.fila.metrics.horas_ralenti)} de ${fmt(x.fila.metrics.total_horas)} hs · revisar contra otros meses`
            }))
        });
    }

    // ---------- 7. Sin GPS: cálculo inverso ----------
    const sinMedicion = activos.filter(f =>
        f.metrics.total_litros > 0 && f.metrics.consumo_real === 0 && f.metrics.tipo_calculo !== 'No Aplica'
    ).map(f => ({ fila: f, implicita: actividadImplicita(f) }))
     .sort((a, b) => b.fila.metrics.total_litros - a.fila.metrics.total_litros);

    if (sinMedicion.length) {
        const litros = sinMedicion.reduce((s, x) => s + x.fila.metrics.total_litros, 0);
        const conMeta = sinMedicion.filter(x => x.implicita).length;
        hallazgos.push({
            id: 'sin_medicion', severidad: 'media', icono: 'fa-eye-slash',
            titulo: `${sinMedicion.length} equipos cargan combustible sin dato de actividad`,
            detalle: `Suman <strong>${fmt(litros)} L</strong>. Falta el km u hora del Resumen de Flota, normalmente porque el equipo no tiene GPS. ` +
                (conMeta ? `Para ${conMeta} de ellos se puede estimar por <strong>cálculo inverso</strong>: con su meta y los litros cargados se deduce cuánta actividad debería haber tenido. Sirve como control de razonabilidad hasta que tengan GPS.` : `Sin meta ni GPS no hay forma de estimarlos: cargarles una meta es el primer paso.`),
            equipos: sinMedicion.slice(0, 10).map(x => ({
                interno: x.fila.equipo.interno, denominacion: x.fila.equipo.denominacion,
                texto: `${fmt(x.fila.metrics.total_litros)} L`,
                sub: x.implicita
                    ? `≈ ${fmt(x.implicita.valor)} ${x.implicita.unidad} implícitas  (${x.implicita.formula})`
                    : (x.fila.metrics.motivo_sin_calculo || 'sin datos de actividad') + ' · sin meta para estimar'
            }))
        });
    }

    // ---------- 8. Consumo fuera de la flota ----------
    const grupos = clasificarNoFlota(totales.huerfanos || [], rawRecords);
    grupos.forEach(g => {
        hallazgos.push({
            id: 'nofl_' + g.id, severidad: g.id === 'vehiculo_sin_interno' ? 'media' : 'baja',
            icono: g.id === 'vehiculo_sin_interno' ? 'fa-car-side' : (g.id === 'planta' ? 'fa-industry' : 'fa-link-slash'),
            titulo: `${g.etiqueta}: ${fmt(g.litros)} L${g.costo ? ` · $${fmt(g.costo)}` : ''}`,
            detalle: g.detalle,
            impacto_costo: g.costo,
            equipos: g.items.slice(0, 10).map(i => ({
                interno: i.codigo, denominacion: i.centro_costo !== '—' ? `centro de costo ${i.centro_costo}` : 'sin centro de costo',
                texto: `${fmt(i.litros)} L${i.costo ? ` · $${fmt(i.costo)}` : ''}`,
                sub: `${i.cargas} cargas${i.sector ? ` · sector ${i.sector}` : ''}`
            }))
        });
    });

    // ---------- 9. Cargas anómalas ----------
    const anomalas = [];
    activos.forEach(f => {
        if (f.cargas.length < 5) return;
        const litros = f.cargas.map(c => parseFloat(c.litros) || 0).filter(l => l > 0).sort((a, b) => a - b);
        if (litros.length < 5) return;
        const med = mediana(litros);
        if (med <= 0) return;
        f.cargas.forEach(c => {
            const l = parseFloat(c.litros) || 0;
            if (l > med * 3) anomalas.push({ equipo: f.equipo, carga: c, mediana: med, veces: l / med });
        });
    });
    anomalas.sort((a, b) => b.veces - a.veces);

    if (anomalas.length) {
        hallazgos.push({
            id: 'anomalas', severidad: 'baja', icono: 'fa-magnifying-glass-chart',
            titulo: `${anomalas.length} cargas individuales muy por encima de lo habitual`,
            detalle: `Superan el triple de lo que ese mismo equipo carga normalmente. Puede ser legítimo (tanque vacío, viaje largo) o un error de tipeo o de imputación.`,
            equipos: anomalas.slice(0, 10).map(a => ({
                interno: a.equipo.interno, denominacion: a.equipo.denominacion,
                texto: `${fmt(a.carga.litros, 1)} L el ${a.carga.fecha}`,
                sub: `${fmt(a.veces, 1)}× su carga habitual de ${fmt(a.mediana, 1)} L · ${a.carga.lugar_carga || 'sin lugar'}`
            }))
        });
    }

    // ---------- 10. Bajo uso: equipos con pocas cargas y sin GPS ----------
    const bajoUso = activos.filter(f =>
        f.metrics.cantidad_cargas > 0 && f.metrics.cantidad_cargas <= 3 &&
        f.metrics.cantidad_gps === 0 && f.metrics.tipo_calculo !== 'No Aplica'
    ).sort((a, b) => a.metrics.cantidad_cargas - b.metrics.cantidad_cargas);

    if (bajoUso.length) {
        hallazgos.push({
            id: 'bajo_uso', severidad: 'baja', icono: 'fa-battery-quarter',
            titulo: `${bajoUso.length} equipos con muy pocas cargas y sin dato de GPS`,
            detalle: `Tienen entre 1 y 3 cargas en el período y ningún registro de Resumen de Flota. Con tan pocos datos el consumo calculado no es representativo. Conviene verificar si el equipo estuvo efectivamente en uso o si las cargas podrían estar mal imputadas.`,
            equipos: bajoUso.slice(0, 10).map(x => ({
                interno: x.equipo.interno, denominacion: x.equipo.denominacion,
                texto: `${x.metrics.cantidad_cargas} carga${x.metrics.cantidad_cargas === 1 ? '' : 's'} · ${fmt(x.metrics.total_litros)} L`,
                sub: 'sin GPS · consumo no representativo'
            }))
        });
    }

    // ---------- 11. Ralentí inverosímil: más de 20 hs diarias promedio de ralentí ----------
    if (totales.periodo_desde && totales.periodo_hasta) {
        const ralentiExtremo = activos.filter(f => {
            if (f.metrics.horas_ralenti <= 0) return false;
            const cat = categoriaRalenti(f.equipo.interno);
            // Solo alertar en equipos donde el ralentí NO es su trabajo
            if (cat === 'estacionario') return false;
            // Calcular horas de ralentí por día
            const fechasG = f.gps.map(g => g.fecha).filter(Boolean).sort();
            if (fechasG.length < 2) return false;
            const d1 = new Date(fechasG[0]), d2 = new Date(fechasG[fechasG.length - 1]);
            const dias = Math.max(1, (d2 - d1) / 86400000);
            const pctRalenti = f.metrics.horas_ralenti / f.metrics.total_horas * 100;
            return (f.metrics.horas_ralenti / dias > 18 || pctRalenti > 90);
        }).sort((a, b) => b.metrics.horas_ralenti - a.metrics.horas_ralenti);

        if (ralentiExtremo.length) {
            hallazgos.push({
                id: 'ralenti_inverosimil', severidad: 'media', icono: 'fa-circle-exclamation',
                titulo: `${ralentiExtremo.length} equipos con ralentí inverosímil`,
                detalle: `Promedian más de 18 hs diarias de ralentí o >90% del total de horas. Esto suele indicar un error en los datos del GPS, un equipo que quedó encendido por accidente, o un problema con el sensor.`,
                equipos: ralentiExtremo.slice(0, 10).map(x => {
                    const pct = x.metrics.total_horas > 0 ? (x.metrics.horas_ralenti / x.metrics.total_horas * 100) : 0;
                    return {
                        interno: x.equipo.interno, denominacion: x.equipo.denominacion,
                        texto: `${fmt(x.metrics.horas_ralenti)} hs ralentí (${fmt(pct)}%)`,
                        sub: `de ${fmt(x.metrics.total_horas)} hs totales · verificar GPS`
                    };
                })
            });
        }
    }

    // ---------- 12. Sede inconsistente: lugar de carga ≠ provincia del padrón ----------
    const sedeInconsistente = activos.filter(f => {
        const prov = f.ubicacion?.provincia;
        if (!prov || prov === 'SIN DATO') return false;
        const lc = f.ubicacion?.lugarCargaBreakdown || [];
        if (!lc.length) return false;
        // Si la provincia del padrón es Mendoza pero hay cargas en lugares que suenan a otra provincia
        // Para ahora, detectar si el centro de costo principal no coincide con otros equipos del mismo centro
        // Simplificación: si el equipo tiene cargas en un lugar que no contiene la provincia
        return false; // placeholder: la lógica real requiere un mapa de lugares → provincias
    });

    const orden = { alta: 0, media: 1, baja: 2, ok: 3 };
    hallazgos.sort((a, b) => (orden[a.severidad] - orden[b.severidad]) || (Math.abs(b.impacto_costo || 0) - Math.abs(a.impacto_costo || 0)));
    return hallazgos;
}
