import { describe, expect, it } from 'vitest';
import {
  decideDefaultReply,
  type CustomerStateSnapshot,
  type OpenOrderSnapshot,
} from './default-reply';
import { readCashDecisionButton } from './cash-confirm-button';
import {
  CASH_CANCEL_BUTTON_TITLE,
  CASH_CONFIRM_BUTTON_TITLE,
  REPLY_BUTTON_TITLE_MAX,
  buildReplyButtonsPayload,
  cashDecisionButtons,
} from '@/lib/kapso/messages';
import { buildCashPaymentText } from '@/lib/orders/notifications/notify-text';

/**
 * EL PEDIDO EN EFECTIVO SE DECIDE CON DOS BOTONES (13-09-2026).
 *
 * El caso que lo trae es el #47: el cliente aceptó —"ya esta bien mandamelo"—,
 * el detector de palabras no lo reconoció, y el pedido acabó en una derivación
 * a una persona con la comida sin cocinar.
 *
 * Se recorre la cadena entera con los mismos datos: lo que se manda, lo que
 * vuelve cuando el cliente toca, y qué recibe si en vez de tocar escribe.
 */

const ORDEN = 'ORD-260913-047';

function pedido(over: Partial<OpenOrderSnapshot> = {}): OpenOrderSnapshot {
  return {
    orderId: 'order-uuid-47',
    orderNumber: ORDEN,
    status: 'confirmed',
    totalAmount: 70,
    // Un pedido en efectivo NUNCA espera comprobante: `paymentGateOf` le da
    // `not_required`. Ponerle `no_proof` aquí lo mandaría a la rama del
    // recordatorio del pago, que es una que este cliente no puede pisar.
    payment: 'not_required',
    proofReceived: false,
    paymentMethod: 'cash',
    awaitingCashConfirm: true,
    ...over,
  };
}

function estado(over: Partial<CustomerStateSnapshot> = {}): CustomerStateSnapshot {
  return {
    paused: false,
    openOrder: pedido(),
    proofRemindedRecently: false,
    ...over,
  };
}

/** Un mensaje entrante de WhatsApp con un botón pulsado. */
const toque = (id: string) => ({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id, title: 'lo que sea' } },
});

/** El mensaje base que llega al decisor cuando el cliente ESCRIBE. */
const ESCRIBE = {
  isBatchAnchor: true,
  menuAlreadySent: false,
  explicitIntent: false,
} as const;

// ── Lo que sale ─────────────────────────────────────────────────────────────

