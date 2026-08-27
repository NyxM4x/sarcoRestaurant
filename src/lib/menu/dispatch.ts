import { classifyKapsoSendFailure } from '@/lib/kapso/send-outcome';

/**
 * SHARED MENU DISPATCH — módulo PURO (Fase 6D.2F.5A).
 *
 * Única autoridad sobre el efecto "mandarle el menú a un cliente". Hoy entra
 * por la ruta determinística; en 6D.2F.5B entrará también `send_menu()` desde
 * el agente. Las dos puertas atraviesan esta función, porque si cada una
 * llevara su propia idempotencia acabarían discrepando justo el día en que un
 * cliente escriba dos veces.
 *
 * ── La ÚNICA protección contra duplicados ───────────────────────────────────
 *
 *   IDEMPOTENCIA TÉCNICA   mismo WAMID entrante → jamás dos CTAs.
 *
 * Un mensaje NUEVO del cliente es un evento nuevo y puede producir un CTA
 * nuevo. No hay ventana temporal que lo impida: hasta 6D.2F.5B existió un
 * cooldown de quince minutos para `agent_suggestion`, y se eliminó porque
 * bloqueaba interacciones legítimas. Que alguien acabe de recibir el menú no
 * lo descalifica para volver a pedirlo dos minutos después —el enlace no le
 * cargó, cerró la ventana, cambió de idea— y adivinar cuál de esas cosas pasó
 * con un reloj es adivinar mal.
 *
 * Contener ráfagas y bucles NO es trabajo de esta función: el buffering nativo
 * de Kapso reduce varios mensajes seguidos a un turno lógico, y el Conversation
 * Guard se ocupará del flood real. Mezclar eso aquí ya se probó y penalizaba a
 * quien no había hecho nada.
 *
 * ── Por qué el orden es este ────────────────────────────────────────────────
 *
 *   1. sesión de menú       ← idempotente por `source_message_id`, sin efecto visible
 *   2. CLAIM                ← inmediatamente antes del envío
 *   3. Kapso                ← el único efecto irreversible
 *   4. cierre + memoria
 *
 * El claim va lo más TARDE posible sin dejar de ir antes del envío. Así, si la
 * fila queda en `pending`, solo puede significar "nos caímos durante la llamada
 * a Kapso" — el caso ambiguo en el que no reenviar es exactamente lo correcto.
 * Si el claim fuera antes de crear la sesión, un fallo transitorio de base
 * dejaría ese mensaje del cliente sin menú para siempre.
 */

/**
 * Por qué se mandó el menú. Lo decide el BACKEND, nunca el modelo.
 *
 * Desde la eliminación del cooldown es **observabilidad pura**: ya no abre ni
 * cierra ninguna puerta, y ningún camino del código se ramifica por este valor.
 *
 * CUIDADO CON LEERLO DE MÁS. `agent_suggestion` significa exactamente "el
 * entrante no nombraba el menú ni la carta", NO "el agente actuó por iniciativa
 * propia". "¿Qué hamburguesas tienen?" es una petición clarísima de explorar
 * productos y queda igualmente como `agent_suggestion`, porque no dijo ninguna
 * de las dos palabras.
 *
 * Por eso NO sirve como señal directa de un Conversation Guard: contar
 * `agent_suggestion` no cuenta menús no solicitados, cuenta menús pedidos con
 * otras palabras.
 */
export type MenuSendReason =
  /** El cliente lo pidió en este mensaje. */
  | 'explicit_request'
  /** El cliente pide que se lo manden otra vez ("no me llegó"). */
  | 'explicit_resend'
  /** Nadie lo pidió: al agente le pareció útil. */
  | 'agent_suggestion'
  /** Trigger interno de QA (TESTMENU9842). */
  | 'qa_trigger';

/**
 * Estados que admite la columna `status` de 0015.
 *
 * `blocked_recent` sigue en la lista porque sigue en el CHECK de la migración,
 * y una fila vieja puede traerlo al leerse. Lo que ya NO existe es un camino
 * que lo produzca: ver `DispatchMenuResult`.
 */
export type MenuDeliveryStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'send_unknown'
  /** LEGACY. Ninguna ejecución lo escribe desde que se quitó el cooldown. */
  | 'blocked_recent';

export interface ClaimMenuDeliveryInput {
  customerPhone: string;
  sourceMessageId: string;
  reason: MenuSendReason;
  claimedAt: string;
}

/** `exists` = otra ejecución ya reclamó este WAMID. No se envía nada. */
export type ClaimMenuDeliveryResult =
  | { result: 'claimed'; deliveryId: string }
  | { result: 'exists'; deliveryId: string; status: MenuDeliveryStatus };

export interface FinishMenuDeliveryInput {
  deliveryId: string;
  status: Exclude<MenuDeliveryStatus, 'pending'>;
  completedAt: string;
  providerMessageId?: string | null;
  errorCode?: string | null;
}

export interface MenuDeliveryStore {
  /** INSERT ... ON CONFLICT DO NOTHING sobre `source_message_id`. */
  claim(input: ClaimMenuDeliveryInput): Promise<ClaimMenuDeliveryResult>;
  finish(input: FinishMenuDeliveryInput): Promise<void>;
}

export interface MenuSessionPort {
  createUrl(input: {
    sourceMessageId: string;
    customerPhone: string;
    phoneNumberIdFromEvent: string | null;
  }): Promise<{ sessionUrl: string; effectivePhoneNumberId: string }>;
}

export type MenuSendResult =
  | { ok: true; wamid: string }
  | { ok: false; error: string; status?: number };

