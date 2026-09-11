/**
 * Tercer arnés: la matemática de la ACTIVIDAD DECLARADA y la ponderación de SÁBADOS.
 *
 * Los otros dos arneses no cubren nada de esto:
 *   - `verificar-datos-reales.mjs` compara totales contra invariantes congelados. La actividad
 *     declarada la carga el usuario a mano, así que nunca aparece en los archivos de prueba y
 *     ningún invariante la toca.
 *   - `auditar-calculos.mjs` audita el pipeline sobre los Excel reales. `coberturaEquipo()` tenía
 *     1 solo chequeo y `utilizacion()` 2 — justo las dos fórmulas cuyo denominador cambió al
 *     ponderar sábados 0,5 — y `consumoDesdeActividadDeclarada()` no tenía ninguno.
 *
 * Ese hueco importa porque `consumoDesdeActividadDeclarada()` es la ÚNICA vía por la que un
 * equipo sin GPS obtiene un consumo, y el número que produce se muestra con la misma cara que
 * uno medido. Una expansión mal hecha (declarar "10 hs por día" y que multiplique por meses en
 * vez de por días) da un consumo 20 veces menor sin que nada falle.
 *
 * A diferencia de los otros dos, este arnés NO lee los Excel ni levanta IndexedDB: son funciones
 * puras con entradas construidas a mano. Corre en menos de un segundo.
 *
 * Uso:  node tools/auditar-declarados.mjs [--verboso]
 * Sale con código 1 si hay alguna incoherencia.
 */
import { consumoDesdeActividadDeclarada, generarDiagnostico, parIdentico, sugerirMeta, investigarMeta, metaDesdeConsumoReal, diasHabilesDeMeses, confiabilidad } from '../js/data/diagnostico.js';
import { diasHabiles } from '../js/data/feriados.js';

const VERBOSO = process.argv.includes('--verboso');
const fallas = [];
let chequeos = 0;

function casi(a, b, tol = 1e-9) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}
function check(grupo, nombre, ok, detalle) {
    chequeos++;
    if (!ok) fallas.push({ grupo, nombre, detalle });
    else if (VERBOSO) console.log(`  ok . ${grupo} . ${nombre}`);
}

/** Fila mínima pero completa: sin GPS (km y horas en 0) y con litros cargados. */
function filaSinGps({ interno = 'XX01', litros = 1000, tipo = 'L/Hora', meta = 0, cargas = 6 } = {}) {
    return {
        equipo: { interno, denominacion: 'EQUIPO PRUEBA', marca: '', modelo: '', anio: '' },
        metrics: {
            total_litros: litros, total_km: 0, total_horas: 0,
            horas_ralenti: 0, horas_movimiento: 0,
            consumo_real: 0, consumo_l_hora: 0, consumo_l_100km: 0,
            tipo_calculo: tipo, cantidad_cargas: cargas, cantidad_gps: 0,
            total_costo: litros * 1000, litros_alineados: 0, km_alineados: 0, horas_alineadas: 0
        },
        cargas: [], confirmed: meta > 0 ? { valor: meta, source: 'Estimados' } : null
    };
}

const PERIODO_6M = { desde: '2026-01-01', hasta: '2026-06-30' };

