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
