import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';
import {
  PAUSE_REASON_HUMAN_BUSINESS_APP,
  type AgentStore,
  type HumanTakeoverResult,
} from '@/lib/agent/core/types';

/**
 * Duración por defecto de la pausa por takeover, en minutos.
 *
 * Media hora es una conversación de WhatsApp: lo bastante para que quien está
 * atendiendo termine sin que el agente le pise, y lo bastante poco para que una
 * conversación olvidada no se quede muerta hasta que alguien la reanime.
 */
export const DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES = 30;

/** Un minuto: por debajo, la pausa no llega a proteger nada. */
export const MIN_HUMAN_TAKEOVER_PAUSE_MINUTES = 1;
/** Un día. Más allá de esto, lo que se quiere es una pausa indefinida. */
export const MAX_HUMAN_TAKEOVER_PAUSE_MINUTES = 1440;

/**
 * Interpreta `HUMAN_TAKEOVER_PAUSE_MINUTES`.
 *
 * FAIL-SAFE, igual que `AI_ENABLED === 'true'`: el esquema de entorno valida la
 * FORMA (una cadena) y el significado se decide aquí. Cualquier valor que no sea
 * un entero dentro del rango cae al default y NO lanza — una variable mal
 * escrita no puede dejar al negocio sin recibir mensajes de WhatsApp.
 *
 * Fuera de rango cae al default en vez de recortarse: convertir un `5000` en
 * `1440` sería honrar a medias algo que casi seguro es un error de tecleo, y en
 * silencio. El default está documentado; el recorte no lo estaría.
 */
export function humanTakeoverPauseMinutes(raw: string | null | undefined): number {
  if (typeof raw !== 'string') return DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES;

  const trimmed = raw.trim();
  // `Number('')` es 0 y `Number(' 12 ')` es 12: se exigen dígitos y nada más,
  // para que ni el vacío ni un '30m' ni un '1e3' se cuelen como válidos.
  if (!/^[0-9]+$/.test(trimmed)) return DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES;

  const minutes = Number(trimmed);
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < MIN_HUMAN_TAKEOVER_PAUSE_MINUTES ||
    minutes > MAX_HUMAN_TAKEOVER_PAUSE_MINUTES
  ) {
    return DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES;
  }
  return minutes;
}

/** Vencimiento de la pausa a partir del instante de la intervención humana. */
export function pauseExpiryFrom(pausedAt: string, minutes: number): string {
  return new Date(Date.parse(pausedAt) + minutes * 60_000).toISOString();
}

/**
 * Human takeover — lógica PURA sobre un `AgentStore` inyectado (Fase 6D.2F.2B,
 * TTL en 6D.2F.5C.1).
 *
 * Se dispara SOLO con `whatsapp.message.sent` + `direction=outbound` +
 * `origin=business_app` (lo decide `parseKapsoProvenance`, no este módulo).
 *
 * Secuencia:
 *   1. upsert de la conversación por teléfono (identidad durable)
 *   1b. ¿este wamid ya completó su takeover? entonces no se escribe nada
 *   2. persistir el mensaje humano REAL
 *   3. avanzar `last_human_message_at`
 *   4. pausar hasta `paused_at + pauseMinutes`, o RENOVAR ese plazo
 *   5. registrar el evento de control
 *
 * Nunca llama a OpenAI ni envía nada.
 *
 * ── La pausa es TEMPORAL y renovable ────────────────────────────────────────
 *
 * Antes era indefinida y solo la levantaba un resume manual. El coste real de
 * eso es que una conversación se queda muerta si nadie se acuerda de reanudarla:
 * el cliente escribe y no le contesta ni la persona ni el agente.
 *
 * Ahora cada mensaje humano fija el vencimiento en `pauseMinutes` desde ESE
 * mensaje. El reloj cuenta desde la última intervención humana, no desde la
 * primera: mientras alguien atienda, la pausa no se agota.
 *
 * El vencimiento se calcula sobre `messageTimestamp` —el instante del propio
 * mensaje— y no sobre el reloj local. Dos razones, y la segunda es dura:
 * semánticamente el plazo cuenta desde que la persona escribió, no desde que
 * nuestro webhook se puso a procesarlo; y como `paused_at` es ese mismo
 * instante, el CHECK `pause_expires_at > paused_at` de 0014 queda garantizado.
 * Con el reloj local, un timestamp del proveedor ligeramente adelantado abortaría
 * la transacción entera — y perder una pausa es lo peor que puede pasar aquí.
 *
 * ── Un WAMID humano produce UN takeover, y solo uno ─────────────────────────
 *
 * La regla dura: un mensaje humano que YA completó su takeover no puede producir
 * otro nunca, por muchas veces que Kapso lo reentregue y por mucho que la
 * conversación haya vuelto a `active` mientras tanto.
 *
 * Sin esta barrera había un agujero real. `webhook_events` deduplica por CLAVE
 * DE IDEMPOTENCIA, no por WAMID, y Kapso puede reentregar el mismo mensaje con
 * otra clave: entonces el evento se procesa de verdad y llega aquí. Si para
 * entonces la pausa había vencido —o alguien la había levantado a mano—, la
 * conversación estaba `active`, `pauseConversation` pasaba su guard y la volvía
 * a pausar. Un reintento de red deshacía una decisión humana.
 *
 * La marca durable es el EVENTO DE CONTROL, y no hace falta inventar ninguna:
 * es la última escritura de la secuencia, así que si existe para este wamid,
 * las anteriores también ocurrieron. Nada de heurísticas de tiempo.
 *
 *   evento presente  → takeover COMPLETO. No se escribe nada. `already_applied`.
 *   evento ausente   → primera vez, o ejecución a medias. Se ejecuta entera.
 *
 * Y por eso NO basta con mirar si el mensaje ya estaba: `insertMessage` es el
 * PRIMER paso, y un `duplicate` suyo es exactamente lo que se ve cuando la
 * ejecución anterior murió justo después de insertarlo. Cortar ahí perdería la
 * capacidad de reparar, que es la mitad de por qué esto es reintentable.
 *
 * ── Idempotencia de la renovación ───────────────────────────────────────────
 *
 * Superada la barrera, los pasos 2, 4 y 5 siguen siendo individualmente
 * idempotentes: una reentrega de una ejecución PARCIAL completa lo que falte sin
 * duplicar lo que ya estaba.
 *
 * Renovar el plazo, en cambio, exige distinguir una intervención nueva de una
 * repetida, y el resultado de la inserción ya lo dice sin nada más:
 *
 *   `inserted`  → intervención NUEVA. Pausa o renueva el plazo.
 *   `duplicate` → ejecución parcial. Se completa la pausa que faltaba, pero NO
 *                 se renueva nada: no hay intervención nueva que contar.
 *
 * Así, tres entregas del mismo mensaje humano no alargan la pausa a hora y
 * media. Y la renovación es MONÓTONA (guard en `renewPause`): un mensaje humano
 * nuevo pero con timestamp anterior al vigente no puede acortar el takeover.
 *
 * El evento de control tiene además su propia idempotencia por el UNIQUE parcial
 * (conversación, action, wamid) de 0014, y un mensaje humano NUEVO inserta un
 * evento NUEVO — el historial es append-only, uno por intervención.
 */