export interface MenuSendPort {
  sendCta(input: {
    customerPhone: string;
    menuUrl: string;
    phoneNumberId: string;
  }): Promise<MenuSendResult>;
}

/**
 * Memoria conversacional del automatismo. OPCIONAL: sin ella el despacho se
 * comporta exactamente como antes de esta fase (envía y no recuerda).
 */
export interface MenuAutomationMemoryPort {
  recordMenuSent(input: {
    customerPhone: string;
    providerMessageId: string;
    phoneNumberId: string;
    sentAt: string;
  }): Promise<void>;
}

export interface MenuDispatchDeps {
  deliveries: MenuDeliveryStore;
  session: MenuSessionPort;
  send: MenuSendPort;
  /** Ausente = no se persiste el saliente automático. */
  memory?: MenuAutomationMemoryPort;
  now?: () => string;
}

export interface DispatchMenuInput {
  /** Dígitos ya normalizados. */
  customerPhone: string;
  /** WAMID REAL del entrante. Sin él no hay idempotencia posible. */
  sourceMessageId: string;
  phoneNumberId: string | null;
  reason: MenuSendReason;
}

/**
 * Desenlaces posibles. NO incluye `blocked_recent`: ninguna ejecución puede
 * producirlo desde que se quitó el cooldown, y dejarlo aquí obligaría a todos
 * los que consumen este resultado a manejar una rama muerta.
 */
export type DispatchMenuResult =
  | { result: 'sent'; deliveryId: string; wamid: string }
  /** Este WAMID ya fue procesado. Nunca se reenvía. */
  | { result: 'duplicate'; deliveryId: string; status: MenuDeliveryStatus }
  | { result: 'failed'; deliveryId: string; error: string }
  | { result: 'send_unknown'; deliveryId: string; error: string };

export async function dispatchMenu(
  input: DispatchMenuInput,
  deps: MenuDispatchDeps,
): Promise<DispatchMenuResult> {
  const now = deps.now ?? (() => new Date().toISOString());

  // ── 1. Sesión ─────────────────────────────────────────────────────────────
  // Antes del claim a propósito: es idempotente por `source_message_id` y no
  // produce ningún efecto que el cliente pueda ver. Si falla, no queda fila
  // reclamada y el reintento del webhook puede volver a intentarlo.
  const { sessionUrl, effectivePhoneNumberId } = await deps.session.createUrl({
    sourceMessageId: input.sourceMessageId,
    customerPhone: input.customerPhone,
    phoneNumberIdFromEvent: input.phoneNumberId,
  });

  // ── 2. Claim ──────────────────────────────────────────────────────────────
  const claim = await deps.deliveries.claim({
    customerPhone: input.customerPhone,
    sourceMessageId: input.sourceMessageId,
    reason: input.reason,
    claimedAt: now(),
  });
  if (claim.result === 'exists') {
    // Incluye el caso `pending`: otra ejecución está —o estuvo— dentro de la
    // llamada a Kapso. Reenviar aquí es justo lo que este ledger impide.
    return { result: 'duplicate', deliveryId: claim.deliveryId, status: claim.status };
  }
  const deliveryId = claim.deliveryId;

  // ── 3. Envío ──────────────────────────────────────────────────────────────
  const sent = await deps.send.sendCta({
    customerPhone: input.customerPhone,
    menuUrl: sessionUrl,
    phoneNumberId: effectivePhoneNumberId,
  });

  if (!sent.ok) {
    const status = classifyKapsoSendFailure(sent.error, sent.status);
    // El STATUS HTTP viaja en el código, no se tira.
    //
    // `send.http_error` a secas no distingue una credencial rechazada (401) de
    // un payload que Meta no acepta (400) ni de un límite de tarifa (429), que
    // son tres problemas con tres respuestas distintas. Sin este dato, el único
    // camino para diagnosticar un fallo de envío es sondear la API a mano
    // reproduciendo la llamada — y eso ya nos costó una sesión entera.
    //
    // Cabe de sobra en el CHECK de formato (`[A-Za-z0-9._:-]{1,64}`) y no
    // arrastra nada del cliente: es un número de tres cifras.
    const errorCode =
      sent.status === undefined ? `send.${sent.error}` : `send.${sent.error}.${sent.status}`;
    await deps.deliveries.finish({ deliveryId, status, completedAt: now(), errorCode });
    return status === 'failed'
      ? { result: 'failed', deliveryId, error: errorCode }
      : { result: 'send_unknown', deliveryId, error: errorCode };
  }

  // ── 4. Cierre y memoria ───────────────────────────────────────────────────
  // El ledger PRIMERO: es la evidencia del efecto. La memoria conversacional
  // es contabilidad nuestra y no puede provocar un reenvío si falla.
  const sentAt = now();
  await deps.deliveries.finish({
    deliveryId,
    status: 'sent',
    completedAt: sentAt,
    providerMessageId: sent.wamid,
  });

  if (deps.memory) {
    try {
      await deps.memory.recordMenuSent({
        customerPhone: input.customerPhone,
        providerMessageId: sent.wamid,
        phoneNumberId: effectivePhoneNumberId,
        sentAt,
      });
    } catch {
      // El CTA ya está en el teléfono del cliente. Que no hayamos podido
      // anotarlo no lo des-envía: se traga el error y el ledger conserva la
      // verdad. Reconciliar esa fila queda pendiente explícito.
    }
  }

  return { result: 'sent', deliveryId, wamid: sent.wamid };
}
