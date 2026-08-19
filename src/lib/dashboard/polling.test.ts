import { describe, it, expect } from 'vitest';
import { createPollingController } from './polling';

function makeTimers() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    api: {
      setTimer: (cb: () => void) => {
        const id = ++seq;
        timers.set(id, cb);
        return id;
      },
      clearTimer: (h: unknown) => {
        timers.delete(h as number);
      },
    },
    count: () => timers.size,
    fire: () => {
      const entry = [...timers.entries()][0];
      if (!entry) return;
      timers.delete(entry[0]);
      entry[1]();
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('polling — sin duplicados ni solapamiento', () => {
  it('16. start() es idempotente: nunca crea dos temporizadores', () => {
    const t = makeTimers();
    let ticks = 0;
    const c = createPollingController({ intervalMs: 10_000, onTick: () => { ticks++; }, timers: t.api });
    c.start();
    c.start();
    c.start();
    expect(t.count()).toBe(1);
    expect(ticks).toBe(0);
  });

  it('serializa: un solo tick a la vez, reprograma tras completar', async () => {
    const t = makeTimers();
    let resolve!: () => void;
    let calls = 0;
    const c = createPollingController({
      intervalMs: 10_000,
      onTick: () => { calls++; return new Promise<void>((r) => { resolve = r; }); },
      timers: t.api,
    });
    c.start();
    t.fire();               // dispara el tick
    await flush();
    expect(calls).toBe(1);
    expect(t.count()).toBe(0); // no reprograma mientras el tick está en curso
    resolve();
    await flush();
    expect(t.count()).toBe(1); // reprograma solo tras completar
  });

  it('pausa cuando está inactivo: no llama onTick pero sigue reprogramando', async () => {
    const t = makeTimers();
    let calls = 0;
    let active = false;
    const c = createPollingController({
      intervalMs: 10_000,
      onTick: () => { calls++; },
      isActive: () => active,
      timers: t.api,
    });
    c.start();
    t.fire();
    await flush();
    expect(calls).toBe(0);
    expect(t.count()).toBe(1);
    active = true;
    t.fire();
    await flush();
    expect(calls).toBe(1);
  });

  it('stop() limpia el temporizador y detiene el bucle', () => {
    const t = makeTimers();
    const c = createPollingController({ intervalMs: 10_000, onTick: () => {}, timers: t.api });
    c.start();
    expect(c.isRunning()).toBe(true);
    c.stop();
    expect(c.isRunning()).toBe(false);
    expect(t.count()).toBe(0);
  });
});
