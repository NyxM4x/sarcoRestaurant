import { describe, expect, it } from 'vitest';
import { readCashConfirmReply } from './cash-confirm-reply';

/**
 * "CONFIRMO" / "CANCELAR" (05-09-2026).
 *
 * Aquí el error no manda un mensaje de más: agenda —o tira— un pedido. Por eso
 * se compara la frase entera y por eso cancelar acepta menos formas que
 * confirmar: es la que no tiene vuelta atrás.
 */
describe('readCashConfirmReply', () => {
  it('la palabra que se le pidió, escrita como sea', () => {
    for (const frase of ['CONFIRMO', 'confirmo', 'Confirmo', 'confirmado', 'lo confirmo']) {
      expect(readCashConfirmReply(frase), frase).toBe('confirm');
    }
  });

  it('y las formas naturales de decir que sí', () => {
    // La gente no copia instrucciones.
    for (const frase of ['si', 'dale', 'ok', 'listo', 'perfecto', 'esta bien']) {
      expect(readCashConfirmReply(frase), frase).toBe('confirm');
    }
  });

  it('cancelar, incluido lo que escribió el cliente del #39', () => {
    for (const frase of ['CANCELAR', 'cancelar pedido', 'cancelalo', 'ya no quiero', 'mejor no']) {
      expect(readCashConfirmReply(frase), frase).toBe('cancel');
    }
  });

  it('la cortesía del final no cambia la decisión', () => {
    expect(readCashConfirmReply('confirmo porfa')).toBe('confirm');
    expect(readCashConfirmReply('cancelar gracias')).toBe('cancel');
  });

  it('una frase que CONTIENE la palabra no es una decisión', () => {
    // Se compara entera. Buscando dentro, "no quiero locoto" cancelaría un
    // pedido y "ya me llegó el QR" lo agendaría: dos frases normales que
    // costarían un pedido cada una.
    expect(readCashConfirmReply('no quiero locoto')).toBeNull();
    expect(readCashConfirmReply('puedo cancelar despues?')).toBeNull();
    expect(readCashConfirmReply('si me lo pueden traer rapido')).toBeNull();
  });

  it('lo que no decide nada sigue su camino', () => {
    // Es el caso del #40: "muy caro su moto" no es un CANCELAR. Su pedido se
    // queda esperando —y caduca solo— en vez de cancelarse por una queja.
    for (const frase of ['muy caro su moto', 'cuanto tarda', '??', 'hola', 'y si pago con QR']) {
      expect(readCashConfirmReply(frase), frase).toBeNull();
    }
  });

  it('sin texto no hay decisión', () => {
    expect(readCashConfirmReply(null)).toBeNull();
    expect(readCashConfirmReply(undefined)).toBeNull();
    expect(readCashConfirmReply('')).toBeNull();
    expect(readCashConfirmReply('   ')).toBeNull();
  });
});
