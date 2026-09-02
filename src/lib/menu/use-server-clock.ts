'use client';

import { useEffect, useState } from 'react';

/**
 * El reloj del SERVIDOR, avanzando en el navegador.
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 *
 * Las promociones y el aviso de horario se deciden con `serverNow`, un instante
 * que el Server Component captura al renderizar. Es lo correcto —el celular del
 * cliente puede tener la hora mal puesta— pero se queda congelado: una pestaña
 * abierta tres horas seguiría mostrando una promoción que venció hace dos, y el
 * cartel de "estamos abriendo" mucho después de haber abierto.
 *
 * ── La solución, y por qué no es leer el reloj local ────────────────────────
 *
 * Se conserva la hora del servidor como ANCLA y se le suma el TIEMPO
 * TRANSCURRIDO desde que llegó. Son dos cosas muy distintas: la fecha absoluta
 * del navegador puede estar equivocada por años, pero cuánto rato lleva abierta
 * la página es un dato fiable aunque el reloj esté mal.
 *
 * Y el transcurso se mide con `performance.now()`, no con `Date.now()`, porque
 * es MONOTÓNICO: cuenta desde que cargó la página y no se ve afectado si el
 * sistema operativo ajusta la hora a mitad —un cambio de huso, una sincronía
 * con NTP, alguien tocando el reloj—. Con `Date.now()` ese ajuste se sumaría
 * como si hubiera pasado el tiempo, y una promoción podría vencer de golpe.
 *
 * ── Lo que este reloj NO hace ───────────────────────────────────────────────
 *
 * No autoriza nada. Decide qué se PINTA; lo que se cobra lo decide `now()` de
 * PostgreSQL dentro de la transacción del pedido. Si los dos discreparan, manda
 * la base y el cliente ve un rechazo con su motivo.
 */
export function useServerClock(serverNow: number, tickMs = 30_000): number {
  // El primer render devuelve EXACTAMENTE `serverNow`, igual que el servidor:
  // si aquí se leyera el reloj, la hidratación no coincidiría.
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    // El ancla se fija en el closure y no en un ref: el efecto ya se vuelve a
    // ejecutar si `serverNow` cambia, así que cada ejecución tiene la suya y no
    // hace falta un estado mutable que mantener en sincronía.
    const ancla = { server: serverNow, perf: performance.now() };

    // Solo se escribe estado desde un callback —el temporizador o el evento—,
    // nunca de forma síncrona al montar: el valor inicial ya es el correcto.
    const recalcular = () => setNow(ancla.server + (performance.now() - ancla.perf));

    const id = setInterval(recalcular, tickMs);

    // Al volver a la pestaña se recalcula sin esperar al siguiente tick: los
    // navegadores frenan los temporizadores en segundo plano, así que alguien
    // que vuelve tras una hora vería la hora de hace una hora hasta el próximo
    // intervalo. `performance.now()` sí siguió corriendo, así que el salto se
    // recupera entero.
    document.addEventListener('visibilitychange', recalcular);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', recalcular);
    };
  }, [serverNow, tickMs]);

  return now;
}
