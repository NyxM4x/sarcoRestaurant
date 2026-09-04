'use client';

import { serviceNoticeAt } from '@/lib/menu/service-hours';
import { useServerClock } from '@/lib/menu/use-server-clock';

/**
 * Aviso de horario, encima del catálogo.
 *
 * Solo se pinta en las cuatro franjas que decide `serviceNoticeAt`: los diez
 * minutos antes de cerrar, la hora en que la plancha puede seguir prendida, el
 * día entero con el local cerrado y la media hora antes de abrir. Con el local
 * abierto el componente no se renderiza —no devuelve un contenedor vacío— para
 * que no quede un hueco reservado a algo que no está.
 *
 * ── Los cuatro avisos NO pesan lo mismo ─────────────────────────────────────
 *
 * "Estamos abriendo", "atención fuera de horario" y "puede que todavía
 * alcancemos" acompañan a un cliente que probablemente igual va a comer hoy:
 * son contexto, y van en tono suave para no gritarle a quien ya está pidiendo.
 *
 * "Estamos cerrados" es otra cosa. Es el aviso que aparece a las tres de la
 * tarde, cuando el menú por sí solo —precios, fotos, botón de pedir— dice a
 * gritos que se puede comer ya. Ahí el cartel no acompaña: corrige. Por eso va
 * en rojo pleno, con borde de 2 px y el título en mayúsculas, que es el único
 * peso visual capaz de competir con una vitrina de hamburguesas.
 *
 * ── El color no comunica solo ───────────────────────────────────────────────
 *
 * El punto de color va acompañado SIEMPRE del título en texto. Un cartel que
 * solo se distingue por su color deja fuera a quien no lo percibe, y este en
 * concreto cambia lo que el cliente puede esperar del pedido.
 *
 * ── La hora es la del servidor, y avanza ────────────────────────────────────
 *
 * El instante base lo pone el Server Component con el reloj del servidor: un
 * celular con la hora mal puesta vería el aviso equivocado, y el de las 04:00
 * es justo el que no puede fallar.
 *
 * Pero ese instante se quedaría congelado en una pestaña abierta, y el cartel
 * de "estamos abriendo" seguiría ahí a las nueve de la noche. `useServerClock`
 * lo hace avanzar sumándole el tiempo transcurrido —medido de forma monotónica,
 * no leyendo la fecha del sistema— así que el aviso aparece y desaparece solo.
 */

/** Cómo se ve cada aviso. El `kind` lo decide `service-hours`, no la vista. */
const ESTILOS = {
  closed: {
    caja: 'border-2 border-donzarco-red bg-donzarco-red/10',
    punto: 'bg-donzarco-red',
    titulo: 'text-base uppercase tracking-wide text-donzarco-red-dark',
    cuerpo: 'text-zinc-700',
  },
  closing: {
    caja: 'border border-donzarco-gold/40 bg-donzarco-gold/10',
    punto: 'bg-donzarco-gold',
    titulo: 'text-sm text-donzarco-ink',
    cuerpo: 'text-zinc-600',
  },
  // Mismo ámbar que el cierre, y a propósito: son la misma conversación —"puede
  // que sí, puede que no"— separadas por la hora. El rojo se reserva para lo
  // único que no admite duda, que es el local cerrado.
  after_hours: {
    caja: 'border border-donzarco-gold/40 bg-donzarco-gold/10',
    punto: 'bg-donzarco-gold',
    titulo: 'text-sm text-donzarco-ink',
    cuerpo: 'text-zinc-600',
  },
  opening: {
    caja: 'border border-donzarco-red/25 bg-white',
    punto: 'bg-donzarco-red',
    titulo: 'text-sm text-donzarco-ink',
    cuerpo: 'text-zinc-600',
  },
} as const;

export function ServiceNoticeBanner({ serverNow }: { serverNow: number }) {
  const ahora = useServerClock(serverNow);
  const notice = serviceNoticeAt(ahora);

  if (notice === null) return null;

  const estilo = ESTILOS[notice.kind];

  return (
    <div className="px-4 pt-4">
      <div
        // `status` y no `alert`: es información de contexto que ya está en la
        // página al cargarla, no algo que deba interrumpir a quien esté usando
        // un lector de pantalla. El peso visual es para el ojo; el lector lo lee
        // igual cuando llega.
        role="status"
        className={`mx-auto max-w-5xl rounded-2xl px-4 py-3 ${estilo.caja}`}
      >
        <p className={`flex items-center gap-2 font-extrabold ${estilo.titulo}`}>
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${estilo.punto}`} aria-hidden />
          {notice.title}
        </p>
        <p className={`mt-1 text-sm leading-relaxed ${estilo.cuerpo}`}>{notice.body}</p>
      </div>
    </div>
  );
}