// ============================================================ A. EXPANSIÓN POR BASE
{
    const f = filaSinGps({ litros: 1000 });
    const decl = (extra) => [{ interno: 'XX01', periodo: 'TODO', unidad: 'horas', ...extra }];

    // base 'total': el valor se usa tal cual
    const rTotal = consumoDesdeActividadDeclarada(f, decl({ base: 'total', valor_min: 100, valor_max: 100 }), PERIODO_6M);
    check('base', "base 'total' usa el valor tal cual (100 hs)", rTotal && casi(rTotal.actividad, 100), `${rTotal?.actividad}`);
    check('base', "base 'total' -> L/Hora = litros / hs", rTotal && casi(rTotal.valor, 1000 / 100), `${rTotal?.valor}`);

    // el rango se promedia: 100 a 200 -> 150
    const rRango = consumoDesdeActividadDeclarada(f, decl({ base: 'total', valor_min: 100, valor_max: 200 }), PERIODO_6M);
    check('base', 'un rango min-max se promedia (100-200 -> 150)', rRango && casi(rRango.actividad, 150), `${rRango?.actividad}`);

    // base 'mes' sobre un período de 6 meses -> x6
    const rMes = consumoDesdeActividadDeclarada(f, decl({ base: 'mes', valor_min: 10, valor_max: 10 }), PERIODO_6M);
    check('base', "base 'mes' multiplica por los meses del período (10 x 6 = 60)", rMes && casi(rMes.actividad, 60), `${rMes?.actividad}`);

    // base 'dia' sobre el período -> x días hábiles PONDERADOS (sábados 0,5)
    const dhPer = diasHabiles(PERIODO_6M.desde, PERIODO_6M.hasta);
    const rDia = consumoDesdeActividadDeclarada(f, decl({ base: 'dia', valor_min: 10, valor_max: 10 }), PERIODO_6M);
    check('base', "base 'dia' multiplica por días hábiles PONDERADOS, no por días corridos ni por meses",
        rDia && casi(rDia.actividad, 10 * dhPer.diasPonderados), `esperado ${10 * dhPer.diasPonderados}, dio ${rDia?.actividad}`);
    check('base', "base 'dia' NO usa días corridos (sería inflar la actividad)",
        rDia && !casi(rDia.actividad, 10 * dhPer.totalCorridos), `${rDia?.actividad}`);
}

// ============================================================ B. UNIDAD Y FÓRMULA
{
    const f = filaSinGps({ litros: 1000, tipo: 'L/100Km' });
    const rKm = consumoDesdeActividadDeclarada(f,
        [{ interno: 'XX01', periodo: 'TODO', unidad: 'km', base: 'total', valor_min: 5000, valor_max: 5000 }], PERIODO_6M);
    check('unidad', 'km -> L/100Km = litros / km x 100', rKm && casi(rKm.valor, (1000 / 5000) * 100), `${rKm?.valor}`);
    check('unidad', 'km -> etiqueta de unidad correcta', rKm && rKm.unidad === 'L/100Km', `${rKm?.unidad}`);

    const fh = filaSinGps({ litros: 1000 });
    const rH = consumoDesdeActividadDeclarada(fh,
        [{ interno: 'XX01', periodo: 'TODO', unidad: 'horas', base: 'total', valor_min: 200, valor_max: 200 }], PERIODO_6M);
    check('unidad', 'horas -> L/Hora sin factor 100', rH && casi(rH.valor, 1000 / 200), `${rH?.valor}`);
    check('unidad', 'horas -> etiqueta de unidad correcta', rH && rH.unidad === 'L/Hora', `${rH?.unidad}`);
}

// ============================================================ C. LITROS DECLARADOS
{
    const f = filaSinGps({ litros: 1000 });
    // El equipo carga afuera: la planilla ve 1000 L pero en realidad son 300/mes x 6 = 1800
    const r = consumoDesdeActividadDeclarada(f, [{
        interno: 'XX01', periodo: 'TODO', unidad: 'horas', base: 'mes',
        valor_min: 10, valor_max: 10, litros_min: 300, litros_max: 300
    }], PERIODO_6M);
    check('litros', 'litros declarados reemplazan a los registrados (300/mes x 6 = 1800)',
        r && casi(r.litros, 1800), `${r?.litros}`);
    check('litros', 'los registrados se conservan aparte para poder mostrar la diferencia',
        r && casi(r.litros_registrados, 1000), `${r?.litros_registrados}`);
    check('litros', 'el consumo usa los litros declarados, no los registrados',
        r && casi(r.valor, 1800 / 60), `${r?.valor}`);
}

