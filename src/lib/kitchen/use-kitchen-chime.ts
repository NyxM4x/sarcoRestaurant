'use client';

/**
 * Hook del aviso sonoro del KDS: une la deteccion pura de llegadas
 * (`./arrivals`) con la campana (`./chime`).
 *
 * ── La primera carga no suena ───────────────────────────────────────────────
 *
 * Al abrir el tablero ya hay pedidos en pantalla, y ninguno acaba de llegar.
 * Por eso el primer ciclo solo SIEMBRA lo conocido: si sonara, la campana
 * significaria "acabas de abrir la pantalla" en vez de "hay un pedido nuevo".
 *
 * ── El navegador manda sobre el autoplay ────────────────────────────────────
 *
 * Ningun navegador deja sonar una pagina que el usuario todavia no ha tocado.
 * No es un fallo que se pueda esquivar: se aprovecha el primer toque en la
 * pantalla para despertar el audio, y mientras siga bloqueado se avisa por
 * pantalla — un aviso silencioso que nadie sabe que esta mudo es peor que no
 * tenerlo.
 *
 * ── La preferencia vive en `localStorage`, como el carrito ──────────────────
 *
 * Se lee con `useSyncExternalStore` y no con `useState` + `useEffect`: el
 * snapshot del servidor es siempre "encendido", identico al primer render del
 * cliente, asi que no hay desajuste de hidratacion. Si el almacenamiento esta
 * bloqueado se usa una copia en memoria y la preferencia dura la sesion.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { detectArrivals } from './arrivals';
import { createChime, type Chime } from './chime';
import type { KitchenTicket } from './ticket-view';

/** Clave de `localStorage`. Versionada por si cambia lo que se guarda. */
export const KITCHEN_SOUND_KEY = 'dz.kds.sound.v1';
const OFF = 'off';
const ON = 'on';

// ── Almacen externo sobre localStorage ──────────────────────────────────────

const listeners = new Set<() => void>();

/** Copia en memoria: unica fuente si `localStorage` falla. */
let memoryRaw: string | null = null;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(KITCHEN_SOUND_KEY);
  } catch {
    return memoryRaw;
  }
}

function writeRaw(raw: string): void {
  memoryRaw = raw;
  try {
    window.localStorage.setItem(KITCHEN_SOUND_KEY, raw);
  } catch {
    // Sin persistencia: seguimos con `memoryRaw`.
  }
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  // Si hay dos pantallas de cocina abiertas, silenciar en una silencia la otra.
  window.addEventListener('storage', onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

/** Sin valor guardado el aviso va ENCENDIDO: es la razon de que exista. */
const serverRaw = () => null;

export interface KitchenChime {
  /** ¿Esta activado el aviso sonoro? */
  soundOn: boolean;
  /** Enciende o apaga el aviso (y guarda la preferencia). */
  toggleSound: () => void;
  /**
   * El aviso esta encendido pero el navegador aun no deja sonar. Sirve para
   * pedirle al cocinero que toque la pantalla una vez.
   */
  soundBlocked: boolean;
}

/**
 * Hace sonar la campana cuando aparece un pedido en etapa `new` que no estaba
 * en el ciclo anterior de polling.
 */
export function useKitchenChime(tickets: KitchenTicket[]): KitchenChime {
  const soundOn = useSyncExternalStore(subscribe, readRaw, serverRaw) !== OFF;
  const [soundBlocked, setSoundBlocked] = useState(false);

  const chimeRef = useRef<Chime | null>(null);
  /** Pedidos del ciclo anterior. `null` = todavia no se sembro. */
  const knownRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    chimeRef.current = createChime();
    return () => {
      chimeRef.current?.close();
      chimeRef.current = null;
    };
  }, []);

  /**
   * Revisa si el navegador sigue con el audio parado, un momento DESPUES de
   * haberlo intentado: `resume()` es asincrono, y preguntar de inmediato
   * pintaria el aviso de "toca la pantalla" cada vez que suena la campana.
   */
  const revisarBloqueo = useCallback(() => {
    window.setTimeout(() => setSoundBlocked(chimeRef.current?.isBlocked() ?? false), 400);
  }, []);

  // El primer toque en la pantalla despierta el audio. Se escucha en captura y
  // una sola vez: no interfiere con ningun boton del tablero.
  useEffect(() => {
    const despertar = () => {
      chimeRef.current?.unlock();
      revisarBloqueo();
    };
    const opts = { capture: true, once: true } as const;
    document.addEventListener('pointerdown', despertar, opts);
    document.addEventListener('keydown', despertar, opts);
    return () => {
      document.removeEventListener('pointerdown', despertar, opts);
      document.removeEventListener('keydown', despertar, opts);
    };
  }, [revisarBloqueo]);

  useEffect(() => {
    const primeraVez = knownRef.current === null;
    const { arrivals, known } = detectArrivals(knownRef.current ?? new Set(), tickets);
    knownRef.current = known;
    if (primeraVez || arrivals.length === 0) return;
    if (!soundOn) return;
    // Varias llegadas en el mismo ciclo son UN aviso: la campana dice "mira la
    // pantalla", y la pantalla ya dice cuantos son.
    chimeRef.current?.ring();
    revisarBloqueo();
  }, [revisarBloqueo, soundOn, tickets]);

  const toggleSound = useCallback(() => {
    const next = !soundOn;
    writeRaw(next ? ON : OFF);
    if (!next) {
      setSoundBlocked(false);
      return;
    }
    // El propio toque del boton sirve de gesto: se aprovecha para despertar el
    // audio y para que se OIGA que quedo encendido.
    chimeRef.current?.ring();
    revisarBloqueo();
  }, [revisarBloqueo, soundOn]);

  return { soundOn, toggleSound, soundBlocked };
}
