'use client';

import { serviceNoticeAt } from '@/lib/menu/service-hours';
import { useServerClock } from '@/lib/menu/use-server-clock';

/**
 * Aviso de horario, encima del catálogo.
 *
 * Solo se pinta en las dos franjas que decide `serviceNoticeAt`: media hora
 * antes de abrir y el cuarto de hora alrededor del cierre. El resto del tiempo
 * el componente no se renderiza —no devuelve un contenedor vacío— para que no
 * quede un hueco reservado a algo que no está.
 *
 * ── El color no comunica solo ───────────────────────────────────────────────
 *
 * El punto naranja va acompañado SIEMPRE del título en texto. Un cartel que solo
 * se distingue por su color deja fuera a quien no lo percibe, y este en concreto
 * cambia lo que el cliente puede esperar del pedido.
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
export function ServiceNoticeBanner({ serverNow }: { serverNow: number }) {
  const ahora = useServerClock(serverNow);
  const notice = serviceNoticeAt(ahora);

  if (notice === null) return null;

  const esCierre = notice.kind === 'closing';

  return (
    <div className="px-4 pt-4">
      <div
        // `status` y no `alert`: es información de contexto, no algo que deba
        // interrumpir a quien esté usando un lector de pantalla.
        role="status"
        className={`mx-auto max-w-5xl rounded-2xl border px-4 py-3 ${
          esCierre
            ? 'border-donzarco-gold/40 bg-donzarco-gold/10'
            : 'border-donzarco-red/25 bg-white'
        }`}
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-donzarco-ink">
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${
              esCierre ? 'bg-donzarco-gold' : 'bg-donzarco-red'
            }`}
            aria-hidden
          />
          {notice.title}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-zinc-600">{notice.body}</p>
      </div>
    </div>
  );
}
