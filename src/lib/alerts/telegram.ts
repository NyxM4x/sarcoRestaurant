import 'server-only';

/**
 * Transporte de alertas Telegram — server-only (Fase 5.2D.5E.2).
 *
 * ÚNICA responsabilidad: enviar un texto por la API HTTPS de Telegram y traducir
 * la respuesta a un resultado CLASIFICADO. No conoce pedidos, notificaciones ni
 * persistencia. El token y el chat_id son server-side; jamás se registran ni se
 * devuelven. Sin credenciales, NO hace fetch: falla de forma local y segura.
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

  return {
    async send(text: string, parseMode?: TelegramParseMode): Promise<TelegramOutcome> {
      const token = (config.botToken ?? '').trim();
      const chatId = (config.chatId ?? '').trim();
      // Sin credenciales: fallo local seguro, CERO fetch.
      if (token === '' || chatId === '') {
        return { kind: 'permanent', code: 'config_missing' };
      }

      const controller = new AbortController();
      const timer = setTimer(() => controller.abort(), timeoutMs);

      let res: TelegramResponse;
      try {
        res = await doFetch(`${baseUrl}/bot${token}/sendMessage`, {
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
      } catch {
        clearTimer(timer);
        // Timeout o error de red: transitorio.
        return { kind: controller.signal.aborted ? 'transient' : 'transient', code: controller.signal.aborted ? 'timeout' : 'network_error' };
      }
      clearTimer(timer);

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
        return { kind: 'permanent', code: `http_${status}` };
      }
      if (status >= 500 && status <= 599) {
        return { kind: 'transient', code: `http_${status}` };
      }
      // Cualquier otro estado inesperado: ilegible, no marcar enviada.
      return { kind: 'invalid' };
    },
  };
}
