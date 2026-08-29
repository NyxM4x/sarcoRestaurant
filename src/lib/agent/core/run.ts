import { log } from '@/lib/log';
import { classifyKapsoSendFailure, type SendOutcome } from '@/lib/kapso/send-outcome';
import {
  buildSelectionContext,
  buildWorkingContext,
  contextWindowStart,
  CONTEXT_MAX_MESSAGES,
} from './context';
import { evaluateAgentEligibility, type AgentEligibilityConfig } from './eligibility';
import { isPauseActive } from '@/lib/agent/control/pause-gate';
import type {
  AgentModel,
  AgentModelContentPart,
  AgentModelInput,
  AgentModelMessage,
  AgentModelResult,
} from './model';
import { createTurnMediaBudget, type MediaResolverPort, type TurnMediaLimits } from './media';
import {
  executeToolCall,
  findAgentTool,
  hasNoArguments,
  type AgentTool,
} from '@/lib/agent/tools/registry';
import type {
  AgentRunStore,
  AgentSendPort,
  AgentSendResult,
  AgentStore,
  AgentTurnResult,
} from './types';
import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';

/**
 * AGENT CORE — ejecución de un turno (Fase 6D.2F.3). Módulo PURO.
 *
 * Orden, y el porqué de cada paso:
 *
 *   1. ELEGIBILIDAD — flags y teléfono. Un `no` no toca la base ni crea run.
 *   2. DATOS MÍNIMOS — sin teléfono o sin WAMID no hay identidad ni idempotencia.
 *   3. CONVERSACIÓN — debe existir ya: la creó la persistencia del entrante.
 *   4. CLAIM DEL RUN — barrera de idempotencia ANTES de gastar un solo token.
 *   5. PAUSA — si un humano tiene el control, el run muere en `skipped_paused`.
 *   6. CONTEXTO — ventana corta, no el historial entero.
 *   7. SELECCIÓN DE ACCIÓN — el modelo elige UNA capacidad, sin escribir nada.
 *   8. EJECUCIÓN — la acción elegida, si tiene algo que ejecutar.
 *   9. REDACCIÓN — solo si después de actuar queda algo que decir.
 *  10. `sending` — se marca ANTES de enviar, para que un crash no parezca éxito.
 *  11. ENVÍO y persistencia del saliente de IA.
 *
 * ── Por qué la decisión va antes que el texto (Fase 6D.2F.5B.1) ─────────────
 *
 * Hasta aquí el turno era un bucle: el modelo podía pedir herramientas o
 * ponerse a escribir, y "no pedir ninguna" era el camino por omisión — no había
 * que elegirlo, se llegaba a él por defecto. Eso dejaba una respuesta libre
 * disponible SIEMPRE, incluso cuando la respuesta correcta era una acción, y
 * una omisión no deja rastro: en la base no había forma de distinguir "decidió
 * contestar hablando" de "se olvidó de decidir".
 *
 * Ahora hay dos rondas con trabajos distintos, y el orden importa:
 *
 *   DECIDIR    qué capacidad necesita este turno. Obligatoria, exactamente una,
 *              y sin producir una sola palabra para el cliente.
 *   REDACTAR   qué decir, si es que queda algo por decir. Sin herramientas.
 *
 * Y hay acciones cuyo efecto YA es la respuesta (`effectCompletesTurn`): si el
 * efecto sale confirmado, el turno cierra sin pedir texto. Ahí está la parte
 * que importa — una frase que afirme un efecto no puede existir sin el efecto,
 * porque cuando el efecto ocurre no se escribe ninguna frase.
 *
 * Lo que este módulo NO hace y no debe hacer nunca: crear pedidos, calcular
 * precios, cotizar delivery, tocar GPS, generar QR, confirmar pagos, cambiar
 * estados de pedido ni enviar el menú. Todo eso vive en las rutas
 * determinísticas y el agente ni siquiera las puede alcanzar desde aquí: sus
 * únicas dependencias son un store, un modelo y un `sendText`.
 *
 * Este turno solo se invoca cuando el pipeline determinístico YA declinó el
 * mensaje. La decisión de cuándo llamar es del webhook, no del agente.
 */

export interface AgentTurnDeps {
  store: AgentStore;
  runs: AgentRunStore;
  model: AgentModel;
  send: AgentSendPort;
  config: AgentEligibilityConfig;
  /** Identidad del negocio. Viene del Business Adapter, no del core. */
  systemPrompt: string;
  maxOutputTokens?: number;
  /**
   * Acciones entre las que el modelo elige UNA (Fase 6D.2F.5B.1). Las provee el
   * Business Adapter; el core no sabe cuáles son ni qué hacen.
   *
   * Ausentes = el modelo solo escribe, exactamente como antes de que existieran
   * las herramientas. Es el interruptor de apagado, y sigue siendo el único.
   */
  actions?: readonly AgentTool[];
  /**
   * Resolutor de imágenes (Fase 6D.2F.5C.5). Ausente = el turno no mira
   * ninguna foto y se comporta como antes: es el interruptor de apagado de
   * Vision, y su ausencia NO es un error.
   */
  media?: MediaResolverPort;
  /**
   * Presupuesto multimodal del turno. Ausente = `DEFAULT_TURN_MEDIA_LIMITS`.
   * Se inyecta para poder PROBAR el agotamiento sin esperar de verdad; en
   * Production nadie lo pasa.
   */
  mediaLimits?: TurnMediaLimits;
  now?: () => string;
}

