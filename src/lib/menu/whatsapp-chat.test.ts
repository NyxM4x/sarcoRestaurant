import { describe, it, expect } from 'vitest';
import { businessChatUrl } from './whatsapp-chat';

describe('businessChatUrl — el chat del negocio tras confirmar (19-09-2026)', () => {
  it('arma el enlace wa.me con el número completo', () => {
    expect(businessChatUrl('59171234567')).toBe('https://wa.me/59171234567');
  });

  it('acepta el número como se escribe a mano: +, espacios y guiones', () => {
    expect(businessChatUrl('+591 7123-4567')).toBe('https://wa.me/59171234567');
    expect(businessChatUrl(' 591 71234567 ')).toBe('https://wa.me/59171234567');
  });

  it('el número local de 8 dígitos recibe el código de Bolivia', () => {
    // Sin código de país, wa.me abriría un chat con nadie.
    expect(businessChatUrl('71234567')).toBe('https://wa.me/59171234567');
  });

  it('sin número utilizable no hay enlace', () => {
    expect(businessChatUrl(undefined)).toBeNull();
    expect(businessChatUrl(null)).toBeNull();
    expect(businessChatUrl('')).toBeNull();
    expect(businessChatUrl('pendiente')).toBeNull();
    expect(businessChatUrl('12345')).toBeNull();
  });

  it('nunca precarga un mensaje: el bot le contestaría con el botón del menú', () => {
    expect(businessChatUrl('59171234567')).not.toContain('?');
  });
});
