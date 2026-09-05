import 'server-only';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import { getServerEnv } from '@/lib/env/env';
import { getKapsoClient } from '@/lib/kapso/client';
import { menuCtaBodyText } from '@/lib/kapso/messages';
import { createMenuDispatchDeps } from '@/lib/kapso/send-menu-cta';
import { createMenuRepository } from '@/lib/menu/repository';
import { categoryLabel, productDescription } from '@/lib/menu/catalog';
import { dispatchMenu, type MenuAutomationMemoryPort } from '@/lib/menu/dispatch';
import { createGetMenuItemsTool, createSendMenuTool } from './tools/menu-tools';
// El pedido vivo del cliente y la regla que dice si todavía se puede rearmar:
// las MISMAS que usa la vía determinística, no una segunda copia.
import { lookupCustomerState } from '@/lib/webhook/customer-state-service';
import { isReplaceableOrder } from '@/lib/webhook/default-reply';
import { createAnswerDirectlyAction } from './tools/answer-directly';
import { createRequestHumanAction } from './tools/request-human';
import { createHandoffPort } from './handoff/service';
import type { AgentTool } from './tools/registry';
import { createAgentStore } from './memory/repository';
import { handleHumanTakeover, humanTakeoverPauseMinutes } from './control/takeover';
import { resolveExpiredPause } from './control/pause-expiry';
import { resumeAgentConversation } from './control/resume';
import { persistCustomerInbound } from './memory/persist-inbound';
import { runAgentTurn } from './core/run';
import { pickTurnModel, turnHasImage } from './core/model-choice';
import { pauseAgentForHandoff } from './control/handoff-pause';
import { PAUSE_REASON_PAYMENT_REVIEWED } from './core/types';
import { createOpenAiModel, OPENAI_DEFAULT_MODEL } from './openai/adapter';
import { createKapsoMediaResolver } from '@/lib/kapso/media-resolver';
import { DON_ZARCO_MAX_OUTPUT_TOKENS, DON_ZARCO_SYSTEM_PROMPT } from './business/prompt';
import {
  parseAccessMode,
  parseTestPhones,
  type AgentAccessMode,
  type AgentEligibilityConfig,
} from './core/eligibility';
import type { AgentChannelPort, AgentSendPort, ResumeAgentResult } from './core/types';

/**
 * Cableado real del Agent Core (server-only, Fase 6D.2F.2B).
 *
 * Es el ÚNICO punto donde el core toca Supabase. El webhook recibe este puerto
 * inyectado y, si no se inyecta, conserva exactamente el comportamiento previo:
 * ese es el interruptor de apagado de toda la fase.
 *
 * No hay OpenAI, ni tools, ni envíos. Solo persistencia y control de pausa.
 *
 * REQUISITO OPERATIVO: la migración 0014 debe estar aplicada antes de desplegar
 * con este puerto conectado. Sin las tablas `agent_*`, tanto el takeover humano
 * como la persistencia del historial entrante fallarían y el evento quedaría
 * `failed` (reintentable) en vez de procesarse.
 */
