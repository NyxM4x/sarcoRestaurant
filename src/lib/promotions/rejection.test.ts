import { describe, expect, it } from 'vitest';
import {
  PROMOTION_REJECTION_REASONS,
  parsePromotionRejection,
  promotionRejectionMessage,
} from './rejection';

const UUID = '3a5fc126-7b8a-4bad-a7e4-a99bb5ce74cc';

describe('lectura del rechazo de la RPC', () => {
  it('extrae motivo e identificador', () => {
    expect(parsePromotionRejection(`promotion_rejected:expired:${UUID}`)).toEqual({
      reason: 'expired',
      promotionId: UUID,
    });
  });

  it('reconoce todos los motivos que la RPC puede emitir', () => {
    for (const reason of PROMOTION_REJECTION_REASONS) {
      expect(parsePromotionRejection(`promotion_rejected:${reason}:${UUID}`), reason).toEqual({
        reason,
        promotionId: UUID,
      });
    }
  });

  it('tolera el sufijo que Postgres añade al mensaje', () => {
    // `raise exception` puede llegar con contexto detrás; el patrón ancla al
    // principio y no exige que el mensaje termine ahí.
    const conRuido = `promotion_rejected:disabled:${UUID}\nCONTEXT: PL/pgSQL function ...`;
    expect(parsePromotionRejection(conRuido)?.reason).toBe('disabled');
  });

  describe('lo que NO se acepta', () => {
    it('un motivo que no está en la lista blanca', () => {
      expect(parsePromotionRejection(`promotion_rejected:whatever:${UUID}`)).toBeNull();
    });

    it('un identificador que no es UUID', () => {
      expect(parsePromotionRejection('promotion_rejected:expired:123')).toBeNull();
    });

    it('un mensaje cualquiera de PostgreSQL', () => {
      // Es el caso que importa: un error inesperado NO puede colarse al
      // navegador disfrazado de rechazo de promoción.
      expect(
        parsePromotionRejection('duplicate key value violates unique constraint "promotions_pkey"'),
      ).toBeNull();
    });

    it('null, undefined y lo que no es texto', () => {
      expect(parsePromotionRejection(null)).toBeNull();
      expect(parsePromotionRejection(undefined)).toBeNull();
    });
  });
});

describe('lo que se le dice al cliente', () => {
  it('cada motivo tiene su mensaje', () => {
    for (const reason of PROMOTION_REJECTION_REASONS) {
      const texto = promotionRejectionMessage(reason);
      expect(texto.length, reason).toBeGreaterThan(10);
    }
  });

  it('ningún mensaje culpa al cliente ni lo manda a esperar', () => {
    for (const reason of PROMOTION_REJECTION_REASONS) {
      const texto = promotionRejectionMessage(reason).toLowerCase();
      expect(texto, reason).not.toContain('error');
      expect(texto, reason).not.toContain('intenta más tarde');
      expect(texto, reason).not.toContain('inválid');
    }
  });

  it('el vencimiento y el agotado dicen QUÉ pasó, no un genérico', () => {
    expect(promotionRejectionMessage('expired')).toContain('terminó');
    expect(promotionRejectionMessage('component_unavailable')).toContain('acabó');
    expect(promotionRejectionMessage('stale_revision')).toContain('cambió');
  });

  it('todos dicen qué hacer ahora', () => {
    for (const reason of PROMOTION_REJECTION_REASONS) {
      const texto = promotionRejectionMessage(reason).toLowerCase();
      expect(texto.includes('quítala') || texto.includes('vuelve a abrir'), reason).toBe(true);
    }
  });
});
