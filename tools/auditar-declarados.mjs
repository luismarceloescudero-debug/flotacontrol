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
import { consumoDesdeActividadDeclarada, generarDiagnostico } from '../js/data/diagnostico.js';
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
function filaSinGps({ interno = 'XX01', litros = 1000, tipo = 'L/Hora', meta = 0 } = {}) {
    return {
        equipo: { interno, denominacion: 'EQUIPO PRUEBA', marca: '', modelo: '', anio: '' },
        metrics: {
            total_litros: litros, total_km: 0, total_horas: 0,
            horas_ralenti: 0, horas_movimiento: 0,
            consumo_real: 0, consumo_l_hora: 0, consumo_l_100km: 0,
            tipo_calculo: tipo, cantidad_cargas: 6, cantidad_gps: 0,
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

// ============================================================ REPORTE
console.log(`\n=== AUDITORIA DE ACTIVIDAD DECLARADA Y SABADOS ===\n`);
console.log(`Chequeos corridos: ${chequeos}`);
if (fallas.length) {
    console.log(`\nFALLAS: ${fallas.length}\n`);
    fallas.forEach(f => console.log(`  [${f.grupo}] ${f.nombre}\n      ${f.detalle || ''}`));
    process.exit(1);
}
console.log('\nOK - la actividad declarada y la ponderacion de sabados son coherentes.\n');
