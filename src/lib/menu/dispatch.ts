import { classifyKapsoSendFailure } from '@/lib/kapso/send-outcome';
import type { MenuCtaContext } from './cta-context';

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
    /**
     * Pedido al que el enlace viene a SUSTITUIR (0035). Ausente = enlace normal.
     *
     * Viaja hasta la sesión porque es ella quien lo guarda: el checkout lo lee
     * de ahí, no del navegador. Ver `menu_sessions.replaces_order_id`.
     */
    replacesOrderId?: string | null;
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
    /**
     * De qué venía hablando el cliente. Elige el copy con más precisión que el
     * motivo y, a diferencia de él, NO se persiste: no es un hecho del envío,
     * es una lectura del mensaje anterior. Ver `menu/cta-context.ts`.
     */
    ctaContext?: MenuCtaContext | null;
    /** Etiqueta del botón. Ausente = "Ver menú", que es lo que dice casi siempre. */
    buttonText?: string;
    /**
     * Por qué se manda. Decide QUÉ TEXTO acompaña al botón — no a quién ni con
     * qué enlace.
     *
     * Viaja hasta aquí porque este módulo no conoce ni una letra del copy, y no
     * debe: el texto es del canal, la decisión de mandarlo es de aquí. Lo que
     * cruza la frontera es el motivo, que ya se calculaba para el ledger.
     */
    reason: MenuSendReason;
    /** Cuerpo ya redactado. Ver `DispatchMenuInput.bodyText`. */
    bodyText?: string;
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
    /**
     * El mismo motivo que decidió el texto enviado. La memoria tiene que poder
     * guardar el mensaje REAL que vio el cliente; con varias variantes, sin
     * esto guardaría siempre la de saludo y el historial mentiría.
     */
    reason: MenuSendReason;
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
  /** De qué venía hablando el cliente; solo elige el copy. No se persiste. */
  ctaContext?: MenuCtaContext | null;
  /** Dígitos ya normalizados. */
  customerPhone: string;
  /** WAMID REAL del entrante. Sin él no hay idempotencia posible. */
  sourceMessageId: string;
  phoneNumberId: string | null;
  reason: MenuSendReason;
  /**
   * Pedido al que este enlace viene a SUSTITUIR (0035). Ausente = ninguno.
   *
   * Cambia lo que el enlace SIGNIFICA, no a quién se manda: el checkout que lo
   * reciba reemplazará ese pedido en vez de acumular otro. Por eso viaja aquí y
   * no en el copy — el texto se puede reescribir, esto no.
   */
  replacesOrderId?: string | null;
  /** Etiqueta del botón. Ausente = la de siempre. */
  buttonText?: string;
  /**
   * Cuerpo del mensaje, ya redactado por quien llama. Ausente = lo elige el
   * canal a partir de `reason` y `ctaContext`, que es el caso normal.
   *
   * ── Para qué existe, y para qué NO ──────────────────────────────────────
   *
   * Existe por un texto que NO se puede escribir de antemano: la cotización del
   * envío lleva la tarifa dentro ("el envío sale Bs 15"), y esa cifra sale de
   * `feeForMeters` en tiempo de ejecución. Sin este canal, ese mensaje tenía
   * que salir por su lado como texto plano — y salía diciéndole al cliente
   * "armá tu pedido en el menú" sin darle ningún menú que tocar.
   *
   * NO es un hueco para texto del modelo. Lo que entre aquí tiene que estar
   * construido en backend a partir de datos del backend; una frase generada es
   * exactamente lo que el `effectCompletesTurn` de `send_menu` impide, y
   * dejarla entrar por esta puerta lo desharía por detrás.
   */
  bodyText?: string;
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
    replacesOrderId: input.replacesOrderId ?? null,
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
    ctaContext: input.ctaContext ?? null,
    reason: input.reason,
    bodyText: input.bodyText,
    buttonText: input.buttonText,
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
        reason: input.reason,
      });
    } catch {
      // El CTA ya está en el teléfono del cliente. Que no hayamos podido
      // anotarlo no lo des-envía: se traga el error y el ledger conserva la
      // verdad. Reconciliar esa fila queda pendiente explícito.
    }
  }

  return { result: 'sent', deliveryId, wamid: sent.wamid };
}