/**
 * El BURST: los entrantes del cliente que llegaron en ESTA entrega, en el orden
 * original de `data[]`.
 *
 * Existe porque un turno multimodal no se explica solo con su ancla. En
 * `[foto, "qué hamburguesa es esta?"]` el ancla es el texto, pero lo que hay que
 * mirar está en el otro elemento. El historial no sirve para eso: guarda el
 * caption, no los píxeles.
 *
 * Ausente = burst de uno, el propio ancla. Así el camino individual no cambia.
 */
export type AgentTurnBurst = readonly ProvenanceMessage[];

/**
 * Resuelve las imágenes del burst en su ORDEN ORIGINAL, dentro del presupuesto
 * del turno.
 *
 * Todo lo que puede salir mal sale hacia el mismo sitio: ninguna parte visual y
 * un contador de fallos. Nunca hacia una descripción inventada, y nunca hacia
 * una excepción que tumbe un turno que aún puede responder por el caption.
 *
 * ── El presupuesto se consulta ANTES de cada descarga ───────────────────────
 *
 * Cupo de imágenes, bytes totales y tiempo del conjunto (ver `TurnMediaLimits`).
 * Lo que no cabe NO se descarga: se cuenta como fallo, con su motivo, y el turno
 * se entera de que hubo fotos que no miró. Las que sí caben son las PRIMERAS del
 * burst, en su posición original — el orden se conserva porque el recorrido es
 * de principio a fin y nunca se reordena nada.
 *
 * ── Secuencial, y por qué basta ─────────────────────────────────────────────
 *
 * Con un cupo de 3 y un techo de tiempo para el conjunto, el peor caso de reloj
 * es el presupuesto entero —12 s— y no `3 × 8 s`: cada descarga recibe lo que
 * QUEDA, no el techo individual. Añadir concurrencia acotada solo mejoraría la
 * latencia del caso de varias fotos a la vez, que es el raro, a cambio de un
 * planificador que hay que mantener. Lo que había que impedir era que N imágenes
 * multiplicaran el timeout, y eso lo impide el presupuesto, no la concurrencia.
 *
 * Los logs no llevan URL, ni bytes de la imagen, ni base64, ni el caption: solo
 * forma y desenlace. Una URL de media es una credencial de acceso a la foto de
 * alguien, y un log es exactamente donde no debe quedarse.
 */
async function resolveBurstImages(
  burst: AgentTurnBurst,
  deps: AgentTurnDeps,
  runId: string,
  nowMs: () => number,
): Promise<{ parts: AgentModelContentPart[]; failures: number }> {
  const parts: AgentModelContentPart[] = [];
  let requested = 0;
  let failures = 0;

  const budget = createTurnMediaBudget({ limits: deps.mediaLimits, now: nowMs });

  /** Un fallo, contado y registrado. Nunca lleva más que el motivo. */
  const fallo = (error: string, durationMs?: number): void => {
    failures += 1;
    log.warn('agent_image_resolved', {
      runId,
      ok: false,
      error,
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    });
  };

  for (const [index, mensaje] of burst.entries()) {
    const adjunto = mensaje.image;
    if (!adjunto) continue;
    requested += 1;

    log.info('agent_image_received', {
      runId,
      mime_type: adjunto.facts.mimeType,
      byte_size: adjunto.facts.byteSize,
      has_caption: adjunto.caption !== null,
      batch_index: index,
    });

    // Sin resolver cableado no hay Vision: se cuenta como fallo para que el
    // modelo sepa que hubo una foto que no miró, en vez de ignorarla en silencio.
    if (!deps.media) {
      fallo('not_configured');
      continue;
    }

    // ── LA PUERTA DEL PRESUPUESTO ─────────────────────────────────────────────
    const sitio = budget.admit(adjunto.facts.byteSize);
    if (!sitio.ok) {
      fallo(sitio.error);
      continue;
    }

    const empezado = nowMs();
    const resuelto = await deps.media.resolveImage(adjunto, mensaje.providerPhoneNumberId, {
      timeoutMs: sitio.timeoutMs,
    });
    const duracion = nowMs() - empezado;

    if (!resuelto.ok) {
      fallo(resuelto.error, duracion);
      continue;
    }

    // Los bytes REALES, contra el total del turno. Un servidor que mintiera con
    // `content-length` no puede colar la foto por la puerta de atrás.
    const contabilizado = budget.account(resuelto.byteSize);
    if (!contabilizado.ok) {
      fallo(contabilizado.error, duracion);
      continue;
    }

    log.info('agent_image_resolved', {
      runId,
      ok: true,
      source: resuelto.source,
      duration_ms: duracion,
      byte_size: resuelto.byteSize,
      mime_type: resuelto.mimeType,
    });
    parts.push({ type: 'input_image', image_url: resuelto.dataUrl, detail: 'auto' });
  }

  if (requested > 0) {
    log.info('agent_multimodal_request', {
      runId,
      image_count_requested: requested,
      image_count_resolved: parts.length,
      image_count_unavailable: failures,
      total_image_bytes: budget.totalBytes(),
      detail: 'auto',
    });
  }

  return { parts, failures };
}

