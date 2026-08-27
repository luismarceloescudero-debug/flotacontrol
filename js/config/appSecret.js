/**
 * Secreto compartido para autenticar al frontend contra /api/chat.
 *
 * Esto NO es un secreto de verdad: vive en un archivo JS que se descarga al navegador de
 * cualquiera que visite el sitio (y en este repo, que es público), así que cualquiera puede
 * leerlo con "Ver código fuente". Su único objetivo es que /api/chat deje de responder a
 * scripts/bots genéricos que escanean la web buscando proxies de API de IA abiertos y
 * los usan gratis a costa de nuestra ANTHROPIC_API_KEY — no frena a alguien que mire este
 * archivo a propósito. Para eso hace falta un login real (usuario/clave) o Vercel
 * Deployment Protection.
 *
 * Tiene que ser EXACTAMENTE igual a la variable de entorno APP_SHARED_SECRET configurada
 * en Vercel (Project Settings -> Environment Variables). Si no coinciden, /api/chat
 * responde 401 a todo.
 */
export const APP_SECRET_HEADER = 'X-App-Secret';
export const APP_SECRET_VALUE = 'f9mLGw-L52PPGFdkQM2Scd9CQW3Cub5d';
