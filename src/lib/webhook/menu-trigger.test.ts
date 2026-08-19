import { describe, expect, it } from 'vitest';
import {
  MENU_TRIGGER_TEXT,
  extractTextBody,
  isMenuTriggerMessage,
  isOutboundMessage,
} from './menu-trigger';

function textMessage(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 'wamid.TXT_1',
    type: 'text',
    from: '59170000001',
    text: { body },
    ...overrides,
  };
}

describe('extractTextBody', () => {
  it('devuelve el cuerpo de un mensaje de texto', () => {
    expect(extractTextBody(textMessage('hola'))).toBe('hola');
  });

  it('devuelve null para mensajes que no son texto', () => {
    expect(extractTextBody(undefined)).toBeNull();
    expect(extractTextBody({ type: 'image', image: { caption: MENU_TRIGGER_TEXT } })).toBeNull();
    expect(extractTextBody({ type: 'audio', audio: { id: 'a' } })).toBeNull();
    expect(extractTextBody({ type: 'location', location: { latitude: 0, longitude: 0 } })).toBeNull();
    expect(
      extractTextBody({ type: 'interactive', interactive: { type: 'nfm_reply' } }),
    ).toBeNull();
    expect(
      extractTextBody({ type: 'interactive', interactive: { type: 'button_reply' } }),
    ).toBeNull();
  });

  it('devuelve null si text.body no es string', () => {
    expect(extractTextBody(textMessage(123))).toBeNull();
    expect(extractTextBody(textMessage(null))).toBeNull();
    expect(extractTextBody({ id: 'x', type: 'text' })).toBeNull();
  });
});

describe('isMenuTriggerMessage — activa', () => {
  it('con el texto exacto', () => {
    expect(isMenuTriggerMessage(textMessage('TESTMENU9842'))).toBe(true);
  });

  it('con espacios externos', () => {
    expect(isMenuTriggerMessage(textMessage('   TESTMENU9842   '))).toBe(true);
    expect(isMenuTriggerMessage(textMessage('\n TESTMENU9842\t'))).toBe(true);
  });

  it('sin distinguir mayúsculas y minúsculas', () => {
    expect(isMenuTriggerMessage(textMessage('testmenu9842'))).toBe(true);
    expect(isMenuTriggerMessage(textMessage('TestMenu9842'))).toBe(true);
    expect(isMenuTriggerMessage(textMessage('  tEsTmEnU9842 '))).toBe(true);
  });
});

describe('isMenuTriggerMessage — NO activa', () => {
  it('con la palabra acompañada de otro texto', () => {
    expect(isMenuTriggerMessage(textMessage('hola TESTMENU9842'))).toBe(false);
    expect(isMenuTriggerMessage(textMessage('TESTMENU9842 hola'))).toBe(false);
    expect(isMenuTriggerMessage(textMessage('TESTMENU9842TESTMENU9842'))).toBe(false);
  });

  it('con texto distinto o vacío', () => {
    expect(isMenuTriggerMessage(textMessage('hola'))).toBe(false);
    expect(isMenuTriggerMessage(textMessage('menu'))).toBe(false);
    expect(isMenuTriggerMessage(textMessage('TESTMENU9843'))).toBe(false);
    expect(isMenuTriggerMessage(textMessage(''))).toBe(false);
    expect(isMenuTriggerMessage(textMessage('   '))).toBe(false);
  });

  it('con otros tipos de mensaje aunque lleven la palabra', () => {
    expect(isMenuTriggerMessage(undefined)).toBe(false);
    expect(
      isMenuTriggerMessage({ type: 'image', image: { caption: MENU_TRIGGER_TEXT } }),
    ).toBe(false);
    expect(isMenuTriggerMessage({ type: 'audio', audio: { id: 'a' } })).toBe(false);
    expect(
      isMenuTriggerMessage({ type: 'location', location: { latitude: 0, longitude: 0 } }),
    ).toBe(false);
    expect(
      isMenuTriggerMessage({
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { title: MENU_TRIGGER_TEXT } },
      }),
    ).toBe(false);
    expect(
      isMenuTriggerMessage({
        type: 'interactive',
        interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{}' } },
      }),
    ).toBe(false);
  });

  it('con mensajes marcados como salientes (del negocio)', () => {
    expect(isMenuTriggerMessage(textMessage(MENU_TRIGGER_TEXT, { direction: 'outbound' }))).toBe(
      false,
    );
    expect(isMenuTriggerMessage(textMessage(MENU_TRIGGER_TEXT, { from_me: true }))).toBe(false);
  });

  it('sigue activando si el marcador dice entrante o no existe', () => {
    expect(isMenuTriggerMessage(textMessage(MENU_TRIGGER_TEXT, { direction: 'inbound' }))).toBe(
      true,
    );
    expect(isMenuTriggerMessage(textMessage(MENU_TRIGGER_TEXT, { from_me: false }))).toBe(true);
  });
});

describe('isOutboundMessage', () => {
  it('solo es true con un marcador explícito de salida', () => {
    expect(isOutboundMessage(undefined)).toBe(false);
    expect(isOutboundMessage({ type: 'text' })).toBe(false);
    expect(isOutboundMessage({ type: 'text', direction: 'inbound' })).toBe(false);
    expect(isOutboundMessage({ type: 'text', direction: 'outbound' })).toBe(true);
    expect(isOutboundMessage({ type: 'text', from_me: true })).toBe(true);
  });
});
