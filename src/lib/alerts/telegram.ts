import 'server-only';
import { log } from '@/lib/log';

/**
 * Transporte de alertas Telegram — server-only (Fase 5.2D.5E.2).
 *
 * ÚNICA responsabilidad: enviar un texto por la API HTTPS de Telegram y traducir
 * la respuesta a un resultado CLASIFICADO. No conoce pedidos, notificaciones ni
 * persistencia. El token y el chat_id son server-side; no se devuelven nunca y
 * no se registran, con UNA excepción: el id al que Telegram redirige un grupo
 * que se convirtió en supergrupo (ver `chatIdMigrado`), que es un dato de
 * configuración que hay que corregir a mano y sin el token no abre nada.
 * Sin credenciales, NO hace fetch: falla de forma local y segura.
 */

/** Resultado clasificado de un intento de envío. Sin datos crudos de Telegram. */
export type TelegramOutcome =
  /** Telegram confirmó el envío (HTTP 200 + ok:true). */
  | { kind: 'sent' }
  /** Error permanente (400/403/404): reintentar no ayuda por sí solo. */
  | { kind: 'permanent'; code: string }
  /** Límite de tasa (429): reprogramar respetando retry_after si es válido. */
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  /** Transitorio (5xx/timeout/red): reprogramar con backoff. */
  | { kind: 'transient'; code: string }
  /** Respuesta ilegible o ok:false sin clasificación: no marcar enviada. */
  | { kind: 'invalid' };

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** Override opcional (tests). Por defecto la API oficial. */
  baseUrl?: string;
  timeoutMs?: number;
}

/** Respuesta mínima que el transporte necesita del `fetch`. */
export interface TelegramResponse {
  readonly status: number;
  json(): Promise<unknown>;
}
export type TelegramFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<TelegramResponse>;

export interface TelegramDeps {
  fetch?: TelegramFetch;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Cómo interpreta Telegram el texto. Ausente = texto plano, que es como salieron
 * todos los mensajes hasta el 04-09-2026.
 *
 * Se eligió HTML y no MarkdownV2 para la única alerta que lo necesita: MarkdownV2
 * obliga a escapar `.`, `-`, `(` y `)`, que aparecen en los enlaces de Maps, en
 * "0.8 km" y en cualquier nombre de cliente. Un escape olvidado ahí no es un
 * mensaje feo: es un 400 de Telegram y un aviso de reparto que no llega. En HTML
 * solo hay tres caracteres que escapar.
 */
export type TelegramParseMode = 'HTML';

export interface AlertSender {
  send(text: string, parseMode?: TelegramParseMode): Promise<TelegramOutcome>;
}

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 10_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Crea un `AlertSender` respaldado por Telegram. `fetch` es inyectable para
 * pruebas sin red. Con token o chat_id vacíos devuelve `permanent` SIN hacer fetch.
 */
export function createTelegramAlertSender(
  config: TelegramConfig,
  deps: TelegramDeps = {},
): AlertSender {
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<TelegramResponse>);
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Un POST a `sendMessage`. `null` = no hubo respuesta (timeout o red). */
  async function post(
    token: string,
    chatId: string,
    text: string,
    parseMode?: TelegramParseMode,
  ): Promise<{ res: TelegramResponse } | { abortada: boolean }> {
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          // Solo viaja cuando alguien lo pide: un `parse_mode` de más
          // convierte cualquier `<` de un nombre en un 400.
          ...(parseMode ? { parse_mode: parseMode } : {}),
        }),
        signal: controller.signal,
      });
      clearTimer(timer);
      return { res };
    } catch {
      clearTimer(timer);
      return { abortada: controller.signal.aborted };
    }
  }

  return {
    async send(text: string, parseMode?: TelegramParseMode): Promise<TelegramOutcome> {
      const token = (config.botToken ?? '').trim();
      const chatId = (config.chatId ?? '').trim();
      // Sin credenciales: fallo local seguro, CERO fetch.
      if (token === '' || chatId === '') {
        return { kind: 'permanent', code: 'config_missing' };
      }

      // Un solo salto: el primer intento va al chat configurado y, si Telegram
      // responde que ese grupo migró, el segundo va al que él mismo indica.
      // Ver `chatIdMigrado`.
      let destino = chatId;
      for (let intento = 0; intento < 2; intento += 1) {
        const salida = await post(token, destino, text, parseMode);
        if (!('res' in salida)) {
          // Timeout o error de red: transitorio.
          return { kind: 'transient', code: salida.abortada ? 'timeout' : 'network_error' };
        }
        const res = salida.res;
        const status = res.status;

        if (status === 200) {
          let body: unknown;
          try {
            body = await res.json();
          } catch {
            return { kind: 'invalid' };
          }
          const rec = asRecord(body);
          if (rec && rec.ok === true) return { kind: 'sent' };
          return { kind: 'invalid' };
        }

        if (status === 429) {
          let retryAfter: number | undefined;
          try {
            const rec = asRecord(await res.json());
            const params = rec ? asRecord(rec.parameters) : null;
            const ra = params?.retry_after;
            if (typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 && ra <= 86400) {
              retryAfter = Math.floor(ra);
            }
          } catch {
            // sin retry_after válido: se reprograma con el backoff por defecto
          }
          return { kind: 'rate_limited', retryAfterSeconds: retryAfter };
        }

        if (status >= 400 && status <= 499) {
          // El 400 de la migración trae el destino nuevo dentro. Solo en la
          // primera vuelta: `intento === 1` ya es el chat que Telegram dictó, y
          // si ese también migra se para aquí en vez de encadenar saltos.
          const migrado = intento === 0 ? await chatIdMigrado(res) : null;
          if (migrado !== null) {
            // El id del grupo NO es una credencial —sin el token no sirve de
            // nada— y es el único dato que permite arreglar la causa. Se
            // registra a propósito: el salto de abajo hace que los avisos
            // sigan llegando, pero cada uno gasta dos llamadas hasta que una
            // persona ponga este valor en `TELEGRAM_CHAT_ID`.
            log.error('telegram_chat_migrated', { migrate_to_chat_id: migrado });
            destino = migrado;
            continue;
          }
          return { kind: 'permanent', code: `http_${status}` };
        }
        if (status >= 500 && status <= 599) {
          return { kind: 'transient', code: `http_${status}` };
        }
        // Cualquier otro estado inesperado: ilegible, no marcar enviada.
        return { kind: 'invalid' };
      }

      // Inalcanzable: la vuelta 1 solo se llega tras un `continue`, y esa
      // vuelta no puede volver a saltar. Está por exhaustividad del tipo.
      return { kind: 'invalid' };
    },
  };
}

