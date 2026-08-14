/**
 * AI Chat interaction logic — Asistente de Flota
 *
 * Usa Claude (Anthropic) vía un backend propio (/api/chat.js): el navegador nunca ve
 * ninguna API key, solo le habla a "/api/chat" en el mismo dominio.
 *
 * Capacidades reales de este chat (no simulado):
 *   - Análisis en lenguaje natural sobre un resumen real de la flota (buildContextSummary).
 *   - Tool-use "get_equipo_detalle": si Claude necesita el detalle de un equipo que no está
 *     en el resumen (el resumen solo trae el top 10), pide esta tool; ACÁ se resuelve
 *     (resolveEquipoDetalleTool) consultando el IndexedDB local, y se le devuelve el
 *     resultado para que siga razonando. Esto le da acceso efectivo a TODA la flota
 *     cargada, no solo al top 10, sin tener que mandar todo de una en cada mensaje.
 *   - Tool "web_search" (nativa de Anthropic): permite research real en internet (precios
 *     de gasoil, normativa, comparativas de mercado). Se resuelve del lado de Anthropic;
 *     acá solo hace falta mostrar el resultado y, si vienen, las fuentes citadas.
 */
import { getAllEquipos, getAllRawRecords, getAllEstimados } from '../data/database.js';
import {
    calculateAlignedPeriod,
    calculateMetrics,
    determineConsumptionType,
    getConfirmedConsumption,
    getCargasForEquipo,
    getGPSForEquipo
} from '../data/analyzer.js';
import { normalizeEquipoKey } from '../data/normalizer.js';

const API_ENDPOINT = '/api/chat';
const MAX_TURNS = 16; // mensajes (usuario+asistente, incluye idas y vueltas de tools) en memoria
const MAX_TOOL_ROUNDS = 4; // tope de vueltas tool_use/tool_result por mensaje del usuario, para no loopear sin fin

// Historial de la conversación en memoria. Cada item es { role, content } donde `content`
// puede ser un string (turno de texto simple) o un array de bloques (tool_use/tool_result/
// texto con citas), tal como los define la Messages API de Anthropic.
// No se persiste nada del chat en localStorage/IndexedDB: se pierde al recargar la página,
// a propósito (privacidad).
let conversation = [];

export function initAIChat() {
    const input = document.getElementById('ai-input');
    const btnSend = document.getElementById('btn-send-ai');
    const history = document.getElementById('ai-chat-history');

    if (!input || !btnSend || !history) return;

    const appendMsg = (role, html) => {
        const div = document.createElement('div');
        div.className = `ai-msg ${role === 'user' ? 'user' : 'system'}`;
        div.innerHTML = html;
        history.appendChild(div);
        history.scrollTop = history.scrollHeight;
        return div;
    };

    const setStatus = (el, html) => {
        el.innerHTML = html;
        history.scrollTop = history.scrollHeight;
    };

    const sendMessage = async () => {
        const text = input.value.trim();
        if (!text || btnSend.disabled) return;

        appendMsg('user', escapeHtml(text));
        conversation.push({ role: 'user', content: text });
        conversation = conversation.slice(-MAX_TURNS);
        input.value = '';

        const status = appendMsg('system', '<i class="fa-solid fa-spinner fa-spin"></i> Pensando...');
        btnSend.disabled = true;
        input.disabled = true;

        let renderedAny = false;

        try {
            const context = await buildContextSummary();
            let round = 0;

            while (round < MAX_TOOL_ROUNDS) {
                round++;

                const response = await fetch(API_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: conversation, context })
                });

                let data;
                try { data = await response.json(); } catch (e) { data = {}; }

                if (!response.ok) {
                    setStatus(status, `<i class="fa-solid fa-triangle-exclamation" style="color:var(--accent-red)"></i> ${escapeHtml(data.error || 'Error al conectar con el asistente.')}`);
                    return;
                }

                const content = Array.isArray(data.content) ? data.content : [];
                conversation.push({ role: 'assistant', content });
                conversation = conversation.slice(-MAX_TURNS);

                const textHtml = renderContentBlocks(content);
                if (textHtml) {
                    setStatus(status, textHtml);
                    renderedAny = true;
                }

                if (data.stopReason === 'pause_turn') {
                    // Búsqueda larga pausada: según la doc de Anthropic hay que reenviar
                    // el mensaje pausado sin cambios para que continúe.
                    setStatus(status, (textHtml || '') + '<br><i class="fa-solid fa-spinner fa-spin"></i> Buscando información, un momento...');
                    continue;
                }

                if (data.stopReason === 'tool_use') {
                    const toolUses = content.filter(b => b.type === 'tool_use' && b.name === 'get_equipo_detalle');
                    if (toolUses.length === 0) {
                        // Tool desconocida o resuelta server-side (ej. solo web_search):
                        // no hay nada más que hacer de este lado, se corta el loop.
                        break;
                    }
                    setStatus(status, (textHtml || '') + '<br><i class="fa-solid fa-spinner fa-spin"></i> Consultando datos de la flota...');

                    const toolResults = [];
                    for (const tu of toolUses) {
                        const interno = tu.input && tu.input.interno;
                        const result = await resolveEquipoDetalleTool(interno);
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: tu.id,
                            content: JSON.stringify(result)
                        });
                    }
                    conversation.push({ role: 'user', content: toolResults });
                    conversation = conversation.slice(-MAX_TURNS);
                    continue; // volver a llamar a /api/chat con el resultado de la tool
                }

                // end_turn / max_tokens / stop_sequence / null -> respuesta final
                break;
            }

            if (!renderedAny) {
                setStatus(status, '(El asistente no devolvió una respuesta de texto.)');
            }
        } catch (e) {
            console.error('Error en el chat IA:', e);
            setStatus(status, '<i class="fa-solid fa-triangle-exclamation" style="color:var(--accent-red)"></i> No se pudo conectar con el asistente (¿la app está desplegada con el backend /api/chat activo?).');
        } finally {
            btnSend.disabled = false;
            input.disabled = false;
            input.focus();
            history.scrollTop = history.scrollHeight;
        }
    };

    btnSend.addEventListener('click', sendMessage);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

