import { describe, it, expect } from 'vitest';
import {
  buildHandoffNotice,
  handoffCategoryLabel,
  handoffExcerpt,
  HANDOFF_EXCERPT_MAX,
} from './handoff-notice';

const PHONE = '59171234567';

describe('aviso de derivación — lo que necesita quien atiende', () => {
  it('lleva teléfono y un enlace para abrir el chat', () => {
    // Un aviso que dijera "hay un cliente enfadado" y nada más obligaría a
    // buscar a ciegas en WhatsApp. En hora punta, eso es un aviso que no se
    // atiende.
    const texto = buildHandoffNotice({
      customerPhone: PHONE,
      reason: 'handoff_requested',
      lastMessage: 'esto es un robo',
    });
    expect(texto).toContain(PHONE);
    expect(texto).toContain(`https://wa.me/${PHONE}`);
  });

  it('dice el motivo en el idioma de quien lo lee, no en códigos', () => {
    expect(handoffCategoryLabel('handoff_requested')).toBe(
      'El cliente necesita hablar con una persona',
    );
    expect(handoffCategoryLabel('handoff_menu_loop')).toBe('No consigue hacer su pedido');
  });

  it('un motivo que nadie tradujo AVISA igual, con texto genérico', () => {
    // Callarse porque falta una etiqueta sería perder justo el aviso que nadie
    // previó. Y nunca se enseña el código crudo.
    const label = handoffCategoryLabel('motivo_futuro_desconocido');
    expect(label).toBe('La conversación necesita a una persona');
    expect(label).not.toContain('motivo_futuro');
  });

  it('termina diciendo QUÉ HACER, no solo qué pasó', () => {
    const texto = buildHandoffNotice({ customerPhone: PHONE, reason: 'handoff_requested', lastMessage: null });
    expect(texto).toContain('WhatsApp Business App');
    expect(texto).toContain('pausa');
  });
});

describe('aviso de derivación — el mensaje del cliente', () => {
  it('va entero cuando es corto', () => {
    expect(handoffExcerpt('me llegó frío')).toBe('me llegó frío');
  });

  it('se recorta cuando es largo: el aviso se lee en un teléfono', () => {
    const largo = 'a'.repeat(HANDOFF_EXCERPT_MAX + 50);
    const recortado = handoffExcerpt(largo)!;
    expect(recortado.length).toBeLessThanOrEqual(HANDOFF_EXCERPT_MAX + 1);
    expect(recortado.endsWith('…')).toBe(true);
  });

  it('colapsa saltos de línea para no romper el formato del aviso', () => {
    expect(handoffExcerpt('hola\n\n  que  tal ')).toBe('hola que tal');
  });

  it('sin mensaje, el aviso sale igual y sin sección vacía', () => {
    const texto = buildHandoffNotice({ customerPhone: PHONE, reason: 'handoff_menu_loop', lastMessage: null });
    expect(handoffExcerpt(null)).toBeNull();
    expect(texto).not.toContain('Último mensaje');
  });
});

describe('aviso de derivación — lo que NUNCA lleva', () => {
  it('nada de la maquinaria interna', () => {
    // Quien lee esto va a atender a un cliente, no a depurar el sistema.
    const texto = buildHandoffNotice({
      customerPhone: PHONE,
      reason: 'handoff_requested',
      lastMessage: 'no me abre la página',
    });
    for (const prohibido of [
      'wamid',
      'session',
      'token',
      'openai',
      'prompt',
      'conv-',
      'agent_conversation',
      'request_human',
    ]) {
      expect(texto.toLowerCase(), prohibido).not.toContain(prohibido);
    }
  });
});
