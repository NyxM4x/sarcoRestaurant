import { getServerEnv } from '@/lib/env/env';
import { extractBearer, safeCompare } from '@/lib/security/auth';
import { log } from '@/lib/log';
import { parseMenuPipelineConfig } from '@/lib/menu/config';
import { isMenuIntent } from '@/lib/webhook/menu-intent';
import { MENU_TRIGGER_TEXT } from '@/lib/webhook/menu-trigger';

// Lee `process.env` en runtime: una config cacheada de build no diría nada del
// despliegue real, que es justo lo que se viene a comprobar.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/internal/menu/config-check
 *
 * Diagnóstico del envío del menú y del agente, TAL COMO LO VE EL SERVIDOR.
 * Protegido con el Bearer interno (`INTERNAL_API_TOKEN`).
 *
 * Existe por el mismo motivo que el de delivery: "no me llegó el menú" tiene
 * ocho causas y ninguna se ve desde fuera. Sin poder mirar, se cambian
 * variables al azar y se vuelve a probar contra el WhatsApp del negocio en
 * producción, que es exactamente lo que no se debe hacer.
 *
 * NUNCA devuelve el valor de un secreto: solo si está, cuánto mide y si tiene
 * espacios o comillas envolviéndolo — el error clásico de pegar en un panel,
 * invisible al mirarlo y letal para una firma HMAC.
 *
 * ── El probador de frases ───────────────────────────────────────────────────
 *
 * Con `?text=lo+que+escribio+el+cliente` responde si ESE texto habría abierto el
 * menú. Es la mitad de los casos: el cliente escribió "hola" o "buenas noches",
 * que hoy no disparan nada, y la configuración estaba perfecta todo el tiempo.
 * Poder comprobarlo sin mandar un WhatsApp real cierra la duda en un segundo.
 */
export async function GET(request: Request): Promise<Response> {
  let internalToken: string | undefined;
  try {
    internalToken = getServerEnv().INTERNAL_API_TOKEN;
  } catch {
    // Entorno incompleto: a un no autenticado jamás se le detalla qué falta.
    log.error('internal.menu_config_check.env_unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  const token = extractBearer(request.headers.get('authorization'));
  if (!internalToken || !safeCompare(token, internalToken)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const report = parseMenuPipelineConfig(process.env);

  // Probador de frases: solo se incluye si se pidió una.
  const url = new URL(request.url);
  const texto = url.searchParams.get('text');
  const trigger =
    texto === null
      ? undefined
      : {
          text: `'${texto}'`,
          // Las dos puertas, por separado: saber CUÁL abrió (o ninguna) es la
          // diferencia entre "está bien configurado" y "escribió otra cosa".
          opensMenu: isMenuIntent(texto) || texto.trim().toLowerCase() === MENU_TRIGGER_TEXT.toLowerCase(),
          byIntent: isMenuIntent(texto),
          byQaTrigger: texto.trim().toLowerCase() === MENU_TRIGGER_TEXT.toLowerCase(),
        };

  if (!report.ok) log.warn('menu_config_invalid', { missing: report.missing });

  return Response.json({
    ok: report.ok,
    missing: report.missing,
    vars: report.vars,
    agent: report.agent,
    // El menú NO depende de la IA: se dice explícitamente porque es la
    // confusión más cara de este sistema. Con `ok: true` y el agente apagado,
    // el menú sale igual.
    note: 'El envío del menú no depende de la IA. `agent` solo describe si el agente contestaría además.',
    qaTrigger: MENU_TRIGGER_TEXT,
    trigger,
  });
}