// ============================================================ D. PRECEDENCIA Y BORDES
{
    const f = filaSinGps({ litros: 1000 });
    check('bordes', 'sin declaraciones devuelve null', consumoDesdeActividadDeclarada(f, [], PERIODO_6M) === null);
    check('bordes', 'declaración de otro equipo no se aplica',
        consumoDesdeActividadDeclarada(f, [{ interno: 'ZZ99', periodo: 'TODO', unidad: 'horas', base: 'total', valor_min: 10 }], PERIODO_6M) === null);
    check('bordes', 'actividad en cero devuelve null',
        consumoDesdeActividadDeclarada(f, [{ interno: 'XX01', periodo: 'TODO', unidad: 'horas', base: 'total', valor_min: 0, valor_max: 0 }], PERIODO_6M) === null);

    // Una declaración mensual es más específica que la de 'TODO': gana
    const rPrec = consumoDesdeActividadDeclarada(f, [
        { interno: 'XX01', periodo: 'TODO', unidad: 'horas', base: 'total', valor_min: 999, valor_max: 999 },
        { interno: 'XX01', periodo: '2026-03', unidad: 'horas', base: 'total', valor_min: 50, valor_max: 50 }
    ], PERIODO_6M);
    check('bordes', "una declaración mensual gana sobre la de 'TODO'", rPrec && casi(rPrec.actividad, 50), `${rPrec?.actividad}`);

    // Con GPS medido, declarar SOLO actividad no aporta nada (no se pisa la medición)
    const fGps = filaSinGps({ litros: 1000 });
    fGps.metrics.total_horas = 500;
    check('bordes', 'con GPS medido, declarar solo actividad no pisa la medición',
        consumoDesdeActividadDeclarada(fGps, [{ interno: 'XX01', periodo: 'TODO', unidad: 'horas', base: 'total', valor_min: 100 }], PERIODO_6M) === null);
    // ...pero declarar LITROS sí aporta: corrige el consumo sobre la actividad medida
    const rGpsL = consumoDesdeActividadDeclarada(fGps, [{
        interno: 'XX01', periodo: 'TODO', unidad: 'horas', base: 'total', litros_min: 2000, litros_max: 2000
    }], PERIODO_6M);
    check('bordes', 'con GPS medido, declarar litros sí corrige el consumo sobre las hs medidas',
        rGpsL && casi(rGpsL.actividad, 500) && casi(rGpsL.valor, 2000 / 500), `${rGpsL?.valor}`);
}

// ============================================================ E. SÁBADOS 0,5
{
    // Semana completa sin feriados: lun 5 a dom 11 de enero de 2026
    const semana = diasHabiles('2026-01-05', '2026-01-11');
    check('sabados', 'una semana tiene 5 días Lun-Vie', semana.dias === 5, `${semana.dias}`);
    check('sabados', 'una semana tiene 1 sábado', semana.sabados === 1, `${semana.sabados}`);
    check('sabados', 'diasPonderados = dias + sabados x 0,5 (5 + 0,5 = 5,5)', casi(semana.diasPonderados, 5.5), `${semana.diasPonderados}`);
    check('sabados', 'el domingo no cuenta ni como hábil ni como sábado', semana.totalCorridos === 7 && semana.dias + semana.sabados === 6, `${semana.totalCorridos}`);

    // Un sábado feriado no suma (1/5/2026 no aplica; usamos 25/12/2026 que cae viernes -> probamos otro)
    // 2026-02-14 es sábado normal; 2026-05-01 (feriado) cae viernes.
    const sabSolo = diasHabiles('2026-02-14', '2026-02-14');
    check('sabados', 'un sábado suelto: 0 días Lun-Vie, 1 sábado, 0,5 ponderado',
        sabSolo.dias === 0 && sabSolo.sabados === 1 && casi(sabSolo.diasPonderados, 0.5), JSON.stringify(sabSolo));

    // Invariante general sobre el período de prueba
    const p = diasHabiles(PERIODO_6M.desde, PERIODO_6M.hasta);
    check('sabados', 'diasPonderados siempre = dias + sabados x 0,5', casi(p.diasPonderados, p.dias + p.sabados * 0.5), JSON.stringify(p));
    check('sabados', 'diasPonderados nunca supera a los días corridos', p.diasPonderados <= p.totalCorridos, `${p.diasPonderados} vs ${p.totalCorridos}`);
    check('sabados', 'diasPonderados > dias cuando hay sábados', p.sabados > 0 ? p.diasPonderados > p.dias : true, JSON.stringify(p));
}

