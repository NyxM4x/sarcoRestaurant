import { describe, expect, it } from 'vitest';
import type { PromotionComponent } from './promotion';
import {
  businessLocalToIso,
  composeSummary,
  expiryLabel,
  heroComponent,
  isAllowedImageUrl,
  isoToBusinessLocal,
  resolvePromotionImage,
} from './promotion-display';

const componente = (
  over: Partial<PromotionComponent> & { code: string },
): PromotionComponent => ({
  menuItemId: `id-${over.code}`,
  name: over.code,
  category: 'plato',
  unitPrice: 10,
  quantity: 1,
  isActive: true,
  ...over,
});

const COMBO: PromotionComponent[] = [
  componente({ code: 'soda_peque', name: 'Soda Peque', category: 'bebida', unitPrice: 5, quantity: 2 }),
  componente({ code: 'lomito', name: 'Lomito Jackpot', category: 'plato', unitPrice: 30, quantity: 2 }),
  componente({ code: 'porcion_papas', name: 'Porción de papa', category: 'extra', unitPrice: 10, quantity: 2 }),
];

describe('composición', () => {
  it('se deriva de los componentes reales, en su orden', () => {
    expect(composeSummary(COMBO)).toBe(
      '2× Soda Peque + 2× Lomito Jackpot + 2× Porción de papa',
    );
  });

  it('un combo de un solo producto se lee igual de bien', () => {
    expect(composeSummary([componente({ code: 'lomito', name: 'Lomito', quantity: 2 })])).toBe(
      '2× Lomito',
    );
  });

  it('sin componentes no inventa texto', () => {
    expect(composeSummary([])).toBe('');
  });
});

describe('vigencia', () => {
  // 02-09-2026, 20:00 en Bolivia = 03-09 00:00 UTC. La diferencia de día entre
  // ambas zonas es justo lo que rompería una etiqueta calculada en UTC.
  const AHORA = Date.parse('2026-09-03T00:00:00.000Z');

  it('sin vencimiento no devuelve etiqueta (ni un hueco)', () => {
    expect(expiryLabel(null, AHORA)).toBeNull();
  });

  it('mismo día boliviano: "Termina hoy" con la hora local', () => {
    // 02-09 23:31 Bolivia = 03-09 03:31 UTC.
    expect(expiryLabel('2026-09-03T03:31:00.000Z', AHORA)).toBe('Termina hoy 23:31');
  });

  it('día siguiente: "Termina mañana"', () => {
    // 03-09 23:31 Bolivia.
    expect(expiryLabel('2026-09-04T03:31:00.000Z', AHORA)).toBe('Termina mañana 23:31');
  });

  it('más allá: fecha corta en formato local', () => {
    // 06-09 23:31 Bolivia.
    expect(expiryLabel('2026-09-07T03:31:00.000Z', AHORA)).toBe('Hasta el 06/09');
  });

  it('cuenta por día de calendario, no por "faltan menos de 24 horas"', () => {
    // A las 23:00 del 2 en Bolivia, algo que vence a las 00:30 del 3 vence
    // MAÑANA aunque falte hora y media.
    const casiMedianoche = Date.parse('2026-09-03T03:00:00.000Z');
    expect(expiryLabel('2026-09-03T04:30:00.000Z', casiMedianoche)).toBe('Termina mañana 00:30');
  });

  it('una fecha ilegible no pinta nada en vez de "Invalid Date"', () => {
    expect(expiryLabel('cuando se acabe', AHORA)).toBeNull();
  });
});