export function createAgentChannel(): AgentChannelPort {
  const store = createAgentStore(getSupabaseAdmin());

  return {
    handleHumanTakeover: (message) =>
      handleHumanTakeover(
        message,
        store,
        undefined,
        // El plazo es configuración de negocio; el dominio no lee el entorno.
        humanTakeoverPauseMinutes(getServerEnv().HUMAN_TAKEOVER_PAUSE_MINUTES),
      ),
    persistCustomerInbound: (message) => persistCustomerInbound(message, store),
    runAgentTurn: async (message, burst) => {
      // Una pausa por takeover VENCIDA se normaliza aquí, justo antes del turno.
      //
      // Va fuera del core a propósito: el core decide si la pausa lo retiene
      // —y `isPauseActive` ya trata una pausa caducada como inactiva—, mientras
      // que dejar la FILA coherente y con su evento de auditoría es trabajo del
      // plano de control.
      //
      // Y por eso un fallo aquí no puede impedir el turno: es contabilidad. El
      // cliente no se queda sin respuesta porque no hayamos podido escribir el
      // evento; simplemente la fila seguirá diciendo `paused` hasta el próximo
      // mensaje, y el agente contestará igual.
      try {
        await resolveExpiredPause(message.customerPhone, store);
      } catch {
        // Sin `error.message`: puede traer detalle técnico de Supabase.
        log.warn('agent.pause_expiry_failed');
      }

      return runAgentTurn(
        message,
        {
          store,
          runs: store,
          // El modelo se elige POR TURNO: el barato de texto para una
          // conversación, el barato de imagen cuando el cliente mandó una foto.
          // Ver `pickTurnModel` para por qué no puede ser uno fijo.
          model: createOpenAiModel({
            apiKey: readAgentEnv().apiKey ?? '',
            model: pickTurnModel({
              hasImage: turnHasImage(burst),
              textModel: readAgentEnv().model,
              visionModel: readAgentEnv().visionModel,
            }),
          }),
          send: createKapsoSendPort(),
          config: readAgentEligibility(),
          // El prompt viene del Business Adapter: el core no sabe de Don Zarco.
          systemPrompt: DON_ZARCO_SYSTEM_PROMPT,
          maxOutputTokens: DON_ZARCO_MAX_OUTPUT_TOKENS,
          actions: createAgentActions(),
          // Vision (5C.5). Su ausencia sería el interruptor de apagado: sin
          // resolver, el turno no mira ninguna foto y avisa de que no pudo.
          media: createKapsoMediaResolver(),
        },
        burst,
      );
    },
  };
}

/**
 * CATÁLOGO DE ACCIONES de Don Zarco (Fases 6D.2F.5B y 6D.2F.5B.1).
 *
 * El modelo elige exactamente UNA por turno. Qué acciones existen es decisión
 * del negocio y por eso vive aquí: el core solo sabe que hay una lista, que hay
 * que elegir un elemento y qué declara cada uno.
 *
 * El orden es el de la decisión, de la acción más consecuente a la menos:
 *
 *   send_menu        el cliente quiere ver lo que hay → se lo mandamos.
 *   get_menu_items   preguntó por algo concreto → lo consultamos y contestamos.
 *   answer_directly  no hace falta ninguna acción → contestamos hablando.
 *
 * `get_menu_items` lee la MISMA fuente que el resto del sistema (`menu_items`
 * vía `createMenuRepository`): el agente no tiene un catálogo propio que pueda
 * desincronizarse de los precios reales.
 *
 * `send_menu` delega en el Shared Menu Dispatch con las MISMAS dependencias que
 * usa la ruta determinística, así que hereda claim, ledger y memoria sin
 * reimplementar nada.
 *
 * `answer_directly` no ejecuta nada: existe para que "contestar hablando" sea
 * una decisión con nombre y no el hueco por el que se cae el turno.
 */