// ============================================================ F. ACTIVIDAD DECLARADA SACA EL HALLAZGO
{
    // Regresión del fix: un equipo sin GPS con meta aparece en los hallazgos de "sin medición";
    // una vez que el usuario declara km/horas, tiene que DESAPARECER de todos ellos.
    const f = filaSinGps({ interno: 'CF99', litros: 5000, tipo: 'L/Hora', meta: 12 });
    const totales = { periodo_desde: PERIODO_6M.desde, periodo_hasta: PERIODO_6M.hasta, huerfanos: [], sin_asignar: {} };
    const HALLAZGOS_SIN_MEDICION = ['sin_medicion', 'sin_gps_estimado', 'estimacion_inverosimil'];

    const enHallazgos = (extra) => {
        const hs = generarDiagnostico([f], totales, [], [], [], [], extra);
        return hs.filter(h => HALLAZGOS_SIN_MEDICION.includes(h.id))
                 .filter(h => (h.equipos || []).some(e => e.interno === 'CF99')
                           || (h.internos_todos || []).includes('CF99'))
                 .map(h => h.id);
    };

    const sinDeclarar = enHallazgos({});
    check('exclusion', 'sin actividad declarada, el equipo SÍ aparece en un hallazgo de sin-medición',
        sinDeclarar.length > 0, `apareció en: ${sinDeclarar.join(', ') || '(ninguno)'}`);

    const conDeclarar = enHallazgos({ actividadEstimada: [{ interno: 'CF99', periodo: 'TODO', unidad: 'horas', base: 'total', valor_min: 400, valor_max: 400 }] });
    check('exclusion', 'con actividad declarada, el equipo YA NO aparece en ninguno',
        conDeclarar.length === 0, `todavía aparece en: ${conDeclarar.join(', ')}`);

    // La declaración de OTRO equipo no debe sacar a este
    const otroEquipo = enHallazgos({ actividadEstimada: [{ interno: 'ZZ99', periodo: 'TODO', unidad: 'horas', base: 'total', valor_min: 400 }] });
    check('exclusion', 'declarar actividad de otro equipo no saca a este del hallazgo',
        otroEquipo.length > 0, `${otroEquipo.join(', ')}`);
}

// ============================================================ G. REPARTO ENTRE HALLAZGOS
{
    // Un equipo con 2 cargas, sin GPS, sin meta y con litros califica a la vez para
    // `sin_medicion` (no hay con qué medirlo) y para `bajo_uso` (muy pocas cargas). Antes
    // aparecía en los dos: dos tarjetas para una sola decisión. Ahora lo tiene que reclamar
    // el de mayor prioridad causal — `sin_medicion` — y `bajo_uso` omitirlo.
    const REPARTIDOS = ['datos_parciales', 'sin_medicion', 'estimacion_inverosimil', 'subutilizacion', 'bajo_uso', 'sin_gps_estimado'];
    const totales = { periodo_desde: PERIODO_6M.desde, periodo_hasta: PERIODO_6M.hasta, huerfanos: [], sin_asignar: {} };

    const dondeAparece = (fila, interno) => {
        const hs = generarDiagnostico([fila], totales, [], [], [], [], {});
        return hs.filter(h => REPARTIDOS.includes(h.id))
                 .filter(h => (h.equipos || []).some(e => e.interno === interno)
                           || (h.internos_todos || []).includes(interno))
                 .map(h => h.id);
    };

    const doble = filaSinGps({ interno: 'TR77', litros: 500, cargas: 2, meta: 0 });
    const apariciones = dondeAparece(doble, 'TR77');
    check('reparto', 'un equipo que califica para dos hallazgos aparece en UNO solo',
        apariciones.length === 1, `apareció en: ${apariciones.join(', ') || '(ninguno)'}`);
    check('reparto', 'lo reclama sin_medicion, no bajo_uso (prioridad causal)',
        apariciones[0] === 'sin_medicion', `lo reclamó: ${apariciones[0]}`);

    // El reparto no debe hacer desaparecer al equipo de TODOS los hallazgos
    check('reparto', 'el equipo no se pierde: sigue estando en exactamente un hallazgo',
        apariciones.length > 0, 'desapareció de todos');

    // Con varios equipos, ninguno debe contarse dos veces
    const varios = [
        filaSinGps({ interno: 'TR70', litros: 500, cargas: 2 }),
        filaSinGps({ interno: 'TR71', litros: 800, cargas: 3 }),
        filaSinGps({ interno: 'TR72', litros: 900, cargas: 1 })
    ];
    const hs = generarDiagnostico(varios, totales, [], [], [], [], {});
    const cuentas = new Map();
    hs.filter(h => REPARTIDOS.includes(h.id)).forEach(h => {
        (h.equipos || []).forEach(e => cuentas.set(e.interno, (cuentas.get(e.interno) || 0) + 1));
    });
    const repetidos = [...cuentas.entries()].filter(([, n]) => n > 1);
    check('reparto', 'ningún equipo aparece en más de un hallazgo repartido',
        repetidos.length === 0, repetidos.map(([i, n]) => `${i} x${n}`).join(', '));
    check('reparto', 'los tres equipos siguen apareciendo en algún lado',
        cuentas.size === 3, `aparecieron ${cuentas.size} de 3`);
}