/**
 * Renderiza los bloques `content` que devuelve la Messages API: toma los bloques de tipo
 * "text" (ignora tool_use/tool_result/server_tool_use, que son internos del razonamiento),
 * y si el texto trae citas de web_search las muestra como una lista de fuentes.
 */
function renderContentBlocks(content) {
    const textBlocks = (content || []).filter(b => b.type === 'text' && b.text);
    if (textBlocks.length === 0) return '';

    let html = textBlocks.map(b => escapeHtml(b.text).replace(/\n/g, '<br>')).join('<br><br>');

    const citations = [];
    const seenUrls = new Set();
    textBlocks.forEach(b => {
        (b.citations || []).forEach(c => {
            if (c.url && !seenUrls.has(c.url)) {
                seenUrls.add(c.url);
                citations.push(c);
            }
        });
    });

    if (citations.length) {
        html += '<div style="margin-top:0.5rem; font-size:0.75rem; color:var(--text-muted);">Fuentes: ' +
            citations.map(c => `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.title || c.url)}</a>`).join(' · ') +
            '</div>';
    }

    return html;
}

/**
 * Resuelve la tool "get_equipo_detalle": busca el equipo por su código interno (normalizado,
 * mismo criterio que el resto de la app) en el IndexedDB local y arma un detalle completo
 * -no solo el resumen top-10- para que Claude pueda responder preguntas puntuales.
 */
async function resolveEquipoDetalleTool(internoQuery) {
    if (!internoQuery) {
        return { error: 'Falta el código "interno" del equipo a buscar.' };
    }
    try {
        const key = normalizeEquipoKey(internoQuery);
        const equipos = await getAllEquipos();
        const equipo = equipos.find(eq => normalizeEquipoKey(eq.interno) === key);
        if (!equipo) {
            return { error: `No se encontró ningún equipo con interno "${internoQuery}" en la base cargada.` };
        }

        const allRecords = await getAllRawRecords();
        const estimadosData = await getAllEstimados();
        const allCargas = allRecords.filter(r => r.type === 'carga');
        const allGps = allRecords.filter(r => r.type === 'gps');

        const { start, end } = calculateAlignedPeriod(allCargas, allGps);
        const cargasPeriodo = (start && end) ? allCargas.filter(c => c.fecha >= start && c.fecha <= end) : allCargas;
        const gpsPeriodo = (start && end) ? allGps.filter(g => g.fecha >= start && g.fecha <= end) : allGps;

        const eqCargas = getCargasForEquipo(equipo.interno, cargasPeriodo);
        const eqGps = getGPSForEquipo(equipo.interno, gpsPeriodo);
        const metrics = calculateMetrics(equipo, eqCargas, eqGps);
        const confirmed = getConfirmedConsumption(equipo.interno, estimadosData);

        return {
            equipo: {
                interno: equipo.interno,
                dominio: equipo.dominio,
                marca: equipo.marca,
                modelo: equipo.modelo,
                tipo: equipo.tipo
            },
            periodo_analizado: (start && end) ? `${start} a ${end}` : 'sin superposición suficiente entre Cargas y GPS',
            tipo_calculo: determineConsumptionType(equipo, eqCargas),
            total_litros: Number(metrics.total_litros.toFixed(1)),
            total_costo: Number(metrics.total_costo.toFixed(2)),
            total_km: Number(metrics.total_km.toFixed(1)),
            total_horas: Number(metrics.total_horas.toFixed(2)),
            consumo_real: Number(metrics.consumo_real.toFixed(3)),
            meta_fabrica: confirmed ? confirmed.value : null,
            cantidad_cargas_en_periodo: eqCargas.length,
            ultimas_cargas: eqCargas
                .slice()
                .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''))
                .slice(0, 8)
                .map(c => ({ fecha: c.fecha, litros: c.litros, lugar: c.lugar_carga, centro_costo: c.centro_costo }))
        };
    } catch (e) {
        console.error('Error resolviendo get_equipo_detalle:', e);
        return { error: 'Error interno leyendo la base de datos local de la app.' };
    }
}

