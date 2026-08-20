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
 * panel para ver justo los equipos involucrados, etc. Antes el panel era de solo lectura.
 */

const registro = new Map(); // id -> { titulo, valor, pasos, fuentes, nota }

/** Registra los pasos de un cálculo y devuelve los atributos HTML para el elemento. */
export function registrarCalculo(id, datos) {
    registro.set(id, datos);
    return `data-calc="${id}"`;
}

export function limpiarCalculos() { registro.clear(); }

const nf = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let overlay = null;

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

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrar(); });
}

function cerrar() {
    if (overlay) { overlay.remove(); overlay = null; }
}

function abrir(d) {
    cerrar();
    const pasos = d.pasos || [];

    overlay = document.createElement('div');
    overlay.className = 'calc-overlay';
    overlay.innerHTML = `
        <div class="calc-panel" role="dialog" aria-label="Pasos del cálculo">
            <div class="calc-panel-head">
                <div>
                    <span class="calc-panel-label">Cómo se calculó</span>
                    <h3>${esc(d.titulo)}</h3>
                </div>
                <button class="btn-icon" data-cerrar aria-label="Cerrar"><i class="fa-solid fa-xmark"></i></button>
            </div>

            ${d.valor !== undefined ? `<div class="calc-panel-valor">${esc(d.valor)}</div>` : ''}

            ${pasos.length ? `
            <ol class="calc-pasos">
                ${pasos.map((p, i) => `
                    <li>
                        <span class="calc-paso-n">${i + 1}</span>
                        <div class="calc-paso-cuerpo">
                            <span class="calc-paso-texto">${esc(p.texto)}</span>
                            ${p.calculo ? `<code class="calc-paso-formula">${esc(p.calculo)}</code>` : ''}
                            ${p.nota ? `<span class="calc-paso-nota">${esc(p.nota)}</span>` : ''}
                        </div>
                        <span class="calc-paso-res">${esc(p.resultado)}</span>
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
                ${d.acciones.map((a, i) => `<button class="btn-sm ${a.primaria ? 'btn-primary' : 'btn-secondary'}" data-calc-accion="${i}"><i class="fa-solid ${a.icono || 'fa-arrow-right'}"></i> ${esc(a.texto)}</button>`).join('')}
            </div>` : ''}
        </div>`;

    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-cerrar]')) cerrar(); });
    overlay.querySelectorAll('[data-calc-accion]').forEach(b => {
        b.addEventListener('click', () => {
            const accion = (d.acciones || [])[parseInt(b.dataset.calcAccion, 10)];
            cerrar();
            if (accion && typeof accion.onClick === 'function') accion.onClick();
        });
    });
    document.body.appendChild(overlay);
}

/** Helper para formatear un número con su unidad en el encabezado del panel. */
export const valorConUnidad = (n, d, u) => `${nf(n, d)}${u ? ' ' + u : ''}`;
