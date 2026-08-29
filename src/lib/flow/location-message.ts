import { z } from 'zod';

/**
 * Parseo y validación del mensaje entrante `type = "location"` — puro.
 *
 * Correlación confirmada por Kapso: `message.context.id` contiene el wamid del
 * `location_request_message` saliente y debe compararse con
 * `orders.location_request_message_id`.
 */

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

export const locationMessageSchema = z.object({
  messageId: z.string().min(1),
  contextId: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address: z.string().optional(),
  name: z.string().optional(),
});

export type LocationMessageData = z.infer<typeof locationMessageSchema>;

export type LocationParseResult =
  | { ok: true; data: LocationMessageData }
  | { ok: false; reason: 'not_location' | 'invalid_shape' };

/** Detecta y valida un mensaje `type = "location"`. */
export function parseLocationMessage(
  message: Record<string, unknown> | undefined,
): LocationParseResult {
  if (!message || message.type !== 'location') return { ok: false, reason: 'not_location' };

  const context = rec(message.context);
  const location = rec(message.location);

  const raw = {
    messageId: message.id,
    contextId: context?.id,
    latitude: location?.latitude,
    longitude: location?.longitude,
    address: location?.address,
    name: location?.name,
  };

  const parsed = locationMessageSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_shape' };

  return { ok: true, data: parsed.data };
}

// ── Un pin que NO responde a nada (0027) ────────────────────────────────────

/**
 * El mismo mensaje, sin exigir `contextId`.
 *
 * `parseLocationMessage` pide el contexto porque su trabajo es CORRELACIONAR:
 * sin el wamid de la petición no hay pedido al que adjuntar el GPS, y adivinarlo
 * sería peor que fallar. Esa exigencia sigue intacta.
 *
 * Pero tiene un efecto que nadie eligió: un cliente que manda su ubicación con
 * el botón normal de WhatsApp —sin responder a nada— produce `invalid_shape` y
 * se queda sin respuesta. No es un mensaje malformado; es un mensaje distinto,
 * con una intención distinta: quiere saber cuánto le sale el envío.
 *
 * Este parser es para ese caso, y por eso no acepta lo que el otro rechazaría
 * por razones reales: unas coordenadas fuera de rango o un mensaje sin id
 * siguen siendo inválidos aquí también.
 */
export const standaloneLocationSchema = locationMessageSchema.omit({ contextId: true });

export type StandaloneLocationData = z.infer<typeof standaloneLocationSchema>;

export type StandaloneLocationParseResult =
  | { ok: true; data: StandaloneLocationData }
  | { ok: false; reason: 'not_location' | 'invalid_shape' };

/** Detecta un `type = "location"` y valida sus coordenadas, sin pedir contexto. */
export function parseStandaloneLocation(
  message: Record<string, unknown> | undefined,
): StandaloneLocationParseResult {
  if (!message || message.type !== 'location') return { ok: false, reason: 'not_location' };

  const location = rec(message.location);

  const parsed = standaloneLocationSchema.safeParse({
    messageId: message.id,
    latitude: location?.latitude,
    longitude: location?.longitude,
    address: location?.address,
    name: location?.name,
  });
  if (!parsed.success) return { ok: false, reason: 'invalid_shape' };

  return { ok: true, data: parsed.data };
}
