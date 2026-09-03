import { describe, it, expect } from 'vitest';
import {
  buildQuoteCtaText,
  buildQuoteText,
  hasQuoteQuota,
  isSamePoint,
  metersBetween,
  QUOTE_FAILED_CTA_TEXT,
  QUOTE_FAILED_TEXT,
  QUOTE_OUT_OF_COVERAGE_TEXT,
  QUOTE_OVER_LIMIT_CTA_TEXT,
  QUOTE_OVER_LIMIT_TEXT,
  QUOTE_REUSE_TOLERANCE_METERS,
  STANDALONE_QUOTE_LIMIT,
  STANDALONE_QUOTE_WINDOW_HOURS,
} from './quote-request';
import { DELIVERY_TIERS } from './fee';

/** El pin real del reporte del 29-08-2026, Santa Cruz. */
const PIN = { lat: -17.842781066895, lng: -63.17911529541 };

/** Mueve un punto N metros hacia el norte. 1° de latitud ≈ 111.320 m. */
function masAlNorte(desde: { lat: number; lng: number }, metros: number) {
  return { lat: desde.lat + metros / 111_320, lng: desde.lng };
}

describe('quote-request — cuándo dos pines son el mismo sitio', () => {
  it('el mismo punto está a cero metros de sí mismo', () => {
    expect(metersBetween(PIN, PIN)).toBeCloseTo(0, 6);
  });

  it('mide en metros de verdad, no en grados', () => {
    // 100 m al norte tienen que salir 100 m, no 0.0009.
    expect(metersBetween(PIN, masAlNorte(PIN, 100))).toBeCloseTo(100, 0);
  });

  it('el temblor del GPS sigue siendo el mismo sitio', () => {
    // Es el caso que hace útil el reuso: la misma persona, sin moverse, manda
    // "ubicación actual" dos veces y las coordenadas no coinciden.
    expect(isSamePoint(PIN, masAlNorte(PIN, 8))).toBe(true);
  });

  it('media cuadra ya no lo es', () => {
    expect(isSamePoint(PIN, masAlNorte(PIN, 50))).toBe(false);
  });

  it('la tolerancia es MUCHO menor que un tramo del tarifario', () => {
    // De esto depende que reutilizar una medición no cambie el precio. El tramo
    // más estrecho de la tabla mide un kilómetro; la tolerancia, diez metros.
    const tramoMasEstrecho = DELIVERY_TIERS.reduce((min, tier, i) => {
      const suelo = i === 0 ? 0 : DELIVERY_TIERS[i - 1].maxMeters;
      return Math.min(min, tier.maxMeters - suelo);
    }, Infinity);

    expect(QUOTE_REUSE_TOLERANCE_METERS * 10).toBeLessThan(tramoMasEstrecho);
  });

  it('una coordenada corrupta nunca se parece al mismo punto', () => {
    // Fail-closed: ante una fila ilegible se mide de nuevo, no se reutiliza a
    // ciegas una distancia que podría ser de cualquier sitio.
    expect(metersBetween(PIN, { lat: NaN, lng: PIN.lng })).toBe(Infinity);
    expect(isSamePoint(PIN, { lat: NaN, lng: PIN.lng })).toBe(false);
    expect(isSamePoint(PIN, { lat: Infinity, lng: PIN.lng })).toBe(false);
  });
});

describe('quote-request — el cupo', () => {
  it('deja pasar hasta el límite y no más', () => {
    expect(hasQuoteQuota(0)).toBe(true);
    expect(hasQuoteQuota(STANDALONE_QUOTE_LIMIT - 1)).toBe(true);
    expect(hasQuoteQuota(STANDALONE_QUOTE_LIMIT)).toBe(false);
    expect(hasQuoteQuota(STANDALONE_QUOTE_LIMIT + 5)).toBe(false);
  });

  it('la ventana cubre una jornada de servicio entera', () => {
    // Don Zarco abre de 18:00 a 04:00: diez horas. Con una ventana más corta, el
    // cupo se reiniciaría a mitad del servicio y no significaría nada.
    expect(STANDALONE_QUOTE_WINDOW_HOURS).toBeGreaterThanOrEqual(10);
  });
});

