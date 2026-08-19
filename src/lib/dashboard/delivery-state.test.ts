import { describe, it, expect } from 'vitest';
import { deliveryQuoteView, type DeliveryStateInput } from './delivery-state';

function input(over: Partial<DeliveryStateInput> = {}): DeliveryStateInput {
  return {
    deliveryType: 'delivery',
    deliveryPricing: 'dynamic',
    deliveryQuoteStatus: 'pending',
    hasCoordinates: false,
    ...over,
  };
}

describe('deliveryQuoteView — estado de envío dinámico (6D.2D)', () => {
  it('1. dynamic pending sin GPS → awaiting_location "Esperando ubicación"', () => {
    const v = deliveryQuoteView(input({ deliveryQuoteStatus: 'pending', hasCoordinates: false }));
    expect(v).toEqual({ key: 'awaiting_location', label: 'Esperando ubicación', tone: 'amber' });
  });

  it('2. dynamic pending con GPS → quoting "Calculando envío"', () => {
    const v = deliveryQuoteView(input({ deliveryQuoteStatus: 'pending', hasCoordinates: true }));
    expect(v).toEqual({ key: 'quoting', label: 'Calculando envío', tone: 'blue' });
  });

  it('3. failed → "Error al calcular envío" (rojo)', () => {
    const v = deliveryQuoteView(input({ deliveryQuoteStatus: 'failed', hasCoordinates: true }));
    expect(v).toEqual({ key: 'failed', label: 'Error al calcular envío', tone: 'red' });
  });

  it('4. out_of_coverage → "Fuera de cobertura" (rojo)', () => {
    const v = deliveryQuoteView(input({ deliveryQuoteStatus: 'out_of_coverage', hasCoordinates: true }));
    expect(v).toEqual({ key: 'out_of_coverage', label: 'Fuera de cobertura', tone: 'red' });
  });

  it('5. quoted → "Envío cotizado" (verde)', () => {
    const v = deliveryQuoteView(input({ deliveryQuoteStatus: 'quoted', hasCoordinates: true }));
    expect(v).toEqual({ key: 'quoted', label: 'Envío cotizado', tone: 'green' });
  });

  it('9. pickup → null (sin chip)', () => {
    expect(deliveryQuoteView(input({ deliveryType: 'pickup', deliveryPricing: null }))).toBeNull();
  });

  it('10. legacy delivery (pricing NULL) → null', () => {
    expect(deliveryQuoteView(input({ deliveryPricing: null, deliveryQuoteStatus: null }))).toBeNull();
  });

  it('dynamic con quote_status nulo/desconocido → null (defensivo)', () => {
    expect(deliveryQuoteView(input({ deliveryQuoteStatus: null }))).toBeNull();
  });
});
