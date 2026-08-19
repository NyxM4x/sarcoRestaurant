import { describe, it, expect } from 'vitest';
import * as limits from './limits';
import * as webSchema from '@/lib/orders/web-schema';

/**
 * Los límites del formulario del navegador y los del contrato Zod del servidor
 * deben ser el mismo valor. Este test corre en node, así que importar
 * `web-schema` (y con él Zod) no afecta al bundle del cliente.
 */
describe('límites compartidos', () => {
  it('web-schema reexporta exactamente los mismos valores que limits', () => {
    expect(webSchema.MAX_CART_LINES).toBe(limits.MAX_CART_LINES);
    expect(webSchema.MIN_ITEM_QUANTITY).toBe(limits.MIN_ITEM_QUANTITY);
    expect(webSchema.MAX_ITEM_QUANTITY).toBe(limits.MAX_ITEM_QUANTITY);
    expect(webSchema.MAX_CUSTOMER_NAME_LENGTH).toBe(limits.MAX_CUSTOMER_NAME_LENGTH);
    expect(webSchema.MAX_NOTES_LENGTH).toBe(limits.MAX_NOTES_LENGTH);
  });

  it('los valores coinciden con los que valida la RPC', () => {
    expect(limits.MAX_CART_LINES).toBe(20);
    expect(limits.MIN_ITEM_QUANTITY).toBe(1);
    expect(limits.MAX_ITEM_QUANTITY).toBe(10);
    expect(limits.MAX_CUSTOMER_NAME_LENGTH).toBe(100);
    expect(limits.MAX_NOTES_LENGTH).toBe(500);
  });

  it('limits.ts no arrastra dependencias', async () => {
    // Si algún día importara zod u otro módulo pesado, este import fallaría
    // en un entorno sin esas dependencias. Sirve de recordatorio explícito.
    const exported = await import('./limits');
    expect(Object.keys(exported).sort()).toEqual([
      'MAX_CART_LINES',
      'MAX_CUSTOMER_NAME_LENGTH',
      'MAX_ITEM_QUANTITY',
      'MAX_NOTES_LENGTH',
      'MIN_ITEM_QUANTITY',
    ]);
  });
});
