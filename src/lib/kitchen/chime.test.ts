import { describe, it, expect, afterEach } from 'vitest';
import { createChime } from './chime';

// ── Doble mínimo de Web Audio ───────────────────────────────────────────────
// Solo registra lo que se programa: cuántos osciladores, a qué frecuencia y en
// qué instante arrancan. Suficiente para probar la LÓGICA del aviso (que suena
// una vez, que respeta el bloqueo del navegador) sin depender del audio real.

interface Programado {
  frequency: number;
  startedAt: number;
}

class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class FakeAudioContext {
  static ultima: FakeAudioContext | null = null;

  state: 'running' | 'suspended' | 'closed';
  currentTime = 0;
  destination = {};
  programados: Programado[] = [];
  resumes = 0;
  cerrado = false;

  constructor(estadoInicial: 'running' | 'suspended' = 'running') {
    this.state = estadoInicial;
    FakeAudioContext.ultima = this;
  }

  createOscillator() {
    const programados = this.programados;
    const osc = {
      type: 'sine',
      frequency: { value: 0 },
      connect: (n: unknown) => n,
      start: (at: number) => {
        programados.push({ frequency: osc.frequency.value, startedAt: at });
      },
      stop: () => {},
    };
    return osc;
  }

  createGain() {
    return { gain: new FakeParam(), connect: (n: unknown) => n };
  }

  resume() {
    this.resumes += 1;
    // Como el de verdad: el estado cambia al RESOLVERSE, no al pedirlo.
    return Promise.resolve().then(() => {
      this.state = 'running';
    });
  }

  close() {
    this.cerrado = true;
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** Instala un `window` con Web Audio en el entorno `node` de los tests. */
function instalarWindow(estadoInicial: 'running' | 'suspended' = 'running'): void {
  FakeAudioContext.ultima = null;
  const ctor = function () {
    return new FakeAudioContext(estadoInicial);
  } as unknown as typeof AudioContext;
  (globalThis as { window?: unknown }).window = { AudioContext: ctor };
}

function desinstalarWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

afterEach(desinstalarWindow);

describe('campana de cocina', () => {
  it('sin Web Audio no hay campana, pero tampoco excepcion', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(createChime()).toBeNull();
  });

  it('no crea el contexto de audio hasta el primer uso', () => {
    instalarWindow();
    createChime();
    expect(FakeAudioContext.ultima).toBeNull();
  });

  it('un toque programa dos golpes con parciales inarmonicos', () => {
    instalarWindow();
    const chime = createChime();
    chime?.ring();

    const ctx = FakeAudioContext.ultima;
    expect(ctx).not.toBeNull();
    const instantes = [...new Set(ctx!.programados.map((p) => p.startedAt))];
    expect(instantes).toHaveLength(2); // dos golpes: un aviso, no un pitido

    const delPrimerGolpe = ctx!.programados.filter((p) => p.startedAt === instantes[0]);
    expect(delPrimerGolpe.length).toBeGreaterThan(1); // varios parciales, no una nota
    // El parcial mas grave es la fundamental y el resto NO son sus armonicos
    // enteros: eso es lo que suena a metal golpeado y no a alarma.
    const graves = delPrimerGolpe.map((p) => p.frequency).sort((a, b) => a - b);
    expect(graves[0]).toBeGreaterThan(0);
    expect(graves.some((f) => !Number.isInteger(f / graves[0]))).toBe(true);
  });

  it('con el audio parado por el navegador, se pide despertarlo', async () => {
    instalarWindow('suspended');
    const chime = createChime();
    chime?.ring();

    const ctx = FakeAudioContext.ultima!;
    expect(chime?.isBlocked()).toBe(true);
    expect(ctx.resumes).toBe(1);
    // Nada suena hasta que el navegador cede...
    expect(ctx.programados).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    // ...y en cuanto cede, el aviso sale igual.
    expect(ctx.programados.length).toBeGreaterThan(0);
    expect(chime?.isBlocked()).toBe(false);
  });

  it('`unlock` despierta el audio sin hacer ruido', () => {
    instalarWindow('suspended');
    const chime = createChime();
    chime?.unlock();

    const ctx = FakeAudioContext.ultima!;
    expect(ctx.resumes).toBe(1);
    expect(ctx.programados).toHaveLength(0);
  });

  it('cerrar suelta el contexto y deja de estar bloqueada', () => {
    instalarWindow('suspended');
    const chime = createChime();
    chime?.unlock();
    const ctx = FakeAudioContext.ultima!;
    chime?.close();
    expect(ctx.cerrado).toBe(true);
    expect(chime?.isBlocked()).toBe(false);
  });
});