/**
 * La ronda de decisión. Hoy hay exactamente una por turno, y por eso el número
 * es constante: se registra igualmente para que `agent_runs.tool_rounds` y el
 * log digan lo mismo, y para que el día que la selección se vuelva iterativa el
 * campo ya signifique lo que tiene que significar.
 *
 * Que valga 1 y no 0 sostiene el invariante de 5B.1: un turno que llegó a
 * decidir NUNCA queda con `tool_rounds = 0`. Ese cero era la firma del fallo —
 * texto libre sin ninguna decisión detrás— y ahora es irrepresentable.
 */
export const SELECTION_ROUND = 1;

/**
 * Una selección que no se puede honrar. Todas cierran el run en `failed` y
 * NINGUNA envía nada: si no se sabe qué había que hacer, callarse es la única
 * respuesta honesta. Encajan en el CHECK de `error_code`: `[A-Za-z0-9._:-]{1,64}`.
 */
export type SelectionFailure =
  /** El modelo no eligió ninguna acción, aunque se le exigió elegir. */
  | 'selection.no_action'
  /** Eligió varias. No se ejecuta ninguna: el contrato es UNA. */
  | 'selection.multiple_actions'
  /** Se inventó un nombre que no está en el catálogo. */
  | 'selection.unknown_action'
  /** Mandó argumentos a una acción que no los tiene. */
  | 'selection.invalid_arguments';

/**
 * ¿Consta que el mensaje NO salió, o simplemente no lo sabemos?
 *
 * La diferencia importa: `failed` significa "consta que no se dijo nada" y algún
 * día podrá reintentarse; `send_unknown` significa "desde aquí no hay certeza" y
 * NUNCA debe reenviarse a ciegas, porque duplicar un mensaje en el WhatsApp del
 * cliente es peor que quedarse callado.
 *
 * Evidencia real que da la API de Kapso: en éxito devuelve `messages[0].id` (el
 * WAMID). Sin esa respuesta no hay forma de saber si el mensaje entró, y desde
 * el cliente HTTP no se puede afirmar en qué punto falló el servidor.
 *   · invalid_phone / invalid_text → rechazado ANTES del fetch: no salió.
 *   · http_error 4xx              → rechazo determinista de la petición: no salió.
 *   · http_error 5xx              → sin certeza suficiente sobre el resultado.
 *   · invalid_response            → 2xx ilegible: sin certeza.
 *   · timeout / network_error     → sin respuesta: sin certeza.
 *
 * El criterio vive en `@/lib/kapso/send-outcome` desde 6D.2F.5A: el envío del
 * menú hace exactamente la misma pregunta, y tener dos copias de "cuándo es
 * seguro reintentar" sería tener dos criterios.
 */
export function classifySendFailure(
  result: Extract<AgentSendResult, { ok: false }>,
): SendOutcome {
  return classifyKapsoSendFailure(result.error, result.status);
}

/**
 * ¿Este mensaje puede FORMAR un turno del agente?
 *
 * SOLO TEXTO. Esta fase no es multimodal: no hay visión, ni transcripción de
 * audio, ni lectura de documentos. Un audio o una foto llegan con
 * `content = null` (jamás con un marcador inventado), así que dejarlos pasar
 * significaría llamar al modelo con la conversación anterior y responder como si
 * el cliente no hubiera mandado nada — o peor, adivinando qué mandó.
 *
 * Se exporta porque desde 5C.2 hay DOS sitios que necesitan esta pregunta: el
 * turno, que la usa como barrera, y la elección del ancla de un lote, que la usa
 * para no anclar en un elemento que el turno iba a descartar. Tener dos copias
 * sería tener dos criterios, y el segundo se enteraría tarde de que cambió el
 * primero.
 *
 * Nota: `location` e `interactive` ni siquiera llegan hasta aquí, porque el
 * pipeline determinístico los atiende antes. El gate cubre el resto.
 */
export function isAgentEligibleContent(message: ProvenanceMessage): boolean {
  // Texto: hace falta que diga algo.
  if (message.contentType === 'text') {
    return message.content !== null && message.content.trim() !== '';
  }
  // Imagen (5C.5): una foto sola es un mensaje completo del cliente —"mirá
  // esto"— y desde esa fase el modelo puede verla. Que no traiga texto no la
  // vacía de contenido; ese era justamente el supuesto que la dejaba fuera.
  //
  // Pero tiene que quedar ALGO que mirar o que leer (29-08-2026). La puerta de
  // comprobantes retira los bytes de un adjunto no autorizado —pone `image` en
  // `null` y deja el mensaje— y con eso el turno se quedaba sin foto y sin
  // texto: el modelo decidía sobre el HISTORIAL solo, sin el mensaje actual.
  // En producción eso mandó el menú a un cliente que acababa de pagar, porque
  // lo último que constaba en su conversación era "quiero pedir".
  //
  // Un turno sin nada del cliente no es un turno: es contestarle a otro
  // mensaje. Y el comprobante ya tiene quien lo atienda.
  if (message.contentType === 'image') {
    const tieneCaption = message.content !== null && message.content.trim() !== '';
    return tieneCaption || message.image != null;
  }
  return false;
}

