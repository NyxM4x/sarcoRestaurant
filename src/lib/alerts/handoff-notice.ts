/**
 * Aviso de "aquí hace falta una persona" — módulo PURO.
 *
 * Construye el texto que se manda por Telegram cuando el agente deja de
 * atender a un cliente y hay que entrar a mano. Sin red, sin Supabase.
 *
 * ── Por qué este mensaje SÍ lleva el teléfono y lo que escribió el cliente ──
 *
 * Mismo criterio que `./delivery-notice`, y por la misma razón: el destinatario
 * es el equipo del negocio en su grupo privado, y sin saber a quién escribir ni
 * qué pasó no puede atender a nadie. Un aviso que dijera "hay un cliente
 * enfadado" y nada más obligaría a abrir WhatsApp y buscar a ciegas, y eso, en
 * plena hora punta, es un aviso que no se atiende.
 *
 * Es lo contrario de `./alert-message`, que construye alertas TÉCNICAS y tiene
 * prohibido incluir datos personales: aquellas van a un canal de incidencias
 * donde el teléfono no ayuda a resolver nada.
 *
 * ── Lo que NUNCA lleva ──────────────────────────────────────────────────────
 *
 * Ni el prompt, ni nombres de herramientas, ni la URL del menú con su token de
 * sesión, ni WAMIDs, ni identificadores internos, ni nada de OpenAI. Quien lee
 * esto necesita atender a un cliente, no depurar el sistema.
 */

/** Por qué se derivó, en el vocabulario de quien va a atender. */
export const HANDOFF_CATEGORY_LABELS: Record<string, string> = {
  handoff_requested: 'El cliente necesita hablar con una persona',
  handoff_menu_loop: 'No consigue hacer su pedido',
  payment_reviewed: 'Se acaba de revisar su comprobante',
};

/**
 * Categoría desconocida → texto genérico, nunca el código crudo.
 *
 * Mismo fail-closed que `alert-message`: un motivo nuevo que nadie tradujo debe
 * seguir avisando, aunque sea sin detalle. Callarse porque falta una etiqueta
 * sería perder justo el aviso que nadie previó.
 */
export function handoffCategoryLabel(reason: string): string {
  return HANDOFF_CATEGORY_LABELS[reason] ?? 'La conversación necesita a una persona';
}

/** Cuánto del mensaje del cliente se copia en el aviso. */
export const HANDOFF_EXCERPT_MAX = 200;

/**
 * Recorta el mensaje del cliente.
 *
 * Va entero salvo que sea largo: el aviso tiene que poder leerse de un vistazo
 * en el teléfono, y quien lo atienda va a abrir el chat de todos modos.
 */
export function handoffExcerpt(text: string | null): string | null {
  const limpio = (text ?? '').replace(/\s+/g, ' ').trim();
  if (limpio === '') return null;
  return limpio.length <= HANDOFF_EXCERPT_MAX
    ? limpio
    : `${limpio.slice(0, HANDOFF_EXCERPT_MAX).trimEnd()}…`;
}

export interface HandoffNoticeInput {
  /** Dígitos normalizados; se muestran tal cual para poder escribir. */
  customerPhone: string;
  /** Motivo canónico de la pausa. */
  reason: string;
  /** Último mensaje del cliente, si lo hubo. */
  lastMessage: string | null;
}

/**
 * Texto del aviso.
 *
 * Cierra diciendo qué hacer —responder desde WhatsApp Business App—, y no solo
 * qué pasó: un aviso que no dice cuál es el siguiente paso se queda sin
 * atender aunque se lea.
 */
export function buildHandoffNotice(input: HandoffNoticeInput): string {
  const lineas = [
    '🙋 Atención humana — Don Zarco',
    '',
    `Motivo: ${handoffCategoryLabel(input.reason)}`,
    `Teléfono: ${input.customerPhone}`,
    `Abrir chat: https://wa.me/${input.customerPhone}`,
  ];

  const extracto = handoffExcerpt(input.lastMessage);
  if (extracto !== null) {
    lineas.push('', 'Último mensaje:', `"${extracto}"`);
  }

  lineas.push('', 'El agente quedó en pausa. Responde desde WhatsApp Business App.');
  return lineas.join('\n');
}
