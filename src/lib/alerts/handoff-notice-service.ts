import 'server-only';
import { getServerEnv } from '@/lib/env/env';
import { log } from '@/lib/log';
import { buildHandoffNotice } from './handoff-notice';
import { createTelegramAlertSender } from './telegram';

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
    const env = getServerEnv();
    const chatId = env.TELEGRAM_HANDOFF_CHAT_ID || env.TELEGRAM_CHAT_ID;
    if (!env.TELEGRAM_BOT_TOKEN || !chatId) {
      // Sin credenciales no hay canal: no es un error, es una función apagada.
      return;
    }

    const sender = createTelegramAlertSender({ botToken: env.TELEGRAM_BOT_TOKEN, chatId });
    const outcome = await sender.send(buildHandoffNotice(input));

    // El motivo hace el log accionable —dice si el filtro está gritando de
    // más—. El texto enviado NO se registra: lleva teléfono y lo que escribió
    // el cliente.
    if (outcome.kind === 'sent') {
      log.info('handoff_notice_sent', { reason: input.reason });
    } else {
      log.warn('handoff_notice_send_failed', { reason: input.reason, outcome: outcome.kind });
    }
  } catch (error) {
    // Jamás propagar: el cliente ya está esperando a una persona.
    log.error('handoff_notice_error', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}