export async function handleHumanTakeover(
  message: ProvenanceMessage,
  store: AgentStore,
  now: () => string = () => new Date().toISOString(),
  pauseMinutes: number = DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES,
): Promise<HumanTakeoverResult> {
  // Sin teléfono no hay identidad durable a la que asociar la conversación.
  if (message.customerPhone === '') {
    return { result: 'rejected', reason: 'missing_phone' };
  }
  // Sin wamid no hay idempotencia posible: una reentrega duplicaría el mensaje
  // y el evento de control. Se rechaza de forma determinista, sin reintento.
  if (message.providerMessageId === null) {
    return { result: 'rejected', reason: 'missing_message_id' };
  }

  const conversation = await store.upsertConversation({
    customerPhone: message.customerPhone,
    providerConversationId: message.providerConversationId,
    providerPhoneNumberId: message.providerPhoneNumberId,
  });

  // Barrera de ejecución única por WAMID. Va ANTES de cualquier escritura: si
  // este mensaje ya completó su takeover, esta entrega no existe para el estado.
  const yaAplicado = await store.hasPauseEventForMessage(
    conversation.id,
    message.providerMessageId,
  );
  if (yaAplicado) {
    return {
      result: 'ok',
      conversationId: conversation.id,
      // Las tres escrituras ya estaban hechas; ninguna se intentó de nuevo.
      message: 'duplicate',
      pause: 'already_applied',
      controlEvent: 'duplicate',
    };
  }

  // El instante del proveedor manda; el fallback a "ahora" se decide AQUÍ y de
  // forma explícita, nunca en la base (0014 no pone default a message_timestamp).
  const messageTimestamp = message.messageTimestamp ?? now();

  const inserted = await store.insertMessage({
    agentConversationId: conversation.id,
    providerMessageId: message.providerMessageId,
    providerConversationId: message.providerConversationId,
    direction: 'outbound',
    role: 'assistant',
    actor: 'human',
    content: message.content,
    contentType: message.contentType,
    metadata: message.metadata,
    messageTimestamp,
  });

  await store.touchHumanMessageAt(conversation.id, messageTimestamp);

  const pauseExpiresAt = pauseExpiryFrom(messageTimestamp, pauseMinutes);

  const pause = await store.pauseConversation({
    agentConversationId: conversation.id,
    pausedAt: messageTimestamp,
    pauseExpiresAt,
    reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
    source: 'business_app',
  });

  // Ya estaba pausada. Si este mensaje es una intervención NUEVA, el reloj se
  // reinicia desde él; si es una reentrega, no se toca nada (ver el encabezado).
  //
  // El guard de tipo va en el store: solo se renueva una pausa que sea de este
  // mismo takeover. Una pausa indefinida puesta a mano desde otro sitio no se
  // convierte en temporal porque alguien escriba desde la app.
  if (pause === 'already_paused' && inserted === 'inserted') {
    await store.renewPause({
      agentConversationId: conversation.id,
      pauseExpiresAt,
      reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
      source: 'business_app',
    });
  }

  const controlEvent = await store.insertControlEvent({
    agentConversationId: conversation.id,
    action: 'pause',
    source: 'business_app',
    reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
    providerMessageId: message.providerMessageId,
    // Hasta cuándo iba a durar ESTA intervención. Que el historial lo diga es lo
    // que permite reconstruir después por qué el agente calló o volvió a hablar.
    expiresAt: pauseExpiresAt,
    // Solo información estructural. Nunca contenido del mensaje ni teléfono.
    metadata: { trigger: 'whatsapp.message.sent' },
  });

  return {
    result: 'ok',
    conversationId: conversation.id,
    message: inserted,
    pause,
    controlEvent,
  };
}