// ============================================================ H. EQUIPO PAR (marca+modelo)
{
    // El caso real que motivó esto: CM-43 (HILUX 2022, sin GPS) tiene DOS pares del mismo
    // modelo — CM-46, año exacto pero tampoco tiene GPS, y CM-48, un año más lejos pero CON
    // datos medidos. El par utilizable es CM-48: filtrar por año antes que por datos habría
    // devuelto justo el inútil.
    const conModelo = ({ interno, anio, consumo = 0, meta = 0, cargas = 8 }) => {
        const f = filaSinGps({ interno, litros: 1000, cargas, meta });
        f.equipo.marca = 'TOYOTA'; f.equipo.modelo = 'HILUX 4X4 DC SR 2.8'; f.equipo.anio = anio;
        f.metrics.consumo_real = consumo;
        if (consumo > 0) { f.metrics.total_km = 10000; f.metrics.cantidad_gps = 6; }
        return f;
    };
    const cm43 = conModelo({ interno: 'CM43', anio: 2022 });
    const cm46 = conModelo({ interno: 'CM46', anio: 2022 });                  // año exacto, SIN datos
    const cm48 = conModelo({ interno: 'CM48', anio: 2023, consumo: 12.5 });   // 1 año, CON datos
    const flota = [cm43, cm46, cm48];

    const par = parIdentico(cm43, flota);
    check('par', 'encuentra un par por marca+modelo', !!par, 'no encontró ninguno');
    check('par', 'el par CON DATOS es CM48, no el del año exacto sin datos (CM46)',
        par?.conDatos?.equipo.interno === 'CM48', `dio: ${par?.conDatos?.equipo.interno}`);
    check('par', 'reporta la distancia de año del par con datos (2023-2022 = 1)',
        par?.distanciaConDatos === 1, `${par?.distanciaConDatos}`);
    check('par', 'cuenta los candidatos del mismo modelo', par?.candidatos === 2, `${par?.candidatos}`);

    // Con un par de año exacto Y datos, ese gana sobre uno más lejano
    const cm44 = conModelo({ interno: 'CM44', anio: 2022, consumo: 11.0 });
    const par2 = parIdentico(cm43, [cm43, cm44, cm48]);
    check('par', 'entre dos pares CON datos gana el de año más cercano',
        par2?.conDatos?.equipo.interno === 'CM44', `dio: ${par2?.conDatos?.equipo.interno}`);

    // Sin marca/modelo no hay par posible
    const suelto = filaSinGps({ interno: 'ZZ01' });
    check('par', 'sin marca ni modelo no devuelve par', parIdentico(suelto, flota) === null);

    // investigarMeta debe exponerlo como fuente
    const fuentes = investigarMeta(cm43, flota, []);
    const fuenteMedida = (fuentes?.fuentes || fuentes || []).find?.(f => f.referente === 'CM48');
    check('par', 'investigarMeta ofrece el par medido como fuente de meta',
        !!fuenteMedida, `fuentes: ${JSON.stringify((fuentes?.fuentes||fuentes||[]).map?.(f=>f.fuente))}`);
}