/** El texto que el cliente escribió en este mensaje, o cadena vacía. */
export function inboundTextOf(message: ProvenanceMessage): string {
  return message.content ?? '';
}

/**
 * Lo que el modelo lee cuando hubo una foto que no se pudo mirar.
 *
 * Es un HECHO del canal, con rol `system`: no es una frase puesta en boca del
 * cliente ni del asistente. Va a las DOS rondas —decidir y redactar— porque las
 * dos se equivocarían igual sin saberlo: una eligiendo capacidad como si el
 * mensaje fuera solo texto, y la otra describiendo de memoria.
 */
export const MEDIA_FAILURE_NOTICE =
  'Evento del canal: el cliente envió una imagen que no se pudo procesar. ' +
  'No afirmes nada sobre su contenido visual.';

export async function runAgentTurn(
  message: ProvenanceMessage,
  deps: AgentTurnDeps,
  burst?: AgentTurnBurst,
): Promise<AgentTurnResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  // El MISMO reloj del run, en milisegundos. El presupuesto multimodal no
  // merece un segundo reloj: es el tiempo de este turno, no otro tiempo.
  const nowMs = (): number => new Date(now()).getTime();

  // 1. Elegibilidad. Antes de la base: un mensaje no elegible no deja rastro.
  const eligibility = evaluateAgentEligibility(message.customerPhone, deps.config);
  if (eligibility !== 'eligible') {
    return { result: 'skipped', reason: eligibility };
  }

  // 2. Datos mínimos.
  if (message.customerPhone === '') {
    return { result: 'skipped', reason: 'missing_phone' };
  }
  if (message.providerMessageId === null) {
    // Sin WAMID no hay clave de idempotencia: se prefiere no responder antes
    // que arriesgar responder dos veces al mismo mensaje.
    return { result: 'skipped', reason: 'missing_message_id' };
  }
  const sourceMessageId = message.providerMessageId;

  // 2b. ¿Aporta este LOTE algo del cliente? Ver `isAgentEligibleContent`.
  //
  // Se mira el burst entero y no solo el ancla, y la diferencia es real: el
  // ancla puede ser un comprobante al que la puerta ya le quitó los bytes
  // mientras el mismo lote trae un "quiero una hamburguesa" que sí hay que
  // contestar. Preguntar solo por el ancla dejaría ese texto sin respuesta.
  //
  // Y al revés: si NADA del lote aporta nada —el caso del comprobante suelto—
  // el turno no corre. Antes corría, y decidía sobre el historial solo: en
  // producción eso le mandó el menú a un cliente que acababa de pagar.
  if (!(burst ?? [message]).some(isAgentEligibleContent)) {
    return { result: 'skipped', reason: 'unsupported_content' };
  }

  // 3. La conversación ya existe: la creó la persistencia del entrante, que
  // corre antes y es fail-closed. Si no está, algo se saltó y no se inventa.
  const conversation = await deps.store.findPauseStateByPhone(message.customerPhone);
  if (conversation === null) {
    return { result: 'skipped', reason: 'no_conversation' };
  }

  // 4. Claim. Es la barrera de idempotencia y va ANTES del modelo: una
  // reentrega de Kapso encuentra el run ya reclamado y no gasta otra llamada.
  const sourceAgentMessageId =
    await deps.runs.findMessageIdByProviderMessageId(sourceMessageId);

  const claim = await deps.runs.claimRun({
    agentConversationId: conversation.conversationId,
    sourceMessageId,
    sourceAgentMessageId,
    model: deps.model.model,
  });

  if (claim.result === 'exists') {
    // Ya sea terminal (`completed`, `failed`, …) o en curso (`processing`,
    // `sending`), aquí se para. La recuperación de runs colgados es una fase
    // aparte: reintentar un `sending` a ciegas duplicaría el mensaje.
    return { result: 'duplicate', runId: claim.runId, status: claim.status };
  }
  const runId = claim.runId;

  // 5. Barrera de pausa. El entrante ya quedó persistido antes de llegar aquí:
  // la pausa impide que hable la IA, nunca que se registre la conversación.
  //
  // La pregunta es si la pausa RIGE ahora, no si la fila dice `paused`: desde
  // 5C.1 el takeover humano vence solo. Una pausa caducada no retiene a nadie,
  // y quien normaliza la fila es `resolveExpiredPause`, antes de llegar aquí.
  if (isPauseActive(conversation, now())) {
    await deps.runs.finishRun({
      runId,
      status: 'skipped_paused',
      completedAt: now(),
      skippedAtBarrier: 'pre_openai', // no se gastó nada
    });
    return { result: 'skipped', reason: 'paused', runId };
  }

  // 6. Ventanas de contexto. UNA lectura de la base, dos proyecciones: decidir
  // y redactar no necesitan lo mismo, y `buildSelectionContext` explica por qué.
  const history = await deps.runs.loadRecentMessages(
    conversation.conversationId,
    contextWindowStart(now()),
    CONTEXT_MAX_MESSAGES,
  );
  // ── 6b. LA PARTE VISUAL DEL BURST (Fase 6D.2F.5C.5) ───────────────────────
  //
  // Se resuelven las imágenes de ESTA entrega, en su orden original. Si el
  // resolver falla, `imageParts` queda vacío y el turno sigue: fail closed
  // significa no ver la foto, nunca fingir que se vio (§10).
  const inboundText = inboundTextOf(message);
  const { parts: imageParts, failures: imageFailures } = await resolveBurstImages(
    burst ?? [message],
    deps,
    runId,
    nowMs,
  );

  // Un mensaje del cliente con foto y caption es UNA sola cosa, y así viaja:
  // un `user` con sus partes. No se parte en dos turnos ni en dos mensajes.
  const inboundParts: AgentModelContentPart[] = [...imageParts];
  if (imageParts.length > 0 && inboundText !== '') {
    inboundParts.push({ type: 'input_text', text: inboundText });
  }
  const inboundMultimodal: AgentModelMessage | null =
    inboundParts.length > 0 ? { role: 'user', content: inboundParts } : null;

  const messages: AgentModelInput[] = [
    { role: 'system', content: deps.systemPrompt },
    // El caption ya está persistido; si va a viajar pegado a su imagen, se
    // quita de la cola del historial para no decirlo dos veces.
    ...buildWorkingContext(history, {
      dropTrailingUserText: inboundMultimodal !== null && inboundText !== '' ? inboundText : null,
    }),
    ...(inboundMultimodal ? [inboundMultimodal] : []),
  ];

  // Aviso de que hubo foto y no se pudo mirar. Ver `MEDIA_FAILURE_NOTICE`.
  if (imageFailures > 0) {
    messages.push({ role: 'system', content: MEDIA_FAILURE_NOTICE });
  }

  const actions = deps.actions ?? [];
  let toolRounds = 0;
  let finalText = '';
  let resolvedModel = deps.model.model;
  /**
   * ¿La acción de este turno produjo un efecto que el cliente VE, ya confirmado
   * por el backend? Lo pone la herramienta desde su resultado real; el core no
   * sabe cuál es ni mira su nombre.
   *
   * Solo sirve para una decisión: si el modelo acaba sin decir nada, ¿el
   * cliente se queda sin respuesta, o ya recibió algo?
   */
  let userVisibleEffectConfirmed = false;

  /**
   * El modelo se calló DESPUÉS de un efecto confirmado.
   *
   * No es un fallo: el cliente ya recibió algo real en su WhatsApp y el propio
   * mensaje del automatismo es la evidencia. No se envía nada, no se fabrica
   * texto y no se persiste un `agent_message` de IA vacío — un mensaje sin
   * contenido en el historial sería peor que no tenerlo.
   */
  const finishSilently = async (): Promise<AgentTurnResult> => {
    await deps.runs.finishRun({
      runId,
      status: 'completed',
      completedAt: now(),
      model: resolvedModel,
      toolRounds,
    });
    return { result: 'completed_silent', runId };
  };

  /**
   * BARRERA PRE-SEND. ¿Sigue activa la conversación AHORA MISMO?
   *
   * La del paso 5 se comprobó antes del modelo. Desde 5C.1 el procesamiento es
   * asíncrono, así que entre aceptar el mensaje y producir un efecto pueden
   * pasar segundos —o minutos, si el turno entró por el recovery— y en ese
   * hueco cabe perfectamente que una persona tome la conversación desde
   * WhatsApp Business App. Un trabajo aceptado no otorga permiso permanente
   * para hablar.
   *
   * Se relee del estado actual porque el takeover se aplica de forma SÍNCRONA
   * en la aceptación del webhook: cuando llega aquí, si ocurrió, ya está escrito.
   *
   * ── Carrera residual, reconocida ────────────────────────────────────────────
   *
   * Entre esta consulta y la llamada HTTP al proveedor quedan milisegundos en
   * los que la pausa podría escribirse. No se cierra en esta fase: haría falta
   * un lock distribuido o un envío condicionado por la base, y ambos son
   * infraestructura considerable para una ventana de milisegundos cuyo peor
   * caso es un mensaje de más — el mismo que ocurre si la persona escribe una
   * décima después. Lo que sí se hace es dejar la comprobación lo más pegada
   * posible al efecto.
   */
  const pausedNow = async (): Promise<boolean> => {
    const current = await deps.store.findPauseStateByPhone(message.customerPhone);
    // Mismo criterio que la barrera del paso 5, y a propósito: si las dos no
    // interpretasen igual una pausa vencida, el turno podría empezar y morir a
    // mitad sin que nadie hubiera tomado el control.
    return isPauseActive(current, now());
  };

  /**
   * Cierre del turno cuando la pausa aparece a mitad.
   *
   * Depende de si el cliente ya vio algo:
   *
   *   · nada visible aún  → `skipped_paused` / `pre_send`. El barrier ya existía
   *     en el esquema de 0014 sin que nadie lo escribiera.
   *   · un efecto ya confirmado (un CTA que salió en una ronda anterior) →
   *     `completed` en silencio. Es el mismo cierre de 5B, y por la misma razón:
   *     decir `skipped` sería mentir cuando el cliente ya tiene el menú.
   *
   * No hay estados nuevos. Lo que se suprime es lo que faltaba por hacer, nunca
   * lo que ya ocurrió.
   */
  const finishForPause = async (): Promise<AgentTurnResult> => {
    if (userVisibleEffectConfirmed) return finishSilently();

    await deps.runs.finishRun({
      runId,
      status: 'skipped_paused',
      completedAt: now(),
      skippedAtBarrier: 'pre_send',
    });
    return { result: 'skipped', reason: 'paused', runId };
  };

  /**
   * Cierre por fallo del modelo. Idéntico en las dos rondas: da igual si el
   * proveedor se cayó decidiendo o redactando, el desenlace es el mismo.
   */
  const finishForModelError = async (
    completion: Extract<AgentModelResult, { ok: false }>,
  ): Promise<AgentTurnResult> => {
    // "El modelo no dijo nada" deja de ser un error cuando este turno ya
    // produjo un efecto confirmado: actuar y callarse es una respuesta completa.
    //
    // La decisión vive AQUÍ y no en el adaptador a propósito: para el
    // transporte, una respuesta sin texto y sin herramientas sigue siendo una
    // anomalía. Si es aceptable o no depende de lo que pasó antes en el turno, y
    // eso solo lo sabe el core.
    if (completion.error === 'empty_response' && userVisibleEffectConfirmed) {
      return finishSilently();
    }

    // El status del HTTP se conserva en el código (429, 503…): distinguir un
    // límite de cuota de una caída del proveedor sin abrir los logs.
    const errorCode =
      completion.error === 'http_error' && completion.status !== undefined
        ? `model.http_error.${completion.status}`
        : `model.${completion.error}`;
    await deps.runs.finishRun({
      runId,
      status: 'failed',
      completedAt: now(),
      errorCode,
      toolRounds,
    });
    // Sin respuesta del modelo NO se persiste ningún mensaje de IA: inventar uno
    // sería escribir en el historial algo que el cliente nunca recibió.
    return { result: 'failed', runId, error: errorCode };
  };

  /**
   * Cierre por selección inválida — FAIL CLOSED.
   *
   * Lo que se protege es concreto: si no consta qué había que hacer, NO se
   * manda texto. La alternativa —dejar hablar al modelo cuando su decisión no
   * se pudo interpretar— es exactamente el camino que produjo el CTA falso: una
   * frase suelta, sin ninguna acción detrás.
   */
  const finishForSelectionFailure = async (
    errorCode: SelectionFailure,
  ): Promise<AgentTurnResult> => {
    await deps.runs.finishRun({
      runId,
      status: 'failed',
      completedAt: now(),
      errorCode,
      toolRounds,
    });
    // Saneado: el código y el run. Nunca el texto del cliente ni lo que el
    // modelo intentó llamar con sus argumentos.
    log.warn('agent_action_selection_invalid', { runId, error: errorCode });
    return { result: 'failed', runId, error: errorCode };
  };

  if (actions.length === 0) {
    // Sin acciones cableadas el modelo solo escribe: el turno se comporta
    // exactamente como antes de que existieran las herramientas.
    const completion: AgentModelResult = await deps.model.complete(messages, {
      maxOutputTokens: deps.maxOutputTokens,
    });
    if (!completion.ok) return finishForModelError(completion);
    resolvedModel = completion.model;
    finalText = completion.text;
  } else {
    // ── 7. RONDA DE SELECCIÓN ────────────────────────────────────────────────
    //
    // No produce texto para el cliente y no puede producirlo: aunque el modelo
    // escriba algo aquí, ese texto no se lee ni se envía. Lo único que sale de
    // esta ronda es UNA decisión.
    //
    // `required` + `parallelToolCalls: false` no son un ajuste fino: convierten
    // "no elegir" y "elegir tres" en respuestas que el proveedor no debería
    // devolver, y lo que devuelva igualmente se rechaza abajo.
    const selection = await deps.model.complete(
      [
        { role: 'system', content: deps.systemPrompt },
        // Vista distinta del MISMO historial. Sin la prosa de los salientes:
        // decidir no necesita saber cómo se redactó antes, y esa prosa es
        // precisamente lo único que se puede imitar.
        ...buildSelectionContext(history, {
          inboundText,
          // La ronda de DECIDIR también ve la foto: sin ella, "¿qué hamburguesa
          // es esta?" no tiene referente y elegir capacidad sería adivinar.
          inboundParts: inboundMultimodal?.content,
        }),
        // Y si NO se pudo mirar, decidir tiene que saberlo tanto como redactar:
        // sin esto, la ronda de decisión trataría un mensaje con foto como si
        // fuera solo texto y elegiría capacidad sobre un mensaje que no es el
        // que llegó.
        ...(imageFailures > 0
          ? [{ role: 'system' as const, content: MEDIA_FAILURE_NOTICE }]
          : []),
      ],
      {
        maxOutputTokens: deps.maxOutputTokens,
        tools: actions.map((a) => a.definition),
        toolChoice: 'required',
        parallelToolCalls: false,
      },
    );

    if (!selection.ok) return finishForModelError(selection);
    // El snapshot real del modelo se conserva desde la PRIMERA respuesta buena:
    // si el turno acaba en silencio, `agent_runs.model` sigue diciendo con qué
    // se ejecutó.
    resolvedModel = selection.model;
    // Hubo ronda de decisión. Se cuenta ANTES de validarla: aunque la decisión
    // resulte inválida, la ronda existió y se pagó.
    toolRounds = SELECTION_ROUND;

    // ── EXACTAMENTE UNA ──────────────────────────────────────────────────────
    const calls = selection.toolCalls ?? [];
    if (calls.length !== 1) {
      return finishForSelectionFailure(
        calls.length === 0 ? 'selection.no_action' : 'selection.multiple_actions',
      );
    }
    const call = calls[0];

    const action = findAgentTool(call.name, actions);
    if (action === null) return finishForSelectionFailure('selection.unknown_action');
    // Ninguna acción recibe argumentos. Que lleguen significa que el modelo
    // entendió mal, y aquí no hay bucle en el que recuperarse: se para.
    if (!hasNoArguments(call.arguments)) {
      return finishForSelectionFailure('selection.invalid_arguments');
    }

    // La decisión, registrada. Es lo que faltaba: antes, "contestar hablando"
    // no dejaba rastro porque no era una elección, era el hueco por el que se
    // caía el turno.
    log.info('agent_action_selected', { runId, action: call.name, round: SELECTION_ROUND });

    // ── 8. EJECUCIÓN ─────────────────────────────────────────────────────────
    //
    // Una acción sin `execute` no ejecuta nada y no aporta nada a la redacción:
    // seleccionarla solo declara que este turno no necesita ninguna acción de
    // negocio. El core no pregunta cuál es, pregunta si hay algo que ejecutar.
    if (typeof action.execute === 'function') {
      // BARRERA PRE-SEND (A): antes de una acción con efecto visible. La
      // pregunta se hace por la DECLARACIÓN de la herramienta, no por su nombre
      // — el core no sabe cuál es cuál.
      if (action.producesUserVisibleEffect === true && (await pausedNow())) {
        return finishForPause();
      }

      const executed = await executeToolCall(call, actions, {
        customerPhone: message.customerPhone,
        sourceMessageId,
        phoneNumberId: message.providerPhoneNumberId,
        // El entrante REAL del turno. El paso 2b ya garantizó que es texto no
        // vacío. Va aquí, y no como argumento de la acción, para que ninguna
        // decisión de política pueda salir de lo que el modelo escriba.
        // Con una foto sin caption esto es cadena vacía, y debe serlo: no se
        // fabrica texto del cliente para que una herramienta tenga qué leer.
        inboundText,
      });
      userVisibleEffectConfirmed = executed.userVisibleEffectConfirmed;
      // Observabilidad saneada: NOMBRE de la acción y si se ejecutó. Nunca los
      // argumentos ni el resultado — ahí viven la URL y el token.
      log.info('agent_tool_call', {
        runId,
        tool: executed.name,
        ok: executed.ok,
        round: SELECTION_ROUND,
      });

      // ── El efecto ES la respuesta ──────────────────────────────────────────
      //
      // Aquí está el fondo de 5B.1. Cuando la acción declara que su efecto
      // confirmado completa el turno, no se le pide texto al modelo: el cliente
      // ya recibió el mensaje de verdad —con su imagen, su copy y su botón— y
      // cualquier frase añadida solo podría repetirlo… o inventarlo.
      //
      // Por eso el CTA falso deja de ser representable: la frase que afirma el
      // envío no puede existir sin el envío, porque cuando el envío ocurre no se
      // escribe ninguna frase. Y si NO se confirma, esto no se activa y el turno
      // pasa a redactar con el fallo delante — que es justo cuando hace falta
      // que el modelo hable.
      if (action.effectCompletesTurn === true && executed.userVisibleEffectConfirmed) {
        return finishSilently();
      }

      // La llamada del modelo se devuelve tal cual junto a su resultado: la
      // Responses API necesita ver las dos mitades para casar el `call_id`.
      messages.push(
        { type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: executed.callId, output: executed.output },
      );
    }

    // ── 9. RONDA DE REDACCIÓN ────────────────────────────────────────────────
    //
    // Contexto NORMAL —con la prosa, que aquí sí sirve: da continuidad y tono, y
    // resuelve las referencias que la ronda de decisión no necesitaba— más el
    // resultado de la acción, si lo hubo.
    //
    // SIN herramientas: la decisión ya se tomó y no se revisa. Que el modelo no
    // pueda llamar a nada en esta ronda es lo que impide que una consulta
    // puntual acabe mandando el menú entero de rebote.
    const reply = await deps.model.complete(messages, {
      maxOutputTokens: deps.maxOutputTokens,
      toolChoice: 'none',
    });
    if (!reply.ok) return finishForModelError(reply);
    resolvedModel = reply.model;
    // Si el proveedor devolviera llamadas pese a `none`, se ignoran: en esta
    // ronda no se ejecuta nada. Lo único que se toma es el texto.
    finalText = reply.text;
  }

  // Red de seguridad: el adaptador ya convierte "sin texto y sin herramientas"
  // en `empty_response`, así que esto no debería ocurrir. Si algún día ocurre,
  // que sea un run cerrado y no un mensaje en blanco en el WhatsApp de alguien.
  // La misma regla del silencio se aplica aquí, para que las dos puertas de
  // "texto vacío" no puedan discrepar.
  if (finalText.trim() === '') {
    if (userVisibleEffectConfirmed) {
      return finishSilently();
    }
    await deps.runs.finishRun({
      runId,
      status: 'failed',
      completedAt: now(),
      errorCode: 'model.empty_response',
      toolRounds,
    });
    return { result: 'failed', runId, error: 'model.empty_response' };
  }

  // BARRERA PRE-SEND (B): el texto final. Va lo más TARDE posible —después de
  // decidir que hay algo que enviar y antes de marcar `sending`— para que la
  // ventana entre comprobar y enviar sea la mínima posible.
  if (await pausedNow()) {
    return finishForPause();
  }

  // 10. `sending` antes del envío: si la invocación muere justo después, el run
  // queda en un estado que dice "pudo haber salido", no en uno que invite a
  // reenviar.
  await deps.runs.markRunSending(runId);

  // 11. Envío.
  const sent = await deps.send.sendText(
    message.customerPhone,
    finalText,
    message.providerPhoneNumberId,
  );

  if (!sent.ok) {
    const status = classifySendFailure(sent);
    const errorCode = `send.${sent.error}`;
    await deps.runs.finishRun({ runId, status, completedAt: now(), errorCode, toolRounds });
    // En `send_unknown` tampoco se persiste el mensaje de IA: no consta que el
    // cliente lo recibiera. Si de verdad salió, llegará su `whatsapp.message.sent`
    // con origin=cloud_api y se reconciliará cuando exista esa microfase.
    return status === 'failed'
      ? { result: 'failed', runId, error: errorCode }
      : { result: 'send_unknown', runId, error: errorCode };
  }

  // ── A partir de AQUÍ Kapso YA aceptó el envío y devolvió un WAMID real ────
  //
  // El mensaje está en el teléfono del cliente. Todo lo que sigue es
  // contabilidad nuestra, y ningún fallo de contabilidad puede desembocar en un
  // segundo envío. Por eso la persistencia va dentro de un try: si la base
  // falla, el run se cierra en un estado TERMINAL (nunca se queda en `sending`
  // ni vuelve a `processing`), y una reentrega chocará con el claim y parará en
  // `duplicate`.
  const messageTimestamp = now();
  try {
    await deps.store.insertMessage({
      agentConversationId: conversation.conversationId,
      providerMessageId: sent.wamid,
      providerConversationId: message.providerConversationId,
      direction: 'outbound',
      role: 'assistant',
      actor: 'ai',
      content: finalText,
      contentType: 'text',
      metadata: null,
      messageTimestamp,
    });
    await deps.runs.touchAiMessageAt(conversation.conversationId, messageTimestamp);
  } catch {
    // El envío SÍ ocurrió; lo que no consta es nuestro registro. `send_unknown`
    // es el único terminal que el esquema actual admite sin mentir: describe
    // "no hay certeza del desenlace", y aquí la incertidumbre es sobre la
    // PERSISTENCIA local, no sobre el envío. Se distingue por el error_code.
    //
    // El WAMID se pierde para la base —`agent_runs` no tiene columna para un
    // wamid saliente y `source_message_id` es el del ENTRANTE— pero no se
    // pierde del todo: Kapso emitirá su `whatsapp.message.sent` con
    // origin=cloud_api y ese evento permitirá reconciliar cuando exista la
    // microfase de persistencia `actor=automation`.
    await deps.runs.finishRun({
      runId,
      status: 'send_unknown',
      completedAt: now(),
      errorCode: 'persist.ai_message_failed',
      model: resolvedModel,
      toolRounds,
    });
    return { result: 'send_unknown', runId, error: 'persist.ai_message_failed' };
  }

  const responseMessageId = await deps.runs.findMessageIdByProviderMessageId(sent.wamid);

  await deps.runs.finishRun({
    runId,
    status: 'completed',
    completedAt: now(),
    responseMessageId,
    model: resolvedModel,
    toolRounds,
  });

  return { result: 'replied', runId };
}
