import { describe, it, expect } from 'vitest';
import { parseLocationMessage, parseStandaloneLocation } from './location-message';

function locationMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wamid.LOC_MSG_1',
    type: 'location',
    from: '59170000001',
    context: { id: 'wamid.LOCATION_REQUEST_1', from: '59170000001' },
    location: {
      latitude: -17.7833,
      longitude: -63.1821,
      address: 'Av. Siempre Viva 123',
      name: 'Casa',
    },
    ...overrides,
  };
}

describe('parseLocationMessage', () => {
  it('parsea una ubicación válida y extrae context.id, coordenadas y opcionales', () => {
    const res = parseLocationMessage(locationMessage());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        messageId: 'wamid.LOC_MSG_1',
        contextId: 'wamid.LOCATION_REQUEST_1',
        latitude: -17.7833,
        longitude: -63.1821,
        address: 'Av. Siempre Viva 123',
        name: 'Casa',
      });
    }
  });

  it('acepta ubicación sin address/name (opcionales)', () => {
    const res = parseLocationMessage(
      locationMessage({ location: { latitude: 1, longitude: 2 } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.address).toBeUndefined();
      expect(res.data.name).toBeUndefined();
    }
  });

  it('mensaje que no es type=location -> not_location', () => {
    const res = parseLocationMessage({ id: 'x', type: 'text', text: { body: 'hola' } });
    expect(res).toEqual({ ok: false, reason: 'not_location' });
  });

  it('mensaje undefined -> not_location', () => {
    expect(parseLocationMessage(undefined)).toEqual({ ok: false, reason: 'not_location' });
  });

  it('latitude fuera de rango (>90) -> invalid_shape', () => {
    const res = parseLocationMessage(
      locationMessage({ location: { latitude: 91, longitude: 0 } }),
    );
    expect(res).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('latitude fuera de rango (<-90) -> invalid_shape', () => {
    const res = parseLocationMessage(
      locationMessage({ location: { latitude: -91, longitude: 0 } }),
    );
    expect(res).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('longitude fuera de rango (>180) -> invalid_shape', () => {
    const res = parseLocationMessage(
      locationMessage({ location: { latitude: 0, longitude: 181 } }),
    );
    expect(res).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('longitude fuera de rango (<-180) -> invalid_shape', () => {
    const res = parseLocationMessage(
      locationMessage({ location: { latitude: 0, longitude: -181 } }),
    );
    expect(res).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('context.id ausente -> invalid_shape', () => {
    const res = parseLocationMessage(locationMessage({ context: {} }));
    expect(res).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('message.id ausente -> invalid_shape', () => {
    const res = parseLocationMessage(locationMessage({ id: undefined }));
    expect(res).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('location ausente por completo -> invalid_shape', () => {
    const res = parseLocationMessage(locationMessage({ location: undefined }));
    expect(res).toEqual({ ok: false, reason: 'invalid_shape' });
  });
});

describe('parseStandaloneLocation — el pin que no responde a nada', () => {
  it('acepta una ubicación SIN contexto', () => {
    // El caso real: el cliente comparte su ubicación con el botón normal de
    // WhatsApp. Antes esto era `invalid_shape` y nadie le contestaba.
    const res = parseStandaloneLocation(locationMessage({ context: undefined }));

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        messageId: 'wamid.LOC_MSG_1',
        latitude: -17.7833,
        longitude: -63.1821,
        address: 'Av. Siempre Viva 123',
        name: 'Casa',
      });
    }
  });

  it('no arrastra el contexto aunque venga', () => {
    // Su trabajo no es correlacionar. Si algún día alguien usa este dato para
    // buscar un pedido, que no lo saque de aquí.
    const res = parseStandaloneLocation(locationMessage());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).not.toHaveProperty('contextId');
  });

  it('relaja el contexto, NO la validación de lo que importa', () => {
    // Unas coordenadas imposibles o un mensaje sin id siguen siendo inválidos:
    // se cotizaría sobre un punto que no existe y se cobraría por medirlo.
    for (const roto of [
      { context: undefined, location: { latitude: 999, longitude: -63.1 } },
      { context: undefined, location: { latitude: -17.78, longitude: -999 } },
      { context: undefined, location: { latitude: '-17.78', longitude: -63.1 } },
      { context: undefined, location: undefined },
      { context: undefined, id: '' },
    ]) {
      expect(parseStandaloneLocation(locationMessage(roto)).ok).toBe(false);
    }
  });

  it('sigue exigiendo que sea una ubicación', () => {
    expect(parseStandaloneLocation({ type: 'text', text: { body: 'hola' } })).toEqual({
      ok: false,
      reason: 'not_location',
    });
    expect(parseStandaloneLocation(undefined)).toEqual({ ok: false, reason: 'not_location' });
  });
});