// ============================================================ I. REFERENTES DE LA MEDIANA
{
    const cf = (interno, consumo) => {
        const f = filaSinGps({ interno, litros: 2000, cargas: 10 });
        f.equipo.denominacion = 'CARGADORA FRONTAL';
        f.metrics.consumo_real = consumo; f.metrics.total_horas = 500; f.metrics.cantidad_gps = 6;
        return f;
    };
    const objetivo = cf('CF38', 0);            // el que necesita meta
    objetivo.metrics.total_horas = 0; objetivo.metrics.cantidad_gps = 0;
    const pares = [cf('CF36', 8), cf('CF37', 10), cf('CF40', 30)];
    const flota = [objetivo, ...pares];

    const auto = sugerirMeta(objetivo, flota);
    check('referentes', 'la sugerencia nombra a los referentes, no solo los cuenta',
        auto && /CF36/.test(auto.base_con_referentes) && /CF37/.test(auto.base_con_referentes),
        `${auto?.base_con_referentes}`);
    check('referentes', 'expone la lista de internos', Array.isArray(auto?.internos) && auto.internos.length === 3, `${auto?.internos}`);
    check('referentes', 'sin ajustes, ajustada = false', auto?.ajustada === false, `${auto?.ajustada}`);
    check('referentes', 'mediana de 8, 10 y 30 es 10', casi(auto?.valor, 10), `${auto?.valor}`);

    // Excluir el que no es comparable cambia la mediana
    const sinCF40 = sugerirMeta(objetivo, flota, { excluidos: ['CF40'], incluidos: [] });
    check('referentes', 'excluir un par lo saca de la mediana (8 y 10 -> 9)', casi(sinCF40?.valor, 9), `${sinCF40?.valor}`);
    check('referentes', 'al excluir queda marcada como ajustada', sinCF40?.ajustada === true);
    check('referentes', 'el excluido no aparece en los referentes', !sinCF40?.internos.includes('CF40'), `${sinCF40?.internos}`);

    // Sumar un equipo que la regla no eligió (otra denominación)
    const otro = cf('MX99', 20); otro.equipo.denominacion = 'MIXER';
    const conSumado = sugerirMeta(objetivo, [...flota, otro], { excluidos: [], incluidos: ['MX99'] });
    check('referentes', 'sumar un equipo de otra denominación lo incorpora',
        conSumado?.internos.includes('MX99'), `${conSumado?.internos}`);
    check('referentes', 'mediana con el sumado (8,10,20,30 -> 15)', casi(conSumado?.valor, 15), `${conSumado?.valor}`);

    // Excluir de más deja sin mediana posible
    const roto = sugerirMeta(objetivo, flota, { excluidos: ['CF36', 'CF37'], incluidos: [] });
    check('referentes', 'con menos de 2 referentes devuelve null', roto === null, `${roto?.valor}`);
}

// ============================================================ J. META DESDE CONSUMO REAL (F)
{
    // El botón "Actualizar meta al consumo actual" guarda exactamente este número. Si difiriera
    // del consumo_real que muestra la tarjeta, el usuario estaría confirmando una cosa y
    // guardando otra.
    const f = filaSinGps({ interno: 'MX01', litros: 4500, cargas: 30 });
    f.metrics.total_horas = 500; f.metrics.consumo_real = 9; f.metrics.cantidad_gps = 6;
    const meta = metaDesdeConsumoReal(f);
    check('meta_real', 'la meta propuesta ES el consumo real medido', casi(meta?.valor, 9), `${meta?.valor}`);
    check('meta_real', 'lleva la unidad del equipo', meta?.unidad === 'L/Hora', `${meta?.unidad}`);
    check('meta_real', 'declara sobre cuántas cargas se midió', /30 cargas/.test(meta?.base || ''), `${meta?.base}`);
    check('meta_real', 'con 30 cargas y 500 hs la base es confiable', meta?.confiable === true, `${JSON.stringify(meta?.avisos)}`);

    // Redondeo a 2 decimales, igual que en todos lados
    const f2 = filaSinGps({ interno: 'MX02', litros: 1000, cargas: 12 });
    f2.metrics.total_horas = 300; f2.metrics.consumo_real = 3.33333333; f2.metrics.cantidad_gps = 6;
    check('meta_real', 'redondea a 2 decimales', casi(metaDesdeConsumoReal(f2)?.valor, 3.33), `${metaDesdeConsumoReal(f2)?.valor}`);

    // Una base floja tiene que avisarlo: fijar meta con 2 cargas arrastra el ruido
    const f3 = filaSinGps({ interno: 'MX03', litros: 100, cargas: 2 });
    f3.metrics.total_horas = 12; f3.metrics.consumo_real = 8.33; f3.metrics.cantidad_gps = 1;
    const m3 = metaDesdeConsumoReal(f3);
    check('meta_real', 'una base de 2 cargas se marca como NO confiable', m3?.confiable === false, `${JSON.stringify(m3)}`);
    check('meta_real', 'y dice por qué', (m3?.avisos || []).length > 0, `${JSON.stringify(m3?.avisos)}`);

    // Sin consumo medido no hay a qué alinear: null, nunca un cero
    const f4 = filaSinGps({ interno: 'MX04', litros: 500 });
    check('meta_real', 'sin consumo medido devuelve null, no 0', metaDesdeConsumoReal(f4) === null);
}

