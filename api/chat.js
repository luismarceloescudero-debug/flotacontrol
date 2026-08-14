/**
 * Proxy backend para el chat IA de FlotaControl.
 *
 * Por qué existe este archivo: FlotaControl es una app 100% cliente (HTML/JS que corre en
 * el navegador de cada usuario, sin servidor propio). Llamar a la API de Anthropic
 * directamente desde ese JS obligaría a poner la API key en el código del navegador, donde
 * cualquier persona que abra la página (F12 -> pestaña Network o Sources) podría copiarla y
 * usarla a tu costo. Esta función serverless (pensada para desplegarse en Vercel) resuelve
 * eso: la API key vive únicamente en una variable de entorno del servidor
 * (ANTHROPIC_API_KEY), nunca en el HTML/JS que se descarga al navegador.
 *
 * Capacidades reales habilitadas acá (no son simulación):
 *   1. Análisis sobre los datos de la flota: el cliente manda un resumen (top equipos,
 *      totales) como contexto en cada request.
 *   2. Tool-use "get_equipo_detalle": si Claude necesita el detalle de un equipo puntual que
 *      no está en el resumen, pide ejecutar esta tool. Como los datos viven en el
 *      IndexedDB del navegador (no acá), esta función NO la resuelve: le devuelve el pedido
 *      de tool_use al cliente (js/ai/chat.js), que consulta localmente y reenvía el
 *      resultado en el siguiente request. Ver stopReason === 'tool_use' en la respuesta.
 *   3. Tool "web_search" (nativa de Anthropic, "server tool"): permite research real en
 *      internet (precios de gasoil, normativas, comparativas de mercado, etc.). Esta la
 *      resuelve Anthropic del lado de ellos, no hace falta código nuestro para ejecutarla.
 *      Tiene costo aparte: ~USD 10 cada 1000 búsquedas + tokens normales.
 *
 * Configuración en Vercel:
 *   1. Project Settings -> Environment Variables -> agregar ANTHROPIC_API_KEY
 *      (se genera en https://console.anthropic.com -> API Keys).
 *   2. Opcional: ANTHROPIC_MODEL (default: claude-sonnet-5), ANTHROPIC_MAX_WEB_SEARCHES
 *      (default: 3, tope de búsquedas web por mensaje para controlar el costo).
 *   3. Desplegar. Vercel detecta automáticamente cualquier archivo dentro de /api como
 *      función serverless, no hace falta configuración adicional.
 *
 * IMPORTANTE: esto usa la API de Anthropic (facturada por uso, console.anthropic.com),
 * NO la suscripción de chat de claude.ai (Pro/Max) — esa suscripción no tiene una API
 * programable que una app externa pueda llamar.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1536;

// Límites simples para no dejar pasar payloads gigantes/abusivos del cliente
const MAX_CONTEXT_CHARS = 8000;
const MAX_HISTORY_MESSAGES = 24; // incluye idas y vueltas de tool_use/tool_result
const MAX_TOTAL_JSON_CHARS = 120000; // ~120KB de conversación (los tool_result pueden pesar)

const TOOLS = [
    {
        name: 'get_equipo_detalle',
        description: 'Devuelve el detalle completo de UN equipo puntual de la flota (cargas ' +
            'de combustible recientes, actividad GPS, métricas de consumo calculadas y meta ' +
            'de fábrica), identificado por su código "interno" (ej: "TR20", "CM43", "BM09"). ' +
            'Usar cuando el usuario pregunta por un equipo específico que no aparece en el ' +
            'resumen inicial, o cuando el resumen no alcanza para responder con precisión. ' +
            'El resumen inicial solo trae los 10 equipos con más litros cargados; para ' +
            'cualquier otro hay que pedir el detalle con esta tool.',
        input_schema: {
            type: 'object',
            properties: {
                interno: {
                    type: 'string',
                    description: 'Código interno del equipo tal como aparece en la flota, ej "TR20".'
                }
            },
            required: ['interno']
        }
    },
    {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: parseInt(process.env.ANTHROPIC_MAX_WEB_SEARCHES, 10) || 3
    }
];

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Un mensaje es válido si su `content` es texto plano, o un array de bloques
// estructurados (text / tool_use / tool_result / server_tool_use / etc, tal como
// los define la Messages API). No truncamos bloques individualmente porque son JSON
// estructurado (truncar a lo bruto los rompería) — en cambio limitamos el tamaño TOTAL
// de la conversación más abajo.
function isValidContent(content) {
    if (typeof content === 'string') return true;
    if (Array.isArray(content)) {
        return content.every(b => b && typeof b === 'object' && typeof b.type === 'string');
    }
    return false;
}

module.exports = async function handler(req, res) {
    setCors(res);

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Método no permitido. Usá POST.' });
        return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        res.status(500).json({
            error: 'El servidor no tiene configurada ANTHROPIC_API_KEY. Agregala en las variables de entorno del proyecto (Vercel/Netlify) y volvé a desplegar.'
        });
        return;
    }

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const { messages, context } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'Falta "messages" (array de mensajes de la conversación).' });
        return;
    }

    const safeMessages = messages
        .slice(-MAX_HISTORY_MESSAGES)
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && isValidContent(m.content));

    if (safeMessages.length === 0) {
        res.status(400).json({ error: 'No hay mensajes válidos para enviar.' });
        return;
    }

    if (JSON.stringify(safeMessages).length > MAX_TOTAL_JSON_CHARS) {
        res.status(400).json({ error: 'La conversación se volvió demasiado larga. Iniciá un chat nuevo (recargá la página).' });
        return;
    }

    const safeContext = typeof context === 'string' ? context.slice(0, MAX_CONTEXT_CHARS) : '';

    const systemPrompt = [
        'Sos el asistente de análisis de flota de FlotaControl (HSV Logística).',
        'Respondé siempre en español rioplatense, de forma breve, concreta y accionable.',
        'Para datos de LA FLOTA: basate en el resumen que te dan a continuación. Si preguntan por',
        'un equipo puntual que no está en ese resumen, o necesitás más detalle, usá la tool',
        '"get_equipo_detalle" en vez de inventar cifras.',
        'Para preguntas que requieran información externa y actual (precios de combustible,',
        'normativa, comparativas de consumo de mercado, clima, etc.), usá la tool "web_search"',
        'en vez de responder solo de memoria — tu conocimiento de entrenamiento puede estar',
        'desactualizado para ese tipo de datos.',
        'Si de verdad no tenés forma de responder con precisión (ni con los datos de la flota ni',
        'buscando), decilo explícitamente en vez de inventar un número.',
        '',
        'Resumen actual de la flota (top equipos por consumo, no es la lista completa):',
        safeContext || '(Todavía no se cargaron datos en la app.)'
    ].join('\n');

    try {
        const upstream = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_VERSION
            },
            body: JSON.stringify({
                model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
                max_tokens: MAX_TOKENS,
                system: systemPrompt,
                messages: safeMessages,
                tools: TOOLS
            })
        });

        const data = await upstream.json();

        if (!upstream.ok) {
            console.error('Anthropic API error:', data);
            res.status(upstream.status).json({
                error: (data && data.error && data.error.message) || 'Error llamando a la API de Anthropic.'
            });
            return;
        }

        // Devolvemos los bloques de contenido tal cual (no solo el texto plano): el cliente
        // los necesita completos para poder reenviarlos en el siguiente turno si hay
        // tool_use pendiente, y para mostrar citas de web_search si las hay.
        res.status(200).json({
            content: data.content || [],
            stopReason: data.stop_reason || null,
            usage: data.usage || null
        });
    } catch (err) {
        console.error('Error en /api/chat:', err);
        res.status(500).json({ error: 'Error interno del servidor al contactar a Claude.' });
    }
};
