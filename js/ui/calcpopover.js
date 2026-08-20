/**
 * Visor de "cómo se calculó este número".
 *
 * Cualquier elemento con `data-calc="<id>"` se vuelve clickeable y abre un panel con los
 * pasos del cálculo: qué se sumó, con qué se dividió, cuántos registros entraron y de qué
 * archivos salieron. La idea es que ningún número de la app sea una caja negra: si el
 * dashboard dice "39,28 L/100Km", tiene que poder mostrar de dónde salió ese 39,28.
 *
 * Además de los pasos, cada cálculo puede traer `acciones`: botones reales para hacer algo
 * con ese número en vez de solo mirarlo — ir a la tabla de datos que lo alimenta, filtrar el
 * panel para ver justo los equipos involucrados, etc.
 *
 * Zoom multi-nivel: cualquier `paso` o `accion` puede traer una función `zoom` (en vez de, o
 * además de, `onClick`) que devuelve un nuevo objeto de datos (mismo formato: título, valor,
 * pasos, fuentes, acciones...). Al hacer click se apila ese nivel encima del actual — con una
 * migaja de pan arriba y un botón "Volver" — en vez de cerrar el panel. Así un número se puede
 * ir abriendo cada vez más ("litros del período" → "litros por equipo" → "cargas de ese
 * equipo") hasta que un nivel ya no tenga más `zoom` para ofrecer: ahí se termina el camino.
 */

const registro = new Map(); // id -> { titulo, valor, pasos, fuentes, nota, acciones }

/** Registra los pasos de un cálculo y devuelve los atributos HTML para el elemento. */
export function registrarCalculo(id, datos) {
    registro.set(id, datos);
    return `data-calc="${id}"`;
}

export function limpiarCalculos() { registro.clear(); }

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let overlay = null;
let pila = []; // pila de niveles: [nivel0, nivel1, ...] — el último es el que se ve

export function initCalcPopover() {
    // Delegación en document: sirve para elementos que se renderizan después.
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-calc]');
        if (!el) return;
        const datos = registro.get(el.dataset.calc);
        if (!datos) return;
        e.preventDefault();
        e.stopPropagation();
        abrir(datos);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !overlay) return;
        // Escape retrocede un nivel si hay a dónde volver; si no, cierra directamente.
        if (pila.length > 1) { pila.pop(); render(); } else cerrar();
    });
}

function cerrar() {
    if (overlay) { overlay.remove(); overlay = null; }
    pila = [];
}

function abrir(d) {
    pila = [d];
    render();
}

function render() {
    if (overlay) overlay.remove();
    const d = pila[pila.length - 1];
    const pasos = d.pasos || [];
    const hayVolver = pila.length > 1;

    overlay = document.createElement('div');
    overlay.className = 'calc-overlay';
    overlay.innerHTML = `
        <div class="calc-panel" role="dialog" aria-label="Pasos del cálculo">
            ${pila.length > 1 ? `
            <nav class="calc-migas">
                ${pila.map((n, i) => i < pila.length - 1
                    ? `<button class="calc-miga" data-nivel="${i}">${esc(n.titulo)}</button><i class="fa-solid fa-chevron-right"></i>`
                    : `<span class="calc-miga calc-miga-actual">${esc(n.titulo)}</span>`).join('')}
            </nav>` : ''}
            <div class="calc-panel-head">
                <div class="calc-panel-head-titulo">
                    ${hayVolver ? `<button class="btn-icon calc-volver" data-volver aria-label="Volver"><i class="fa-solid fa-arrow-left"></i></button>` : ''}
                    <div>
                        <span class="calc-panel-label">${hayVolver ? 'Más detalle de' : 'Cómo se calculó'}</span>
                        <h3>${esc(d.titulo)}</h3>
                    </div>
                </div>
                <button class="btn-icon" data-cerrar aria-label="Cerrar"><i class="fa-solid fa-xmark"></i></button>
            </div>

            ${d.valor !== undefined ? `<div class="calc-panel-valor">${esc(d.valor)}</div>` : ''}

            ${pasos.length ? `
            <ol class="calc-pasos">
                ${pasos.map((p, i) => `
                    <li class="${p.zoom ? 'calc-paso-zoom' : ''}" ${p.zoom ? `data-paso-zoom="${i}" role="button" tabindex="0"` : ''}>
                        <span class="calc-paso-n">${i + 1}</span>
                        <div class="calc-paso-cuerpo">
                            <span class="calc-paso-texto">${esc(p.texto)}</span>
                            ${p.calculo ? `<code class="calc-paso-formula">${esc(p.calculo)}</code>` : ''}
                            ${p.nota ? `<span class="calc-paso-nota">${esc(p.nota)}</span>` : ''}
                        </div>
                        <span class="calc-paso-res">${esc(p.resultado)}</span>
                        ${p.zoom ? '<i class="fa-solid fa-chevron-right calc-paso-chevron"></i>' : ''}
                    </li>`).join('')}
            </ol>` : '<p class="calc-vacio">No hay pasos registrados para este valor.</p>'}

            ${d.nota ? `<p class="calc-panel-nota"><i class="fa-solid fa-circle-info"></i> ${esc(d.nota)}</p>` : ''}

            ${d.fuentes && d.fuentes.length ? `
            <div class="calc-fuentes">
                <span>Datos tomados de:</span>
                ${d.fuentes.map(f => `<code>${esc(f)}</code>`).join('')}
            </div>` : ''}

            ${d.acciones && d.acciones.length ? `
            <div class="calc-acciones">
                ${d.acciones.map((a, i) => `<button class="btn-sm ${a.primaria ? 'btn-primary' : 'btn-secondary'}" data-calc-accion="${i}"><i class="fa-solid ${a.icono || (a.zoom ? 'fa-magnifying-glass-plus' : 'fa-arrow-right')}"></i> ${esc(a.texto)}</button>`).join('')}
            </div>` : ''}

            ${!pasos.some(p => p.zoom) && !(d.acciones || []).some(a => a.zoom) && hayVolver
                ? '<p class="calc-fin-nivel"><i class="fa-solid fa-circle-check"></i> No hay más detalle para este dato.</p>' : ''}
        </div>`;

    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-cerrar]')) cerrar(); });

    overlay.querySelector('[data-volver]')?.addEventListener('click', () => { pila.pop(); render(); });
    overlay.querySelectorAll('[data-nivel]').forEach(b => {
        b.addEventListener('click', () => { pila = pila.slice(0, parseInt(b.dataset.nivel, 10) + 1); render(); });
    });

    overlay.querySelectorAll('[data-paso-zoom]').forEach(li => {
        const activar = () => {
            const paso = pasos[parseInt(li.dataset.pasoZoom, 10)];
            if (paso && typeof paso.zoom === 'function') {
                const siguiente = paso.zoom();
                if (siguiente) { pila.push(siguiente); render(); }
            }
        };
        li.addEventListener('click', activar);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activar(); } });
    });

    overlay.querySelectorAll('[data-calc-accion]').forEach(b => {
        b.addEventListener('click', () => {
            const accion = (d.acciones || [])[parseInt(b.dataset.calcAccion, 10)];
            if (!accion) return;
            if (typeof accion.zoom === 'function') {
                const siguiente = accion.zoom();
                if (siguiente) { pila.push(siguiente); render(); }
            } else {
                cerrar();
                if (typeof accion.onClick === 'function') accion.onClick();
            }
        });
    });

    document.body.appendChild(overlay);
}

/** Helper para formatear un número con su unidad en el encabezado del panel. */
export const valorConUnidad = (n, d, u) => `${nf(n, d)}${u ? ' ' + u : ''}`;