describe('el mensaje que se manda', () => {
  it('los dos botones llevan el número de pedido dentro del id', () => {
    expect(cashDecisionButtons(ORDEN)).toEqual([
      { id: `cash_confirm:${ORDEN}`, title: CASH_CONFIRM_BUTTON_TITLE },
      { id: `cash_cancel:${ORDEN}`, title: CASH_CANCEL_BUTTON_TITLE },
    ]);
  });

  it('los títulos caben en el límite de WhatsApp', () => {
    // 20 caracteres. Pasarse no da error al construir el payload: lo rechaza la
    // API, y entonces el cliente no recibe NADA.
    for (const boton of cashDecisionButtons(ORDEN)) {
      expect(boton.title.length, boton.title).toBeLessThanOrEqual(REPLY_BUTTON_TITLE_MAX);
    }
  });

  it('el cuerpo ya no le pide que escriba: la advertencia va antes de la pregunta', () => {
    const cuerpo = buildCashPaymentText(
      '📦 Pedido #47\n\nComida: Bs. 54\nDelivery: Bs. 16\nTotal: Bs. 70',
      { subtotal: 54, deliveryAmount: 16 },
      true,
    );

    expect(cuerpo).not.toContain('Escribí');
    expect(cuerpo).toContain('💵 Pagas en EFECTIVO al recibir: Bs. 70');
    expect(cuerpo).toContain('⚠️ *ADVERTENCIA:*');
    expect(cuerpo).toContain('¿Confirmás tu pedido? 👇');

    // El orden ES la regla: WhatsApp pinta los botones debajo del cuerpo, así
    // que lo último que se lee antes de tocar tiene que ser la pregunta, y lo
    // anterior la advertencia.
    expect(cuerpo.indexOf('ADVERTENCIA')).toBeLessThan(cuerpo.indexOf('¿Confirmás'));
  });

  it('sin botones conserva el mensaje de palabras de siempre', () => {
    // Es la caída del sender que no sabe mandar botones. Si esto dejara de
    // decir qué escribir, ese cliente se quedaría con una pregunta y sin
    // ninguna forma de contestarla.
    const cuerpo = buildCashPaymentText('📦 Pedido #47', { subtotal: 54, deliveryAmount: 16 });
    expect(cuerpo).toContain('*CONFIRMO*');
    expect(cuerpo).toContain('*CANCELAR*');
  });

  it('el payload rechaza lo que la API rechazaría, sin gastar una llamada', () => {
    const ok = cashDecisionButtons(ORDEN);
    expect(() => buildReplyButtonsPayload('59170000000', 'Hola', ok)).not.toThrow();

    expect(() => buildReplyButtonsPayload('59170000000', '', ok)).toThrow();
    expect(() => buildReplyButtonsPayload('59170000000', 'x'.repeat(1025), ok)).toThrow();
    expect(() => buildReplyButtonsPayload('59170000000', 'Hola', [])).toThrow();
    expect(() =>
      buildReplyButtonsPayload('59170000000', 'Hola', [
        { id: 'a', title: 'x'.repeat(21) },
      ]),
    ).toThrow();
    // Dos botones con el mismo id son dos respuestas indistinguibles.
    expect(() =>
      buildReplyButtonsPayload('59170000000', 'Hola', [
        { id: 'a', title: 'Uno' },
        { id: 'a', title: 'Dos' },
      ]),
    ).toThrow();
  });
});

// ── Lo que vuelve ───────────────────────────────────────────────────────────

describe('leer el botón que tocó', () => {
  it('reconoce los dos, con su pedido', () => {
    expect(readCashDecisionButton(toque(`cash_confirm:${ORDEN}`))).toEqual({
      decision: 'confirm',
      orderNumber: ORDEN,
    });
    expect(readCashDecisionButton(toque(`cash_cancel:${ORDEN}`))).toEqual({
      decision: 'cancel',
      orderNumber: ORDEN,
    });
  });

  it('lo encuentra también si el proveedor lo aplana', () => {
    const plano = { type: 'interactive', button_reply: { id: `cash_confirm:${ORDEN}` } };
    expect(readCashDecisionButton(plano)?.decision).toBe('confirm');
  });

  it('un texto normal no es un botón', () => {
    expect(readCashDecisionButton({ type: 'text', text: { body: 'CONFIRMO' } })).toBeNull();
    expect(readCashDecisionButton(undefined)).toBeNull();
  });

  it('un botón de otro flujo no se interpreta', () => {
    expect(readCashDecisionButton(toque('menu_ver'))).toBeNull();
    // Ni uno nuestro sin pedido dentro: sin número no hay nada que decidir.
    expect(readCashDecisionButton(toque('cash_confirm:'))).toBeNull();
  });
});

