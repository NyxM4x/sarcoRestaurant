import 'server-only';
import { log } from '@/lib/log';
import { buildHandoffNotice } from './handoff-notice';
import { createAlertRunnerDeps, enqueueAlert } from './outbox-store';
import { trySendNow } from './outbox-runner';

/**
 * Aviso al equipo de que una conversación necesita a una persona — server-only.
 *
 * Calcado de `./delivery-notice-service`: mismo transporte de Telegram, mismo
 * best-effort, misma disciplina de logs. Lo único que cambia es el destinatario
 * lógico —quien atiende clientes, no quien reparte— y por eso puede ir a otro
 * chat.
 *
 * ── Nunca lanza, y nunca bloquea ────────────────────────────────────────────
 *
 * Quien llama a esto ya ha pausado al agente: el cliente YA está a la espera de
 * una persona, con o sin aviso. Que Telegram falle no puede deshacer eso ni
 * tumbar el turno. Sin credenciales no es un error: es una función apagada.
 *
 * ── Pero un fallo de Telegram YA NO pierde el aviso (0028) ──────────────────
 *
 * Hasta ahora "best-effort" significaba literalmente que el aviso se perdía: un
 * `log.warn` y nada más, con el agente pausado dos horas y el cliente esperando
 * a alguien a quien nadie avisó. Ahora la alerta se ESCRIBE antes de intentar
 * mandarla, y el worker reintenta lo que no salió. Best-effort sigue siendo
 * cierto para la LATENCIA; ya no para la entrega.
 *
 * ── Por qué su propio chat ──────────────────────────────────────────────────
 *
 * `TELEGRAM_HANDOFF_CHAT_ID` permite separar los reclamos del grupo de reparto,
 * donde serían ruido para quien está montado en una moto. Con fallback al chat
 * de siempre: exigir un grupo nuevo antes de tenerlo creado apagaría la función
 * entera, y un aviso en el grupo equivocado sirve más que ninguno.
 */
export interface NotifyHandoffInput {
  /** Dígitos normalizados del cliente. */
  customerPhone: string;
  /** Motivo canónico de la pausa. */
  reason: string;
  /** Último mensaje del cliente, si lo hubo. */
  lastMessage: string | null;
}

export async function notifyHandoff(input: NotifyHandoffInput): Promise<void> {
  try {
    // ── 1. ENCOLAR — esto es lo que no se puede perder ────────────────────
    //
    // Antes se mandaba a Telegram y punto: si fallaba, quedaba un `log.warn` y
    // nada más. El agente seguía pausado dos horas, el cliente esperando a una
    // persona, y nadie se enteraba nunca.
    //
    // La clave del outbox es `(kind, target_ref)`, y aquí el destino es el
    // TELÉFONO: dos detecciones sobre el mismo cliente producen una sola
    // alerta, que es exactamente lo que se quiere — el equipo no necesita que
    // le repitan que ese número necesita ayuda.
    const alertId = await enqueueAlert(
      'handoff_notice',
      input.customerPhone,
      buildHandoffNotice(input),
    );

    // `null` = ya estaba encolada (o el outbox no está disponible). En el
    // primer caso no hay nada que hacer; en el segundo ya se registró.
    if (alertId === null) return;

    // ── 2. MANDARLA YA — latencia, no durabilidad ─────────────────────────
    //
    // La fila ya está escrita, así que esto solo adelanta el aviso. Si falla,
    // si muere a mitad o si Telegram está caído, la fila sigue agendada y el
    // worker la recoge con backoff.
    const resultado = await trySendNow(alertId, createAlertRunnerDeps());

    // El motivo hace el log accionable —dice si el filtro está gritando de
    // más—. El texto enviado NO se registra: lleva teléfono y lo que escribió
    // el cliente.
    if (resultado === 'sent') log.info('handoff_notice_sent', { reason: input.reason });
    else log.info('handoff_notice_queued', { reason: input.reason, outcome: resultado });
  } catch (error) {
    // Jamás propagar: el cliente ya está esperando a una persona.
    log.error('handoff_notice_error', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}