/**
 * El chat al que Telegram redirige un grupo que se convirtió en supergrupo.
 * `null` si esta respuesta no es esa.
 *
 * ── Por qué el transporte lo sigue en vez de rendirse (06-09-2026) ──────────
 *
 * Un grupo normal pasa a supergrupo solo, sin que nadie lo pida: basta con que
 * alguien lo haga público, active el historial o supere cierto tamaño. Al
 * hacerlo CAMBIA de id, y el viejo deja de aceptar mensajes con un 400
 * —`group chat was upgraded to a supergroup chat`— que trae dentro el id nuevo.
 *
 * Ese 400 se estaba clasificando como `permanent`, así que cada aviso de
 * reparto se marcaba `failed` a la primera y nadie salía a repartir. La noche
 * del 05-09-2026 se perdieron seis pedidos seguidos así, con la cocina
 * trabajando y el grupo en silencio.
 *
 * Es la única clase de 400 que se resuelve reintentando, porque Telegram no
 * está rechazando el mensaje: está diciendo a dónde mandarlo. Rendirse teniendo
 * la respuesta en la mano es lo que convirtió un cambio de ajuste del grupo en
 * una noche sin repartos.
 *
 * `getChat` con el id viejo sigue respondiendo normalmente, así que ninguna
 * comprobación de configuración detecta esto: el único sitio donde se ve es
 * aquí, en la respuesta al envío.
 */
async function chatIdMigrado(res: TelegramResponse): Promise<string | null> {
  try {
    const rec = asRecord(await res.json());
    const params = rec ? asRecord(rec.parameters) : null;
    const destino = params?.migrate_to_chat_id;
    // Telegram lo manda como número, y los ids de supergrupo son negativos y
    // grandes; se acepta también en texto por si algún día cambia el tipo.
    if (typeof destino === 'number' && Number.isSafeInteger(destino)) return String(destino);
    if (typeof destino === 'string' && /^-?\d+$/.test(destino.trim())) return destino.trim();
    return null;
  } catch {
    return null;
  }
}