describe('el toque decide el pedido', () => {
  it('CONFIRMAR lo manda a cocina', () => {
    const decision = decideDefaultReply({
      ...ESCRIBE,
      text: null,
      buttonPress: { decision: 'confirm', orderNumber: ORDEN },
      state: estado(),
    });
    expect(decision).toEqual({ action: 'cash_confirm', order: pedido() });
  });

  it('CANCELAR lo tira', () => {
    const decision = decideDefaultReply({
      ...ESCRIBE,
      text: null,
      buttonPress: { decision: 'cancel', orderNumber: ORDEN },
      state: estado(),
    });
    expect(decision.action).toBe('cash_cancel');
  });

  it('EL CASO DEL #47: el botón funciona aunque la conversación esté PAUSADA', () => {
    // Es la mitad que hace útil todo lo demás. Ese cliente acabó con su
    // conversación pausada por la derivación, y si el botón respetara la pausa
    // no funcionaría justo para quien más lo necesita.
    const decision = decideDefaultReply({
      ...ESCRIBE,
      text: null,
      buttonPress: { decision: 'confirm', orderNumber: ORDEN },
      state: estado({ paused: true }),
    });
    expect(decision.action).toBe('cash_confirm');
  });

  it('sin texto NO muere en la guarda de `no_text`', () => {
    // Un botón no trae texto. Esta es la línea por la que, antes del 13-09, el
    // cliente podía tocar y no pasaba absolutamente nada.
    const sinBoton = decideDefaultReply({ ...ESCRIBE, text: null, state: estado() });
    expect(sinBoton).toEqual({ action: 'none', reason: 'no_text' });
  });

  it('el botón de un pedido que ya no espera nada no reabre nada', () => {
    // Se puede subir el chat y tocar el botón de anoche.
    const decision = decideDefaultReply({
      ...ESCRIBE,
      text: null,
      buttonPress: { decision: 'confirm', orderNumber: 'ORD-260912-031' },
      state: estado(),
    });
    expect(decision).toEqual({ action: 'none', reason: 'stale_button' });
  });

  it('ni el de un pedido que ya se confirmó', () => {
    const decision = decideDefaultReply({
      ...ESCRIBE,
      text: null,
      buttonPress: { decision: 'confirm', orderNumber: ORDEN },
      state: estado({ openOrder: pedido({ awaitingCashConfirm: false }) }),
    });
    expect(decision).toEqual({ action: 'none', reason: 'stale_button' });
  });
});

// ── El que escribe en vez de tocar ──────────────────────────────────────────

describe('al que escribe se le reponen los botones', () => {
  it('EL MENSAJE DEL #47 ya no acaba en silencio', () => {
    const decision = decideDefaultReply({
      ...ESCRIBE,
      text: 'ya esta bien mandamelo',
      state: estado({ cashRepromptsSent: 0 }),
    });
    expect(decision).toEqual({ action: 'cash_reprompt', order: pedido(), step: 'first' });
  });

  it('si insiste, el segundo aviso dice la consecuencia', () => {
    const decision = decideDefaultReply({
      ...ESCRIBE,
      text: 'holaaa',
      state: estado({ cashRepromptsSent: 1 }),
    });
    expect(decision).toEqual({ action: 'cash_reprompt', order: pedido(), step: 'last' });
  });

  it('y después silencio: el barrido de los 20 minutos hace el resto', () => {
    // Dos avisos y ya. Insistir con la misma pregunta es lo que acaba llevando
    // una persona al chat, que es lo que este cambio existe para evitar.
    const decision = decideDefaultReply({
      ...ESCRIBE,
      text: 'holaaa',
      state: estado({ cashRepromptsSent: 2 }),
    });
    expect(decision).toEqual({ action: 'none', reason: 'open_order' });
  });

  it('quien SÍ escribe la palabra sigue confirmando: el atajo no se toca', () => {
    const decision = decideDefaultReply({
      ...ESCRIBE,
      text: 'CONFIRMO',
      state: estado({ cashRepromptsSent: 0 }),
    });
    expect(decision.action).toBe('cash_confirm');
  });

  it('pedir el menú gana: está encargando otra cosa, no contestando', () => {
    const decision = decideDefaultReply({
      ...ESCRIBE,
      explicitIntent: true,
      text: 'quiero pedir',
      state: estado({ cashRepromptsSent: 0 }),
    });
    expect(decision).toEqual({ action: 'menu' });
  });

  it('un pedido que NO espera efectivo no recibe ningún aviso', () => {
    const decision = decideDefaultReply({
      ...ESCRIBE,
      text: 'holaaa',
      state: estado({ openOrder: pedido({ awaitingCashConfirm: false }) }),
    });
    expect(decision).toEqual({ action: 'none', reason: 'open_order' });
  });
});
