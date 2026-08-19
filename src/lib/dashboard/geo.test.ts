import { describe, it, expect } from 'vitest';
import { googleMapsUrl } from './geo';

describe('geo — googleMapsUrl', () => {
  it('construye la URL estándar de Maps con coordenadas válidas', () => {
    // Santa Cruz de la Sierra, aprox.
    expect(googleMapsUrl(-17.7834, -63.1821)).toBe(
      'https://www.google.com/maps/search/?api=1&query=-17.7834,-63.1821',
    );
  });

  it('devuelve null cuando falta alguna coordenada', () => {
    expect(googleMapsUrl(null, -63.1)).toBeNull();
    expect(googleMapsUrl(-17.7, null)).toBeNull();
    expect(googleMapsUrl(null, null)).toBeNull();
    expect(googleMapsUrl(undefined, undefined)).toBeNull();
  });

  it('rechaza coordenadas fuera de rango o no finitas', () => {
    expect(googleMapsUrl(91, 0)).toBeNull();
    expect(googleMapsUrl(0, 181)).toBeNull();
    expect(googleMapsUrl(Number.NaN, 0)).toBeNull();
    expect(googleMapsUrl(0, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('acepta el origen 0,0 como coordenada válida', () => {
    expect(googleMapsUrl(0, 0)).toBe(
      'https://www.google.com/maps/search/?api=1&query=0,0',
    );
  });
});
