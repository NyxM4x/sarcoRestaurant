/**
 * Presentación del método de pago en el dashboard (Fase 6D.1) — módulo PURO.
 *
 * El pago es una dimensión INDEPENDIENTE del estado operativo del pedido: este
 * helper solo traduce `payment_method` a un chip legible. No hay estado de pago
 * (pagado/por cobrar) todavía — eso es 6D.2.
 *
 * `null` (pedidos históricos y del WhatsApp Flow, "pago no registrado") devuelve
 * `null`: la UI NO muestra chip ni inventa información de pago.
 */
import type { PaymentMethod } from '@/types';

export interface PaymentMethodMeta {
  label: string;
  /** Icono de apoyo (puede ser vacío). La info nunca depende solo del color. */
  icon: string;
}

export function paymentMethodMeta(method: PaymentMethod | null): PaymentMethodMeta | null {
  switch (method) {
    case 'cash':
      return { label: 'Efectivo', icon: '💵' };
    case 'qr':
      return { label: 'QR', icon: '📱' };
    default:
      // null (u otro valor no esperado): sin chip, no se inventa pago.
      return null;
  }
}