function createAgentActions(): AgentTool[] {
  const menu = createMenuRepository(getSupabaseAdmin());

  return [
    createSendMenuTool(
      {
        // La detección del atasco YA NO cuelga de aquí. Colgaba, y por eso solo
        // veía al cliente que pedía el menú una y otra vez: el que se traba
        // preguntando por el envío no aparecía nunca. Ahora corre una vez por
        // entrega en el webhook y cuenta mensajes, no menús. Ver
        // `handoff/stuck-customer.ts`.
        dispatch: (input) => dispatchMenu(input, createMenuDispatchDeps()),
      },
      {
        /**
         * El pedido vivo del cliente (05-09-2026).
         *
         * Se lee con `lookupCustomerState`, el MISMO puerto que usa la vía
         * determinística, y se decide con `isReplaceableOrder`, la MISMA regla.
         * Esta tool no vuelve a preguntarse qué pedido se puede rearmar: solo
         * pregunta si el que hay lo es.
         *
         * Sin esto, el enlace que salía por aquí abría un pedido en blanco
         * aunque el cliente ya tuviera el suyo — y así nació el #27, con su
         * segunda comanda y su segundo envío.
         */
        async findReplaceable(customerPhone: string) {
          const estado = await lookupCustomerState(customerPhone);
          const pedido = estado?.openOrder ?? null;
          if (pedido === null || !isReplaceableOrder(pedido)) return null;
          return {
            orderId: pedido.orderId,
            orderNumber: pedido.orderNumber,
            totalAmount: pedido.totalAmount,
            isCash: pedido.paymentMethod === 'cash',
          };
        },
      },
    ),
    createGetMenuItemsTool({
      async listForModel() {
        const items = await menu.listActive();
        // Proyección MÍNIMA: se descartan id, code, is_active, sort_order y
        // timestamps. Lo que no se entrega no se puede repetir por WhatsApp.
        return items.map((item) => {
          const description = productDescription(item.code);
          return {
            name: item.name,
            price: Number(item.price),
            category: categoryLabel(item.category),
            ...(description === null ? {} : { description }),
          };
        });
      },
    }),
    createAnswerDirectlyAction(),
    // Va la última del catálogo, no porque importe menos: es la que se elige
    // cuando ninguna de las otras tres sirve, y el orden documentado va de la
    // acción más consecuente a la que no hace nada. Derivar es lo que se hace
    // cuando ya no hay nada que contestar.
    createRequestHumanAction(createHandoffPort()),
  ];
}

/**
 * Minutos que calla el agente tras decidirse un comprobante.
 *
 * Cubre con holgura preparación y reparto de un pedido. No es indefinida a
 * propósito: hoy el panel no tiene ninguna pantalla para reanudar, y un cliente
 * que vuelve la semana siguiente no puede encontrarse la conversación muerta.
 */
export const PAYMENT_REVIEW_PAUSE_MINUTES = 180;

/**
 * Calla al agente después de que un operador acepte o rechace un comprobante.
 *
 * Ese aviso abre una conversación sobre el pago —sobre todo un rechazo, que el
 * cliente va a querer discutir—, y un agente contestando en medio "atendemos de
 * seis de la tarde a cuatro" le hace creer que su pedido se pasó por alto.
 *
 * Best-effort y server-only: nunca lanza. La decisión del pago ya está firme
 * cuando esto corre, y una pausa que falle no puede tocarla.
 */
export async function pauseAgentAfterPaymentReview(customerPhone: string): Promise<void> {
  try {
    await pauseAgentForHandoff(
      {
        customerPhone,
        reason: PAUSE_REASON_PAYMENT_REVIEWED,
        // `dashboard`: la decisión la tomó una persona desde el panel, aunque
        // la pausa la escriba el sistema. El historial debe poder decir de
        // dónde vino.
        source: 'dashboard',
        // No nace de un mensaje del cliente: no hay WAMID que usar como clave.
        sourceMessageId: null,
        minutes: PAYMENT_REVIEW_PAUSE_MINUTES,
        trigger: 'payment_review',
      },
      createAgentStore(getSupabaseAdmin()),
    );
  } catch {
    // Sin `error.message`: puede traer detalle técnico de Supabase.
    log.warn('agent.payment_review_pause_failed');
  }
}

/** Configuración del agente leída del entorno. Nunca se registra ni se expone. */
function readAgentEnv(): {
  enabled: boolean;
  accessMode: AgentAccessMode;
  testPhones: readonly string[];
  apiKey: string | null;
  model: string;
  /** Modelo para los turnos con foto. `null` = el mismo de texto. */
  visionModel: string | null;
} {
  const env = getServerEnv();
  return {
    // Fail-closed: solo la cadena exacta 'true' enciende el agente. Ausente,
    // vacía, 'TRUE', '1' o cualquier otra cosa lo dejan apagado.
    enabled: env.AI_ENABLED === 'true',
    // A quién se atiende. Mismo criterio: solo 'all' abre, todo lo demás cierra.
    accessMode: parseAccessMode(env.AI_ACCESS_MODE),
    // `AI_TEST_PHONES` manda; `AI_TEST_PHONE` es el respaldo de la forma
    // anterior. El `??` basta para distinguirlas porque el esquema del entorno
    // ya convierte la cadena vacía en `undefined`: una variable presente pero
    // vacía es, en todo el proyecto, lo mismo que ausente.
    //
    // Se lee SIEMPRE, también en modo `all`, donde no se consulta: así volver a
    // `allowlist` es cambiar una palabra y no reconstruir la lista de memoria.
    testPhones: parseTestPhones(env.AI_TEST_PHONES ?? env.AI_TEST_PHONE),
    apiKey: env.OPENAI_API_KEY ?? null,
    model: env.OPENAI_MODEL ?? OPENAI_DEFAULT_MODEL,
    visionModel: env.AI_VISION_MODEL ?? null,
  };
}

