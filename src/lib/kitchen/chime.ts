'use client';

/**
 * Campana del tablero de cocina.
 *
 * Suena cuando entra un pedido nuevo. La cocina no mira la pantalla: mira la
 * plancha. Un ticket que aparece en silencio puede pasar varios minutos sin que
 * nadie lo vea, y esos minutos se los come el cliente que espera.
 *
 * ── Por que se sintetiza y no se carga un archivo ───────────────────────────
 *
 * No hay `.mp3` que descargar, ni un asset mas que se pueda quedar a medias con
 * la tablet en una red mala. El sonido se construye con osciladores en el
 * momento: pesa cero, suena igual el primer dia que el dia sin internet, y el
 * timbre se ajusta cambiando numeros en vez de reemplazando un binario.
 *
 * ── Por que estos parciales y no un pitido ──────────────────────────────────
 *
 * Una campana no es una nota: es una fundamental con parciales que NO son sus
 * armonicos y que se apagan antes que ella. Esa inarmonicidad es justo lo que
 * el oido reconoce como metal golpeado, y lo que hace que se distinga del ruido
 * de la freidora y de cualquier notificacion de telefono que suene al lado.
 */

/** Fundamental del golpe (Sol5). Agudo para abrirse paso sobre el ruido. */
const FUNDAMENTAL_HZ = 784;

/**
 * Parciales del golpe: proporcion sobre la fundamental, peso en la mezcla y
 * cuanto tarda en apagarse. Los agudos duran menos —igual que en una campana
 * real— y por eso el sonido "brilla" al principio y se queda en un tono limpio.
 */
const PARTIALS: ReadonlyArray<{ ratio: number; gain: number; decaySec: number }> = [
  { ratio: 1, gain: 1, decaySec: 1.7 },
  { ratio: 2.0, gain: 0.5, decaySec: 1.15 },
  { ratio: 2.76, gain: 0.28, decaySec: 0.7 },
  { ratio: 5.4, gain: 0.12, decaySec: 0.32 },
];

/** Volumen general. Audible en cocina, no un susto a un metro de la tablet. */
const MASTER_GAIN = 0.32;
/** Separacion del segundo golpe: dos toques se reconocen como aviso, uno no. */
const SECOND_STRIKE_SEC = 0.42;
/** El segundo golpe va mas suave, como un rebote del badajo. */
const SECOND_STRIKE_LEVEL = 0.7;
/** Ataque casi instantaneo: un golpe, no un fundido. */
const ATTACK_SEC = 0.004;

export interface Chime {
  /** Toca la campana. Si el navegador aun no lo permite, no hace nada. */
  ring(): void;
  /** Despierta el audio aprovechando un gesto del usuario. */
  unlock(): void;
  /** ¿El navegador tiene el audio parado por falta de interaccion? */
  isBlocked(): boolean;
  /** Suelta el contexto de audio (al desmontar la pantalla). */
  close(): void;
}

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  // Safari antiguo —el de varias tablets baratas— solo trae el prefijado.
  const w = window as typeof window & { webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Programa UN golpe de campana en el instante `at` del reloj del contexto. */
function strike(ctx: AudioContext, out: GainNode, at: number, level: number): void {
  for (const partial of PARTIALS) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = FUNDAMENTAL_HZ * partial.ratio;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(partial.gain * level, at + ATTACK_SEC);
    // Exponencial: asi se apaga una campana, y asi no deja el "clic" que deja
    // un corte recto. Nunca llega a 0 porque la rampa exponencial lo prohibe.
    env.gain.exponentialRampToValueAtTime(0.0001, at + partial.decaySec);

    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + partial.decaySec + 0.05);
  }
}

/**
 * Crea la campana. Devuelve `null` donde no hay Web Audio (servidor, navegador
 * muy viejo): quien llama simplemente se queda sin sonido, nunca sin tablero.
 *
 * El contexto de audio se crea en el primer uso, no aqui: crearlo durante la
 * carga de la pagina es lo que hace que algunos navegadores lo dejen marcado
 * como bloqueado hasta recargar.
 */
export function createChime(): Chime | null {
  const Ctor = audioContextCtor();
  if (Ctor === null) return null;

  let ctx: AudioContext | null = null;

  function ensure(): AudioContext | null {
    if (ctx !== null) return ctx;
    try {
      ctx = new Ctor!();
      return ctx;
    } catch {
      // Sin audio disponible: el tablero sigue funcionando igual.
      return null;
    }
  }

  function schedule(active: AudioContext): void {
    const master = active.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(active.destination);
    const at = active.currentTime;
    strike(active, master, at, 1);
    strike(active, master, at + SECOND_STRIKE_SEC, SECOND_STRIKE_LEVEL);
  }

  return {
    ring() {
      const active = ensure();
      if (active === null) return;
      if (active.state === 'running') {
        schedule(active);
        return;
      }
      // Parado por politica de autoplay: se intenta despertar y, si el
      // navegador cede, el aviso sale con unos milisegundos de retraso. Si no
      // cede, no suena — y `isBlocked()` deja avisar por pantalla.
      void active
        .resume()
        .then(() => {
          if (active.state === 'running') schedule(active);
        })
        .catch(() => {});
    },
    unlock() {
      const active = ensure();
      if (active === null || active.state === 'running') return;
      void active.resume().catch(() => {});
    },
    isBlocked() {
      return ctx !== null && ctx.state !== 'running';
    },
    close() {
      const active = ctx;
      ctx = null;
      if (active === null) return;
      void active.close().catch(() => {});
    },
  };
}