/**
 * Arma un resumen en texto plano del estado actual de la flota (equipos, consumos,
 * comparación contra metas) para dárselo a Claude como contexto inicial. Es intencionalmente
 * acotado (top 10) para no volar el tamaño del prompt; para cualquier otro equipo, Claude
 * usa la tool "get_equipo_detalle" definida arriba.
 */
async function buildContextSummary() {
    try {
        const equipos = await getAllEquipos();
        if (!equipos.length) {
            return '(Todavía no se cargaron archivos Excel en la app; no hay datos de flota disponibles.)';
        }

        const allRecords = await getAllRawRecords();
        const estimadosData = await getAllEstimados();
        const allCargas = allRecords.filter(r => r.type === 'carga');
        const allGps = allRecords.filter(r => r.type === 'gps');

        const { start, end } = calculateAlignedPeriod(allCargas, allGps);
        const cargas = (start && end) ? allCargas.filter(c => c.fecha >= start && c.fecha <= end) : allCargas;
        const gps = (start && end) ? allGps.filter(g => g.fecha >= start && g.fecha <= end) : allGps;

        const totalLitros = cargas.reduce((s, c) => s + (parseFloat(c.litros) || 0), 0);
        const totalCosto = cargas.reduce((s, c) => s + (parseFloat(c.importe) || 0), 0);

        const lines = [];
        lines.push(`Periodo analizado: ${start && end ? `${start} a ${end}` : 'sin superposición suficiente entre Cargas y GPS'}.`);
        lines.push(`Equipos en base maestra: ${equipos.length} (usá get_equipo_detalle para cualquiera que no esté en el top de abajo).`);
        lines.push(`Total combustible en el periodo: ${totalLitros.toFixed(1)} L, costo $${totalCosto.toFixed(2)}.`);

        const porEquipo = equipos.map(eq => {
            const eqCargas = getCargasForEquipo(eq.interno, cargas);
            const eqGps = getGPSForEquipo(eq.interno, gps);
            const metrics = calculateMetrics(eq, eqCargas, eqGps);
            const confirmed = getConfirmedConsumption(eq.interno, estimadosData);
            return { eq, metrics, confirmed };
        }).filter(r => r.metrics.total_litros > 0);

        porEquipo.sort((a, b) => b.metrics.total_litros - a.metrics.total_litros);
        const top = porEquipo.slice(0, 10);
        if (top.length) {
            lines.push('\nTop equipos por litros cargados en el periodo:');
            top.forEach(r => {
                const metaTxt = r.confirmed ? ` | meta: ${r.confirmed.value}` : ' | sin meta definida';
                lines.push(`- ${r.eq.interno} (${r.eq.marca || ''} ${r.eq.modelo || ''}, ${r.eq.tipo || 'sin tipo'}): ${r.metrics.total_litros.toFixed(1)} L, consumo real ${r.metrics.consumo_real.toFixed(2)} [${r.metrics.tipo_calculo}]${metaTxt}.`);
            });
        }

        const sobreMeta = porEquipo.filter(r => r.confirmed && r.confirmed.valor > 0 && r.metrics.consumo_real > r.confirmed.valor * 1.15);
        if (sobreMeta.length) {
            lines.push('\nEquipos consumiendo por encima de su meta (>15%):');
            sobreMeta.slice(0, 10).forEach(r => {
                lines.push(`- ${r.eq.interno}: real ${r.metrics.consumo_real.toFixed(2)} vs meta ${r.confirmed.valor} [${r.metrics.tipo_calculo}].`);
            });
        }

        return lines.join('\n');
    } catch (e) {
        console.error('No se pudo construir el contexto para el chat IA:', e);
        return '(No se pudo leer la base de datos local de la app para dar contexto; respondé de forma general.)';
    }
}