describe('componente protagonista', () => {
  it('el plato gana a la bebida aunque la bebida vaya primero', () => {
    // El fallo real: un combo de lomitos ilustrado con una botella.
    expect(heroComponent(COMBO)?.code).toBe('lomito');
  });

  it('a igualdad de categoría manda el precio unitario', () => {
    const dos = [
      componente({ code: 'hamburguesa', unitPrice: 15 }),
      componente({ code: 'trancaburguer', unitPrice: 30 }),
    ];
    expect(heroComponent(dos)?.code).toBe('trancaburguer');
  });

  it('el extra gana a la bebida', () => {
    const sinPlato = COMBO.filter((c) => c.category !== 'plato');
    expect(heroComponent(sinPlato)?.code).toBe('porcion_papas');
  });

  it('a igualdad total desempata el código: la elección es determinista', () => {
    const empate = [
      componente({ code: 'zzz', unitPrice: 10 }),
      componente({ code: 'aaa', unitPrice: 10 }),
    ];
    expect(heroComponent(empate)?.code).toBe('aaa');
    // Y el orden de entrada no lo cambia.
    expect(heroComponent([...empate].reverse())?.code).toBe('aaa');
  });

  it('sin componentes no hay protagonista', () => {
    expect(heroComponent([])).toBeNull();
  });
});

describe('imagen', () => {
  it('la foto propia gana a todo', () => {
    expect(resolvePromotionImage('/promos/goleadora.webp', COMBO)).toEqual({
      kind: 'url',
      url: '/promos/goleadora.webp',
    });
  });

  it('sin foto propia cae al componente protagonista', () => {
    expect(resolvePromotionImage(null, COMBO)).toEqual({
      kind: 'component',
      code: 'lomito',
      category: 'plato',
    });
  });

  it('sin foto y sin componentes, placeholder', () => {
    expect(resolvePromotionImage(null, [])).toEqual({ kind: 'placeholder' });
  });

  it('una URL no permitida no se pinta: cae al componente', () => {
    expect(resolvePromotionImage('javascript:alert(1)', COMBO).kind).toBe('component');
  });

  describe('URLs admitidas', () => {
    it('acepta rutas propias y https', () => {
      expect(isAllowedImageUrl('/menu/lomito.webp')).toBe(true);
      expect(isAllowedImageUrl('https://cdn.ejemplo.com/a.webp')).toBe(true);
    });

    it('rechaza esquemas peligrosos, http sin cifrar y protocol-relative', () => {
      for (const url of [
        'javascript:alert(1)',
        'data:image/svg+xml,<svg onload=alert(1)>',
        'http://ejemplo.com/a.webp',
        '//ejemplo.com/a.webp',
        '',
        '   ',
      ]) {
        expect(isAllowedImageUrl(url), url).toBe(false);
      }
    });

    it('rechaza null y valores que no son texto', () => {
      expect(isAllowedImageUrl(null)).toBe(false);
    });
  });
});

describe('las fechas del panel son hora del negocio', () => {
  it('lo que se teclea se interpreta en Bolivia, no en el navegador', () => {
    // 23:31 bolivianas del 6 = 03:31 UTC del 7.
    expect(businessLocalToIso('2026-09-06T23:31')).toBe('2026-09-07T03:31:00.000Z');
  });

  it('ida y vuelta conserva lo que el encargado escribió', () => {
    const escrito = '2026-09-06T23:31';
    expect(isoToBusinessLocal(businessLocalToIso(escrito))).toBe(escrito);
  });

  it('el campo vacío es ausencia de fecha, no una fecha rara', () => {
    expect(businessLocalToIso('')).toBeNull();
    expect(businessLocalToIso('   ')).toBeNull();
    expect(businessLocalToIso(null)).toBeNull();
    expect(isoToBusinessLocal(null)).toBe('');
  });

  it('una fecha ilegible no se convierte en un instante inventado', () => {
    expect(businessLocalToIso('el viernes')).toBeNull();
    expect(isoToBusinessLocal('el viernes')).toBe('');
  });

  it('cruza el cambio de día sin perderlo', () => {
    // 00:30 bolivianas del 3 = 04:30 UTC del MISMO día 3.
    expect(businessLocalToIso('2026-09-03T00:30')).toBe('2026-09-03T04:30:00.000Z');
    expect(isoToBusinessLocal('2026-09-03T04:30:00.000Z')).toBe('2026-09-03T00:30');
  });
});