function readAgentEligibility(): AgentEligibilityConfig {
  const cfg = readAgentEnv();
  return {
    enabled: cfg.enabled,
    accessMode: cfg.accessMode,
    testPhones: cfg.testPhones,
    hasApiKey: cfg.apiKey !== null && cfg.apiKey !== '',
  };
}

/**
 * Puerto de envío del agente: solo texto, por el mismo número por el que llegó
 * el mensaje. Es todo lo que el core puede hacer hacia fuera — no tiene acceso
 * a QR, ubicación, CTA del menú ni notificaciones de pedido.
 */
function createKapsoSendPort(): AgentSendPort {
  return {
    async sendText(customerPhone, text, phoneNumberId) {
      const result = await getKapsoClient().sendText(customerPhone, text, {
        phoneNumberId: phoneNumberId ?? undefined,
      });
      return result.ok
        ? { ok: true, wamid: result.wamid }
        : { ok: false, error: result.error, status: result.status };
    },
  };
}

/**
 * Memoria conversacional de los automatismos (Fase 6D.2F.5A).
 *
 * Cuando el backend manda el menú, el cliente VE un mensaje. Sin esto, el
 * agente miraba el historial y encontraba dos mensajes del cliente seguidos,
 * como si en medio no hubiera pasado nada — y podía ofrecer el menú que se
 * acababa de enviar.
 *
 * Se persiste el texto REAL del CTA, no un marcador interno: el principio 4 de
 * 0014 dice que `agent_messages` solo contiene mensajes reales del canal. La
 * URL y el token NO se guardan; el enlace vive en el botón, no en la memoria.
 */
export function createMenuAutomationMemory(): MenuAutomationMemoryPort {
  const store = createAgentStore(getSupabaseAdmin());

  return {
    async recordMenuSent({ customerPhone, providerMessageId, phoneNumberId, sentAt, reason }) {
      const conversation = await store.upsertConversation({
        customerPhone,
        providerConversationId: null,
        providerPhoneNumberId: phoneNumberId,
      });

      await store.insertMessage({
        agentConversationId: conversation.id,
        providerMessageId,
        providerConversationId: null,
        direction: 'outbound',
        role: 'assistant',
        actor: 'automation',
        // El texto REAL que vio el cliente, no la variante de saludo. Desde que
        // el copy cambia según el motivo, guardar siempre la constante haría
        // que el historial contara una conversación que nunca ocurrió.
        content: menuCtaBodyText(reason),
        contentType: 'interactive',
        metadata: { action: 'send_menu', resource_type: 'menu' },
        messageTimestamp: sentAt,
      });
    },
  };
}

/**
 * Resume real de una conversación pausada (server-only).
 *
 * Vía LEGÍTIMA y auditable para devolver el control al agente: deja un
 * `agent_control_events` con `action='resume'`. Sustituye al UPDATE manual en
 * Supabase, que no dejaría rastro de quién ni cuándo.
 *
 * `customerPhone` debe llegar ya normalizado a dígitos.
 */
export function resumeAgentConversationByPhone(
  customerPhone: string,
): Promise<ResumeAgentResult> {
  return resumeAgentConversation(customerPhone, createAgentStore(getSupabaseAdmin()));
}