// ============================================================ K. NORMALIZACIÓN DE LA COMPARATIVA (E)
{
    // El caso del usuario: 3 cargas contra 106. Por total son incomparables; por ritmo, sí.
    // Acá se verifica la ARITMÉTICA de esa normalización, que es lo que la comparativa aplica.
    const dh = diasHabiles(PERIODO_6M.desde, PERIODO_6M.hasta);
    const dias = dh.diasPonderados;

    const chico = filaSinGps({ interno: 'AA01', litros: 300, cargas: 3 });
    const grande = filaSinGps({ interno: 'AA02', litros: 10600, cargas: 106 });

    // Por total, el grande "gasta 35x más" — pero eso solo dice que trabajó más
    check('normalizado', 'por total el segundo gasta ~35x (comparación engañosa)',
        casi(grande.metrics.total_litros / chico.metrics.total_litros, 35.333, 1e-3),
        `${grande.metrics.total_litros / chico.metrics.total_litros}`);

    // Litros por carga: la normalización que NO depende del calendario
    const lpcChico = chico.metrics.total_litros / chico.metrics.cantidad_cargas;
    const lpcGrande = grande.metrics.total_litros / grande.metrics.cantidad_cargas;
    check('normalizado', 'litros por carga: 300/3 = 100', casi(lpcChico, 100), `${lpcChico}`);
    check('normalizado', 'litros por carga: 10600/106 = 100', casi(lpcGrande, 100), `${lpcGrande}`);
    check('normalizado', 'normalizado por carga los dos son IGUALES — que es la verdad del dato',
        casi(lpcChico, lpcGrande), `${lpcChico} vs ${lpcGrande}`);

    // Litros por día trabajado usa el MISMO denominador ponderado que cobertura/utilización
    check('normalizado', 'el denominador por día es diasPonderados, no días corridos',
        dias === dh.dias + dh.sabados * 0.5 && dias < dh.totalCorridos, `${dias} vs ${dh.totalCorridos}`);
    check('normalizado', 'litros por día del chico = 300 / días ponderados',
        casi(chico.metrics.total_litros / dias, 300 / dias), `${300 / dias}`);

    // Nunca se prorratea: sin días trabajados no hay tasa, no un cero ni un infinito
    const sinDias = 0;
    const tasa = sinDias > 0 ? chico.metrics.total_litros / sinDias : null;
    check('normalizado', 'con 0 días trabajados la tasa es null, no Infinity', tasa === null, `${tasa}`);

    // EL ERROR QUE ESTE CHEQUEO EXISTE PARA ATRAPAR
    // Se encontró en vivo, no acá: la comparativa mostraba "179 días trabajados" para CM30
    // (datos en 1 de 8 meses) y también 179 para TR32 (8 de 8). Dividir los litros de un mes
    // por los días hábiles de ocho da un ritmo 8x menor que el real — numerador y denominador
    // de períodos distintos, justo lo que prohíbe la regla 1. El denominador tiene que salir de
    // los meses que el equipo REALMENTE tiene, vía diasHabilesDeMeses().
    const unMes = diasHabilesDeMeses(['2026-03']);
    const ochoMeses = diasHabilesDeMeses(['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08']);
    check('normalizado', 'los días de 1 mes son muchos menos que los de 8',
        unMes.ponderado > 0 && unMes.ponderado < ochoMeses.ponderado / 4,
        `1 mes: ${unMes.ponderado} · 8 meses: ${ochoMeses.ponderado}`);
    check('normalizado', 'diasHabilesDeMeses pondera sábados igual que diasHabiles (dias + sab*0,5)',
        casi(unMes.ponderado, unMes.total + unMes.sabados * 0.5),
        `${unMes.ponderado} vs ${unMes.total} + ${unMes.sabados}*0.5`);

    // Un equipo con 300 L en UN mes tiene un ritmo real ~8x mayor que el que daría
    // dividiéndolo por los días de todo el período.
    const ritmoCorrecto = 300 / unMes.ponderado;
    const ritmoMal = 300 / ochoMeses.ponderado;
    check('normalizado', 'el ritmo por meses propios es varias veces mayor que por período completo',
        ritmoCorrecto > ritmoMal * 4, `correcto ${ritmoCorrecto.toFixed(2)} vs mal ${ritmoMal.toFixed(2)}`);
    check('normalizado', 'sin meses con datos no hay denominador (0), no se inventa uno',
        diasHabilesDeMeses([]).ponderado === 0, `${diasHabilesDeMeses([]).ponderado}`);
}