describe('quote-request — lo que se le dice al cliente', () => {
  it('la cotización lleva el importe y adónde ir después', () => {
    const texto = buildQuoteText(15);
    expect(texto).toContain('Bs 15');
    expect(texto).toContain('menú');
  });

  it('no arrastra decimales que nadie escribe', () => {
    expect(buildQuoteText(15)).toContain('Bs 15');
    expect(buildQuoteText(15)).not.toContain('15.00');
    expect(buildQuoteText(12.5)).toContain('Bs 12.50');
  });

  it('la cotización NO da por hecho un pedido ni promete un plazo', () => {
    // Es la respuesta a una pregunta, no una confirmación: quien preguntó
    // cuánto sale el envío todavía no ha pedido nada. Invitar a armarlo ("armá
    // tu pedido") es justo lo contrario de afirmar que ya existe, así que lo
    // que se vigila es el tiempo verbal, no la palabra.
    const texto = buildQuoteText(20);
    expect(texto).not.toMatch(/tu pedido (ya|est[áa]|qued[óo]|fue)/i);
    expect(texto).not.toMatch(/confirmad|registrad|anotad/i);
    // Y no inventa un tiempo de entrega, que es el dato que nadie tiene.
    expect(texto).not.toMatch(/minutos|llega en|demora|enseguida/i);
  });

  it('no publica la distancia', () => {
    // Los kilómetros son un dato nuestro: publicarlos solo invita a discutir la
    // ruta que midió Mapbox.
    for (const texto of [buildQuoteText(15), QUOTE_OUT_OF_COVERAGE_TEXT]) {
      expect(texto).not.toMatch(/\bkm\b|kilómetro|metros/i);
    }
  });

  it('el texto de cupo agotado no acusa ni habla de límites', () => {
    // Un cliente no tiene por qué enterarse de que existe un contador.
    expect(QUOTE_OVER_LIMIT_TEXT).not.toMatch(/l[ií]mite|demasiad|otra vez|ya te/i);
    // Y sigue siendo útil: lo manda por el camino que además termina en pedido.
    expect(QUOTE_OVER_LIMIT_TEXT).toContain('menú');
  });

  it('los cuatro desenlaces tienen texto: ninguno cae en el silencio', () => {
    // Es la razón de ser de todo esto. Un cliente que manda su ubicación y no
    // recibe nada es exactamente el fallo que se está arreglando.
    for (const texto of [
      buildQuoteText(10),
      QUOTE_OUT_OF_COVERAGE_TEXT,
      QUOTE_OVER_LIMIT_TEXT,
      QUOTE_FAILED_TEXT,
    ]) {
      expect(texto.trim()).not.toBe('');
    }
  });

  it('fuera de cobertura no habla de un pedido que todavía no existe', () => {
    expect(QUOTE_OUT_OF_COVERAGE_TEXT).not.toMatch(/tu pedido/i);
  });
});

describe('quote-request — la versión que va CON el botón (03-09-2026)', () => {
  it('la cifra es la misma en las dos versiones', () => {
    // El precio se compone en un solo sitio. Dos plantillas con la misma cifra
    // son dos plantillas que un día dirán cosas distintas.
    for (const monto of [15, 12.5, 20]) {
      expect(buildQuoteCtaText(monto)).toContain(buildQuoteText(monto).split('🛵')[0]);
    }
  });

  it('la del botón señala el botón; la plana NO promete ninguno', () => {
    // El fallback existe para cuando el CTA no salió. Decirle "acá 👇" a quien
    // solo recibió texto sería señalar un botón que no llegó — la misma clase
    // de promesa falsa que este código lleva meses cerrando.
    expect(buildQuoteCtaText(15)).toContain('👇');
    expect(QUOTE_OVER_LIMIT_CTA_TEXT).toContain('👇');
    expect(QUOTE_FAILED_CTA_TEXT).toContain('👇');

    for (const plano of [buildQuoteText(15), QUOTE_OVER_LIMIT_TEXT, QUOTE_FAILED_TEXT]) {
      expect(plano).not.toContain('👇');
    }
  });

  it('las tres versiones con botón siguen sin prometer un plazo', () => {
    // La regla de siempre: lo que se cotiza es el COSTO, nunca el TIEMPO.
    for (const texto of [buildQuoteCtaText(15), QUOTE_OVER_LIMIT_CTA_TEXT, QUOTE_FAILED_CTA_TEXT]) {
      expect(texto).not.toMatch(/minutos|llega en|demora|enseguida/i);
    }
  });

  it('el de cupo agotado con botón sigue sin acusar', () => {
    // Es al que MÁS falta le hacía: se le niega la cifra que pidió y se le
    // manda al menú a cambio. Mandarlo sin el menú convertía la única salida
    // que se le ofrecía en una frase.
    expect(QUOTE_OVER_LIMIT_CTA_TEXT).not.toMatch(/l[ií]mite|demasiad|otra vez|ya te/i);
  });

  it('fuera de cobertura NO tiene versión con botón, y es a propósito', () => {
    // A ese cliente no se le está pidiendo que arme nada: se le está diciendo
    // que no llegamos. Ofrecerle el menú después sería contradecirse en el
    // mismo mensaje.
    expect(QUOTE_OUT_OF_COVERAGE_TEXT).not.toContain('👇');
  });
});
