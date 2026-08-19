import { describe, it, expect } from 'vitest';
import {
  createTurnMediaBudget,
  imageIsProcessable,
  transientCandidates,
  DEFAULT_TURN_MEDIA_LIMITS,
  MEDIA_MAX_BYTES,
  MEDIA_TIMEOUT_MS,
  type MediaResolverPort,
  type ResolveImageResult,
  type TurnMediaLimits,
} from './media';
import { parseImage, type ImageAttachment } from '@/lib/kapso/channel/image';
import {
  imageNoCaptionEnvelope,
  KAPSO_MEDIA_URL,
  META_LOOKASIDE_URL,
} from '@/lib/kapso/channel/image.fixtures';

/**
 * PUERTO DE MEDIA (Fase 6D.2F.5C.5).
 *
 * La política se prueba aquí, sin red: qué se descarga, qué se rechaza y en qué
 * orden se intentan las referencias. El adaptador real solo añade el `fetch`.
 */

function adjunto(over: Partial<ImageAttachment['facts']> = {}): ImageAttachment {
  const base = parseImage(imageNoCaptionEnvelope().message as Record<string, unknown>)!;
  return { ...base, facts: { ...base.facts, ...over } };
}

describe('media — qué merece intentarse', () => {
  it('20 · una foto normal es procesable', () => {
    expect(imageIsProcessable(adjunto())).toEqual({ ok: true });
  });

  it('23 · MIME no soportado: fail closed sin tocar la red', () => {
    expect(imageIsProcessable(adjunto({ mimeType: 'image/svg+xml' }))).toEqual({
      ok: false,
      error: 'unsupported_mime',
    });
    expect(imageIsProcessable(adjunto({ mimeType: 'application/pdf' }))).toEqual({
      ok: false,
      error: 'unsupported_mime',
    });
  });

  it('23b · sin MIME declarado tampoco se descarga', () => {
    // Adivinar el tipo de un binario que va a viajar a un modelo multimodal es
    // exactamente lo que no queremos.
    expect(imageIsProcessable(adjunto({ mimeType: null }))).toEqual({
      ok: false,
      error: 'unsupported_mime',
    });
  });

  it('24 · por encima del tope declarado: too_large', () => {
    expect(imageIsProcessable(adjunto({ byteSize: MEDIA_MAX_BYTES + 1 }))).toEqual({
      ok: false,
      error: 'too_large',
    });
    // Justo en el tope sí pasa.
    expect(imageIsProcessable(adjunto({ byteSize: MEDIA_MAX_BYTES }))).toEqual({ ok: true });
  });

  it('un tamaño no declarado no bloquea: lo corta la descarga real', () => {
    expect(imageIsProcessable(adjunto({ byteSize: null }))).toEqual({ ok: true });
  });
});

describe('media — orden de las referencias transitorias', () => {
  it('kapso primero, lookaside de Meta al final', () => {
    const candidatos = transientCandidates(adjunto());

    expect(candidatos.map((c) => c.source)).toEqual(['transient_kapso', 'transient_meta']);
    expect(candidatos[0].url).toBe(KAPSO_MEDIA_URL);
    expect(candidatos[1].url).toBe(META_LOOKASIDE_URL);
  });

  it('no repite la misma URL por venir en dos campos', () => {
    // En el contrato real `image.link` y `kapso.media_url` coinciden.
    const candidatos = transientCandidates(adjunto());
    const urls = candidatos.map((c) => c.url);

    expect(new Set(urls).size).toBe(urls.length);
  });

  it('sin ninguna referencia no hay nada que intentar', () => {
    const sinUrls: ImageAttachment = {
      ...adjunto(),
      transient: { kapsoMediaUrl: null, link: null, metaUrl: null },
    };

    expect(transientCandidates(sinUrls)).toEqual([]);
  });
});

// ── Presupuesto multimodal del turno ───────────────────────────────────────

/** Reloj manual: el presupuesto solo avanza cuando el test lo dice. */
function reloj(inicio = 1_000_000) {
  let t = inicio;
  return { now: () => t, avanzar: (ms: number) => { t += ms; } };
}

const MB = 1024 * 1024;

