/**
 * Feriados nacionales de Argentina y cálculo de días hábiles.
 *
 * Sirve para contextualizar "22 cargas" con "¿en cuántos días hábiles pudieron pasar?" — un
 * dato que por sí solo (22 cargas en junio) no dice si es mucho o poco sin saber cuántos días
 * se trabajó ese mes.
 *
 * LISTA VERIFICADA: 2026, según Decreto 614/2025 (16 feriados). Los feriados fijos por ley
 * (1/1, 24/3, 2/4, 1/5, 25/5, 20/6, 9/7, 8/12, 25/12) se repiten todos los años en la misma
 * fecha. Los trasladables (Carnaval, Viernes Santo, Güemes, San Martín, Diversidad Cultural,
 * Soberanía Nacional) cambian de fecha cada año por decreto — hay que sumarlos a mano cuando
 * se confirme el decreto del año siguiente. Si un año no está en la lista, el cálculo de días
 * hábiles solo descuenta fines de semana (queda un poco optimista, pero nunca inventa fechas).
 */

const FERIADOS_FIJOS_MES_DIA = [
    [1, 1],   // Año Nuevo
    [3, 24],  // Día de la Memoria por la Verdad y la Justicia
    [4, 2],   // Veteranos y Caídos en la Guerra de Malvinas
    [5, 1],   // Día del Trabajador
    [5, 25],  // Revolución de Mayo
    [6, 20],  // Día de la Bandera (Belgrano)
    [7, 9],   // Día de la Independencia
    [12, 8],  // Inmaculada Concepción
    [12, 25]  // Navidad
];

// Trasladables/móviles confirmados por año (se van sumando a mano).
const FERIADOS_MOVILES = {
    2026: [
        '2026-02-16', '2026-02-17', // Carnaval
        '2026-04-03',               // Viernes Santo
        '2026-06-17',               // Gral. Güemes
        '2026-08-17',               // Gral. San Martín
        '2026-10-12',               // Diversidad Cultural
        '2026-11-20'                // Soberanía Nacional
    ]
};

const cache = new Map();

function feriadosDelAnio(anio) {
    if (cache.has(anio)) return cache.get(anio);
    const set = new Set(FERIADOS_MOVILES[anio] || []);
    FERIADOS_FIJOS_MES_DIA.forEach(([m, d]) => {
        set.add(`${anio}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    });
    cache.set(anio, set);
    return set;
}

/** ¿La fecha ISO (YYYY-MM-DD) cae en fin de semana? */
export function esFinDeSemana(fechaISO) {
    const d = new Date(fechaISO + 'T00:00:00');
    const dia = d.getDay();
    return dia === 0 || dia === 6;
}

/** ¿La fecha ISO cae en un feriado nacional? (según la lista disponible para ese año) */
export function esFeriado(fechaISO) {
    const anio = Number(String(fechaISO).slice(0, 4));
    return feriadosDelAnio(anio).has(String(fechaISO).slice(0, 10));
}

/** ¿Es día hábil (ni fin de semana ni feriado)? */
export function esDiaHabil(fechaISO) {
    return !!fechaISO && !esFinDeSemana(fechaISO) && !esFeriado(fechaISO);
}

/**
 * Cuenta días hábiles entre dos fechas ISO (inclusive). Si el año de alguna fecha no tiene
 * feriados móviles cargados, solo se descuentan fines de semana para ese tramo (se avisa
 * con `completo:false` para que la UI pueda aclararlo).
 */
export function diasHabiles(desdeISO, hastaISO) {
    if (!desdeISO || !hastaISO) return { dias: 0, totalCorridos: 0, completo: true };
    const desde = new Date(desdeISO + 'T00:00:00');
    const hasta = new Date(hastaISO + 'T00:00:00');
    if (isNaN(desde) || isNaN(hasta) || desde > hasta) return { dias: 0, totalCorridos: 0, completo: true };

    let dias = 0, totalCorridos = 0;
    let completo = true;
    const cur = new Date(desde);
    while (cur <= hasta) {
        const iso = cur.toISOString().slice(0, 10);
        const anio = cur.getFullYear();
        if (!FERIADOS_MOVILES[anio]) completo = false;
        totalCorridos++;
        if (esDiaHabil(iso)) dias++;
        cur.setDate(cur.getDate() + 1);
    }
    return { dias, totalCorridos, completo };
}
