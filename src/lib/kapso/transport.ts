import { normalizePhone } from '@/lib/phone';
import {
  buildImagePayload,
  buildLocationRequestPayload,
  buildMenuCtaPayload,
  buildTextPayload,
  kapsoSendResponseSchema,
} from './messages';

/**
 * Transporte HTTP hacia la API de Kapso — módulo puro (sin `server-only`).
 *
 * El `fetch` es inyectable para probar sin llamadas reales. El wrapper
 * server-only que lee el env vive en `client.ts`. Nunca se registran secretos,
 * bodies sensibles ni teléfonos completos.
 */

export type KapsoSendResult =
  | { ok: true; wamid: string }
  | {
      ok: false;
      error:
        | 'invalid_phone'
        | 'invalid_text'
        | 'invalid_body_text'
        | 'invalid_image'
        | 'http_error'
        | 'invalid_response'
        | 'timeout'
        | 'network_error';
      status?: number;
    };

/** Alias histórico (Fase 3.3A): el resultado es el mismo para todo envío. */
export type SendLocationResult = KapsoSendResult;

export interface KapsoTransportConfig {
  apiKey: string;
  /** phone_number_id por defecto (`KAPSO_PHONE_NUMBER_ID`). */
  phoneNumberId: string;
  /** URL base de la API de mensajes (ver placeholder documentado en client.ts). */
  baseUrl: string;
  timeoutMs?: number;
  /** Inyectable en pruebas; por defecto el fetch global. */
  fetchImpl?: typeof fetch;
}

/** Opciones comunes de envío. */
export interface SendOptions {
  /**
   * phone_number_id a usar en la ruta. Sirve para responder por el MISMO número
   * por el que llegó el evento entrante. Si se omite, se usa el del env.
   */
  phoneNumberId?: string | null;
  /**
   * Presupuesto de tiempo SOLO para este envío. Permite que las notificaciones
   * del checkout usen una ventana mayor sin alterar el resto de flujos (webhook,
   * CTA del menú), que conservan el default de 10 s.
   */
  timeoutMs?: number;
}

export function createKapsoTransport(cfg: KapsoTransportConfig) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const defaultTimeoutMs = cfg.timeoutMs ?? 10_000;

  /**
   * POST único hacia `{baseUrl}/{phone_number_id}/messages`.
   * No lanza: devuelve errores tipados. Todos los envíos pasan por aquí.
   */
  async function postMessage(
    payload: unknown,
    options?: SendOptions,
  ): Promise<KapsoSendResult> {
    const phoneNumberId = options?.phoneNumberId || cfg.phoneNumberId;
    // Presupuesto por envío; si no se indica, el default del cliente (10 s).
    const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(`${cfg.baseUrl}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) return { ok: false, error: 'http_error', status: res.status };

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: 'invalid_response' };
      }

      const parsed = kapsoSendResponseSchema.safeParse(json);
      if (!parsed.success) return { ok: false, error: 'invalid_response' };

      return { ok: true, wamid: parsed.data.messages[0].id };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, error: 'timeout' };
      }
      return { ok: false, error: 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Envía un `location_request_message` y devuelve el wamid de
     * `response.messages[0].id`. No lanza: devuelve errores tipados.
     *
     * `options` es opcional y retrocompatible: sin él conserva el comportamiento
     * previo (phone_number_id del entorno, copy por defecto del WhatsApp Flow).
     * `options.phoneNumberId` responde por otro número; `options.bodyText`
     * cambia solo el texto del cuerpo (p. ej. el copy del checkout web).
     */
    async sendLocationRequest(
      customerPhone: string,
      options?: SendOptions & { bodyText?: string },
    ): Promise<KapsoSendResult> {
      const to = normalizePhone(customerPhone);
      if (!to) return { ok: false, error: 'invalid_phone' };
      // El builder lanza si se pasa un bodyText vacío/solo espacios; aquí se
      // traduce a un error tipado y NO se llama a fetch.
      let payload: ReturnType<typeof buildLocationRequestPayload>;
      try {
        payload = buildLocationRequestPayload(to, options?.bodyText);
      } catch {
        return { ok: false, error: 'invalid_body_text' };
      }
      return postMessage(payload, {
        phoneNumberId: options?.phoneNumberId,
        timeoutMs: options?.timeoutMs,
      });
    },

    /**
     * Envía un mensaje de texto simple y devuelve el wamid. No lanza: devuelve
     * los mismos errores tipados que el resto de envíos (invalid_phone,
     * http_error, invalid_response, timeout, network_error).
     * `options.phoneNumberId` permite responder por el número indicado.
     */
    async sendText(
      customerPhone: string,
      text: string,
      options?: SendOptions,
    ): Promise<KapsoSendResult> {
      const to = normalizePhone(customerPhone);
      if (!to) return { ok: false, error: 'invalid_phone' };
      // El builder lanza si el texto está vacío/solo espacios; aquí se traduce a
      // un error tipado y NO se llama a fetch.
      let payload: ReturnType<typeof buildTextPayload>;
      try {
        payload = buildTextPayload(to, text);
      } catch {
        return { ok: false, error: 'invalid_text' };
      }
      return postMessage(payload, {
        phoneNumberId: options?.phoneNumberId,
        timeoutMs: options?.timeoutMs,
      });
    },

    /**
     * Envía un mensaje de IMAGEN por enlace con caption y devuelve el wamid
     * (Fase 6D.1: QR de pago). No lanza: devuelve los mismos errores tipados que
     * el resto de envíos. `imageUrl` debe ser una URL pública https.
     * `options.phoneNumberId` permite responder por el número indicado.
     */
    async sendImage(
      customerPhone: string,
      imageUrl: string,
      caption: string,
      options?: SendOptions,
    ): Promise<KapsoSendResult> {
      const to = normalizePhone(customerPhone);
      if (!to) return { ok: false, error: 'invalid_phone' };
      // El builder lanza si imageUrl/caption están vacíos; se traduce a error
      // tipado y NO se llama a fetch.
      let payload: ReturnType<typeof buildImagePayload>;
      try {
        payload = buildImagePayload(to, imageUrl, caption);
      } catch {
        return { ok: false, error: 'invalid_image' };
      }
      return postMessage(payload, {
        phoneNumberId: options?.phoneNumberId,
        timeoutMs: options?.timeoutMs,
      });
    },

    /**
     * Envía el mensaje interactivo CTA URL con el botón "Ver menú" (Fase 5.2A/B).
     * `options.phoneNumberId` permite responder por el número del evento.
     * `options.menuUrl` (Fase 5.2B) permite enviar una URL con sesión.
     */
    async sendMenuCtaUrl(
      customerPhone: string,
      // `bodyText` ausente = el cuerpo de saludo de siempre. El transporte NO
      // elige el texto: lo recibe ya decidido, igual que recibe la URL.
      options?: SendOptions & { menuUrl?: string; bodyText?: string; buttonText?: string },
    ): Promise<KapsoSendResult> {
      const to = normalizePhone(customerPhone);
      if (!to) return { ok: false, error: 'invalid_phone' };
      return postMessage(
        buildMenuCtaPayload(
          to,
          options?.menuUrl,
          undefined,
          options?.bodyText,
          options?.buttonText,
        ),
        { phoneNumberId: options?.phoneNumberId },
      );
    },
  };
}

export type KapsoClient = ReturnType<typeof createKapsoTransport>;
