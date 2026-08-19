import { describe, it, expect } from 'vitest';
import {
  parseDeliveryConfig,
  getDeliveryConfig,
  DEFAULT_MAPBOX_DIRECTIONS_TIMEOUT_MS,
} from './config';

const VALID = {
  MAPBOX_ACCESS_TOKEN: 'pk.test-token',
  RESTAURANT_LAT: '-17.783',
  RESTAURANT_LNG: '-63.182',
};

describe('parseDeliveryConfig — válido', () => {
  it('acepta token + coordenadas y aplica el timeout por defecto', () => {
    const r = parseDeliveryConfig({ ...VALID });
    expect(r).toEqual({
      ok: true,
      config: {
        mapboxAccessToken: 'pk.test-token',
        restaurantLat: -17.783,
        restaurantLng: -63.182,
        mapboxTimeoutMs: DEFAULT_MAPBOX_DIRECTIONS_TIMEOUT_MS,
      },
    });
  });

  it('usa MAPBOX_DIRECTIONS_TIMEOUT_MS cuando está presente y es válido', () => {
    const r = parseDeliveryConfig({ ...VALID, MAPBOX_DIRECTIONS_TIMEOUT_MS: '8000' });
    expect(r.ok && r.config.mapboxTimeoutMs).toBe(8000);
  });

  it('ignora un timeout vacío y cae al default', () => {
    const r = parseDeliveryConfig({ ...VALID, MAPBOX_DIRECTIONS_TIMEOUT_MS: '' });
    expect(r.ok && r.config.mapboxTimeoutMs).toBe(DEFAULT_MAPBOX_DIRECTIONS_TIMEOUT_MS);
  });
});

describe('parseDeliveryConfig — faltantes / inválidos (solo nombres, sin valores)', () => {
  it('sin token → falta MAPBOX_ACCESS_TOKEN', () => {
    const r = parseDeliveryConfig({ ...VALID, MAPBOX_ACCESS_TOKEN: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain('MAPBOX_ACCESS_TOKEN');
  });

  it('token vacío se trata como ausente', () => {
    const r = parseDeliveryConfig({ ...VALID, MAPBOX_ACCESS_TOKEN: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain('MAPBOX_ACCESS_TOKEN');
  });

  it('latitud fuera de rango → falta RESTAURANT_LAT', () => {
    const r = parseDeliveryConfig({ ...VALID, RESTAURANT_LAT: '120' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain('RESTAURANT_LAT');
  });

  it('longitud no numérica → falta RESTAURANT_LNG', () => {
    const r = parseDeliveryConfig({ ...VALID, RESTAURANT_LNG: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain('RESTAURANT_LNG');
  });

  it('coordenadas vacías se tratan como ausentes', () => {
    const r = parseDeliveryConfig({ MAPBOX_ACCESS_TOKEN: 'pk.x', RESTAURANT_LAT: '', RESTAURANT_LNG: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toContain('RESTAURANT_LAT');
      expect(r.missing).toContain('RESTAURANT_LNG');
    }
  });

  it('timeout inválido (no positivo) invalida la config', () => {
    const r = parseDeliveryConfig({ ...VALID, MAPBOX_DIRECTIONS_TIMEOUT_MS: '-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain('MAPBOX_DIRECTIONS_TIMEOUT_MS');
  });

  it('el nombre reportado nunca incluye el valor recibido (no filtra secretos)', () => {
    const r = parseDeliveryConfig({ RESTAURANT_LAT: '-17', RESTAURANT_LNG: '-63' });
    if (!r.ok) {
      expect(r.missing).toEqual(['MAPBOX_ACCESS_TOKEN']);
      expect(r.missing.join(',')).not.toContain('pk.');
    }
  });
});

describe('getDeliveryConfig — lectura de process.env (lazy)', () => {
  it('resuelve desde process.env cuando está configurado', () => {
    const prev = { ...process.env };
    try {
      process.env.MAPBOX_ACCESS_TOKEN = 'pk.env-token';
      process.env.RESTAURANT_LAT = '-17.783';
      process.env.RESTAURANT_LNG = '-63.182';
      const cfg = getDeliveryConfig();
      expect(cfg.mapboxAccessToken).toBe('pk.env-token');
      expect(cfg.restaurantLat).toBeCloseTo(-17.783);
      expect(cfg.mapboxTimeoutMs).toBe(DEFAULT_MAPBOX_DIRECTIONS_TIMEOUT_MS);
    } finally {
      process.env = prev;
    }
  });
});
