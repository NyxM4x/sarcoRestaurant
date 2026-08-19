import { describe, it, expect } from 'vitest';
import { normalizeFilters, dateBounds, STATUS_GROUPS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './filters';

describe('filters — normalización y límites', () => {
  it('3/4. mapea el grupo operativo a un conjunto de estados; ignora grupos desconocidos', () => {
    // "En preparación" NO incluye draft (borrador del Flow, invisible al encargado).
    expect(STATUS_GROUPS.en_preparacion).not.toContain('draft');
    expect(normalizeFilters({ statusGroup: 'en_preparacion' }).statuses).toEqual([
      'awaiting_location',
      'confirmed',
      'preparing',
    ]);
    // Ningún grupo operativo expone draft.
    for (const g of Object.values(STATUS_GROUPS)) expect(g).not.toContain('draft');
    expect(normalizeFilters({ statusGroup: 'en_camino_listos' }).statuses).toEqual(['ready', 'on_the_way']);
    expect(normalizeFilters({ statusGroup: 'entregados' }).statuses).toEqual(['delivered']);
    expect(normalizeFilters({ statusGroup: 'cancelados' }).statuses).toEqual(['cancelled']);
    expect(normalizeFilters({ statusGroup: 'hacker' }).statuses).toBeNull();
    expect(normalizeFilters({}).statuses).toBeNull();
    expect(normalizeFilters({ deliveryType: 'pickup' }).deliveryType).toBe('pickup');
    expect(normalizeFilters({ deliveryType: 'drone' }).deliveryType).toBeNull();
  });

  it('compatibilidad: un estado técnico único válido se acepta como conjunto de uno', () => {
    expect(normalizeFilters({ status: 'preparing' }).statuses).toEqual(['preparing']);
    expect(normalizeFilters({ status: 'hacker' }).statuses).toBeNull();
    // El grupo operativo tiene prioridad sobre el estado único.
    expect(normalizeFilters({ statusGroup: 'entregados', status: 'preparing' }).statuses).toEqual(['delivered']);
  });

  it('5. saneo de búsqueda: whitelist alfanumérica, sin comodines de ILIKE', () => {
    expect(normalizeFilters({ search: 'ORD-000123' }).search).toBe('ORD-000123');
    expect(normalizeFilters({ search: "%_'; drop" }).search).toBe('drop');
    expect(normalizeFilters({ search: '   ' }).search).toBeNull();
    expect(normalizeFilters({ search: 'x'.repeat(200) }).search?.length).toBe(60);
  });

  it('6. el límite se acota SIEMPRE (nunca descarga toda la tabla)', () => {
    expect(normalizeFilters({}).limit).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizeFilters({ limit: 9999 }).limit).toBe(MAX_PAGE_SIZE);
    expect(normalizeFilters({ limit: 0 }).limit).toBe(1);
    expect(normalizeFilters({ limit: -5 }).limit).toBe(1);
    expect(normalizeFilters({ offset: -10 }).offset).toBe(0);
    expect(normalizeFilters({ offset: 40 }).offset).toBe(40);
  });

  it('rango de fecha por defecto es "today" y se valida', () => {
    expect(normalizeFilters({}).dateRange).toBe('today');
    expect(normalizeFilters({ dateRange: 'last7' }).dateRange).toBe('last7');
    expect(normalizeFilters({ dateRange: 'ever' }).dateRange).toBe('today');
  });

  it('dateBounds calcula ventanas coherentes', () => {
    const now = Date.parse('2026-08-06T15:30:00.000Z');
    expect(dateBounds('all', now)).toEqual({ since: null, until: null });
    expect(dateBounds('today', now).since).toBe('2026-08-06T00:00:00.000Z');
    expect(dateBounds('yesterday', now)).toEqual({
      since: '2026-08-05T00:00:00.000Z',
      until: '2026-08-06T00:00:00.000Z',
    });
    expect(dateBounds('last7', now).since).toBe('2026-07-31T00:00:00.000Z');
  });
});
