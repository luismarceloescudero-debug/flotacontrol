/**
 * Modal de Configuración.
 *
 * Reescrito: antes pedía acá una API key de Gemini y la guardaba en localStorage del
 * navegador. Ahora el asistente IA usa Claude a través de un backend propio (/api/chat.js)
 * que guarda la API key del lado del servidor (variable de entorno ANTHROPIC_API_KEY), así
 * que ya no hace falta que cada usuario pegue ninguna key acá. Este modal ahora solo
 * informa el estado de esa integración y permite probarla.
 */
export function openConfigModal() {
    let container = document.getElementById('modals-container');
    if (!container) return;

    const modalHTML = `
        <div class="modal-overlay active" id="config-modal">
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">
                    <h2>Configuración del Sistema</h2>
                    <button class="btn-close" onclick="this.closest('.modal-overlay').remove()"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body">
                    <div style="margin-bottom: 1.5rem;">
                        <label style="display:block; margin-bottom: 0.5rem; color: var(--text-secondary);">Asistente IA (Antigravity)</label>
                        <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.75rem;">
                            El asistente usa Claude a través de un backend propio (<code>/api/chat</code>).
                            La API key vive en el servidor donde se despliega la app (variable de entorno
                            <code>ANTHROPIC_API_KEY</code>), no acá — no hace falta configurar nada en este navegador.
                        </p>
                        <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.75rem;">
                            Incluye acceso a datos completos de la flota bajo demanda (tool <code>get_equipo_detalle</code>)
                            y research web real (tool <code>web_search</code> de Anthropic, con costo aparte de ~USD 10
                            cada 1000 búsquedas — configurable con <code>ANTHROPIC_MAX_WEB_SEARCHES</code>).
                        </p>
                        <button id="btn-test-ai" class="btn-secondary" style="width: 100%;">
                            <i class="fa-solid fa-plug"></i> Probar conexión con el asistente
                        </button>
                        <div id="ai-test-result" style="margin-top:0.75rem; font-size:0.85rem;"></div>
                    </div>
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', modalHTML);

    document.getElementById('btn-test-ai').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const resultEl = document.getElementById('ai-test-result');
        btn.disabled = true;
        resultEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Probando...';

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'Responde solo con la palabra: OK' }],
                    context: ''
                })
            });
            const data = await res.json().catch(() => ({}));

            if (res.ok) {
                const textBlock = (Array.isArray(data.content) ? data.content : []).find(b => b.type === 'text' && b.text);
                const preview = textBlock ? textBlock.text.slice(0, 80) : '(sin texto plano en esta prueba, pero la conexión funcionó)';
                resultEl.innerHTML = `<span style="color:var(--accent-green)"><i class="fa-solid fa-check-circle"></i> Conexión OK. Respuesta: "${preview.replace(/</g, '&lt;')}"</span>`;
            } else {
                resultEl.innerHTML = `<span style="color:var(--accent-red)"><i class="fa-solid fa-triangle-exclamation"></i> ${data.error || 'Error desconocido'}</span>`;
            }
        } catch (err) {
            resultEl.innerHTML = `<span style="color:var(--accent-red)"><i class="fa-solid fa-triangle-exclamation"></i> No se pudo contactar /api/chat. ¿Está la app desplegada (no funciona en file:// ni con un simple servidor estático sin backend)?</span>`;
        } finally {
            btn.disabled = false;
        }
    });
}