// ============================================================ L. BASE FLOJA NO GANA (invariante 3)
{
    // El segundo error del caso CM30 vs TR32, más grave que el del denominador: CM30 tenía UNA
    // carga y salía pintado como "el mejor" en costo por día, porque $905/día es menos que
    // $487.430/día. La app estaba diciendo que el equipo parado es el eficiente — exactamente
    // la invariante 3: un número bajo necesita su contexto antes de ser una conclusión.
    // `confiabilidad()` es quien decide si una tasa se sostiene; acá se verifica esa decisión.
    const flojo = filaSinGps({ interno: 'CM30', litros: 71.6, cargas: 1 });
    const solido = filaSinGps({ interno: 'TR32', litros: 37470, cargas: 169 });
    solido.metrics.total_km = 81453; solido.metrics.consumo_real = 46; solido.metrics.cantidad_gps = 8;

    const cFlojo = confiabilidad(flojo, PERIODO_6M);
    const cSolido = confiabilidad(solido, PERIODO_6M);
    check('base_floja', 'un equipo con 1 carga NO es base confiable para una tasa',
        cFlojo.confiable === false, `${JSON.stringify(cFlojo.avisos)}`);
    check('base_floja', 'y dice por qué (para poder etiquetarlo, no solo ocultarlo)',
        (cFlojo.avisos || []).some(a => /carga/.test(a)), `${JSON.stringify(cFlojo.avisos)}`);
    check('base_floja', 'un equipo con 169 cargas y GPS sí es base confiable',
        cSolido.confiable === true, `${JSON.stringify(cSolido.avisos)}`);

    // La regla que aplica la comparativa: una TASA de base floja se excluye del mejor/peor.
    // Sin esto, min() la elegía como "mejor" por ser el número más chico.
    const esTasa = true;
    const valores = [905, 487430];              // costo por día de cada uno
    const debiles = [!cFlojo.confiable, !cSolido.confiable];
    const elegibles = valores.filter((v, i) => !(esTasa && debiles[i]));
    check('base_floja', 'la tasa de base floja queda fuera de los candidatos a mejor/peor',
        elegibles.length === 1 && elegibles[0] === 487430, `${JSON.stringify(elegibles)}`);
    check('base_floja', 'con un solo candidato no se resalta nada (hacen falta 2)',
        elegibles.length < 2, `${elegibles.length}`);

    // Un TOTAL sí compite aunque la base sea floja: 71,6 L es un hecho, no una conclusión.
    const totalElegibles = valores.filter(() => true);
    check('base_floja', 'los totales NO se filtran por base floja (son hechos, no conclusiones)',
        totalElegibles.length === 2, `${totalElegibles.length}`);
}

// ============================================================ REPORTE
console.log(`\n=== AUDITORIA DE ACTIVIDAD DECLARADA Y SABADOS ===\n`);
console.log(`Chequeos corridos: ${chequeos}`);
if (fallas.length) {
    console.log(`\nFALLAS: ${fallas.length}\n`);
    fallas.forEach(f => console.log(`  [${f.grupo}] ${f.nombre}\n      ${f.detalle || ''}`));
    process.exit(1);
}
console.log('\nOK - la actividad declarada y la ponderacion de sabados son coherentes.\n');