describe('media — presupuesto del turno', () => {
  it('los valores por defecto son los conservadores acordados', () => {
    expect(DEFAULT_TURN_MEDIA_LIMITS).toEqual({
      maxImages: 3,
      maxTotalBytes: 12 * MB,
      maxTotalMs: 12_000,
      maxPerImageMs: MEDIA_TIMEOUT_MS,
    });
  });

  it('una imagen normal entra y recibe el techo individual', () => {
    const budget = createTurnMediaBudget({ now: reloj().now });

    const sitio = budget.admit(70_332);

    expect(sitio).toEqual({ ok: true, timeoutMs: MEDIA_TIMEOUT_MS });
    expect(budget.account(70_332)).toEqual({ ok: true });
    expect(budget.totalBytes()).toBe(70_332);
  });

  it('demasiadas imágenes: las que sobran NO se intentan', () => {
    const budget = createTurnMediaBudget({ now: reloj().now });

    for (let i = 0; i < 3; i += 1) expect(budget.admit(1000).ok, `#${i}`).toBe(true);

    expect(budget.admit(1000)).toEqual({ ok: false, error: 'too_many_images' });
    expect(budget.admit(1000)).toEqual({ ok: false, error: 'too_many_images' });
  });

  it('un intento FALLIDO también gasta plaza', () => {
    // Es lo conservador: un fallo consumió red y tiempo igual que un éxito.
    const budget = createTurnMediaBudget({ now: reloj().now });

    budget.admit(1000); // se intentó y (supongamos) falló: no se contabiliza
    budget.admit(1000);
    budget.admit(1000);

    expect(budget.admit(1000)).toEqual({ ok: false, error: 'too_many_images' });
    expect(budget.totalBytes()).toBe(0);
  });

  it('el TOTAL de bytes corta aunque cada imagen sea válida por separado', () => {
    // 3 × 5 MB: ninguna pasa de los 8 MB individuales, pero juntas sí de 12 MB.
    const budget = createTurnMediaBudget({ now: reloj().now });

    expect(budget.admit(5 * MB).ok).toBe(true);
    expect(budget.account(5 * MB)).toEqual({ ok: true });
    expect(budget.admit(5 * MB).ok).toBe(true);
    expect(budget.account(5 * MB)).toEqual({ ok: true });

    // La tercera ni se descarga: se sabe por el tamaño declarado.
    expect(budget.admit(5 * MB)).toEqual({ ok: false, error: 'turn_bytes_exceeded' });
  });

  it('EXACTAMENTE en el límite sí entra', () => {
    const budget = createTurnMediaBudget({ now: reloj().now });

    expect(budget.admit(6 * MB).ok).toBe(true);
    expect(budget.account(6 * MB)).toEqual({ ok: true });
    expect(budget.admit(6 * MB).ok).toBe(true);
    expect(budget.account(6 * MB)).toEqual({ ok: true });
    expect(budget.totalBytes()).toBe(12 * MB);
  });

  it('sin tamaño declarado se deja intentar, y cortan los bytes REALES', () => {
    const budget = createTurnMediaBudget({ now: reloj().now });

    expect(budget.admit(null).ok).toBe(true);
    // El servidor mintió: llegó más de lo que cabía en el turno entero.
    expect(budget.account(13 * MB)).toEqual({ ok: false, error: 'turn_bytes_exceeded' });
    // Y no se contabiliza lo que se descartó.
    expect(budget.totalBytes()).toBe(0);
  });

  it('el tiempo se REPARTE: cada descarga recibe lo que queda, no el techo', () => {
    const r = reloj();
    const budget = createTurnMediaBudget({ now: r.now });

    expect(budget.admit(1000)).toEqual({ ok: true, timeoutMs: 8_000 });
    r.avanzar(7_000); // la primera tardó 7 s
    // Quedan 5 s del turno: la segunda no puede pedir 8.
    expect(budget.admit(1000)).toEqual({ ok: true, timeoutMs: 5_000 });
    r.avanzar(4_000);
    expect(budget.admit(1000)).toEqual({ ok: true, timeoutMs: 1_000 });
  });

  it('agotado el presupuesto, lo que queda es explícito y no toca la red', () => {
    const r = reloj();
    const budget = createTurnMediaBudget({ now: r.now });

    budget.admit(1000);
    r.avanzar(12_000);

    expect(budget.admit(1000)).toEqual({ ok: false, error: 'turn_budget_exhausted' });
  });

  it('los límites se pueden estrechar sin tocar el resto', () => {
    const estrecho: TurnMediaLimits = {
      maxImages: 1,
      maxTotalBytes: 1024,
      maxTotalMs: 500,
      maxPerImageMs: 400,
    };
    const budget = createTurnMediaBudget({ limits: estrecho, now: reloj().now });

    expect(budget.admit(512)).toEqual({ ok: true, timeoutMs: 400 });
    expect(budget.admit(512)).toEqual({ ok: false, error: 'too_many_images' });
  });
});

// ── Dobles del puerto, para los tests del turno ────────────────────────────

/** Resolver que siempre funciona. */
export function fakeResolver(dataUrl = 'data:image/jpeg;base64,AAAA'): MediaResolverPort & {
  calls: number;
} {
  const port = {
    calls: 0,
    async resolveImage(): Promise<ResolveImageResult> {
      port.calls += 1;
      return { ok: true, dataUrl, source: 'transient_kapso', byteSize: 3, mimeType: 'image/jpeg' };
    },
  };
  return port;
}

describe('media — dobles del puerto', () => {
  it('21/22 · un fallo del resolver es un resultado tipado, no una excepción', async () => {
    const timeout: MediaResolverPort = {
      async resolveImage(): Promise<ResolveImageResult> {
        return { ok: false, error: 'timeout' };
      },
    };
    const caido: MediaResolverPort = {
      async resolveImage(): Promise<ResolveImageResult> {
        return { ok: false, error: 'unavailable' };
      },
    };

    await expect(timeout.resolveImage(adjunto(), null)).resolves.toEqual({
      ok: false,
      error: 'timeout',
    });
    await expect(caido.resolveImage(adjunto(), null)).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
  });
});
