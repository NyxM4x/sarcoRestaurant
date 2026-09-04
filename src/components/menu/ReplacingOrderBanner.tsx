import { shortOrderNumber } from '@/lib/orders/order-number';

/**
 * "Estás cambiando tu pedido #7" — aviso encima del catálogo (0035).
 *
 * ── Por qué hace falta decirlo ──────────────────────────────────────────────
 *
 * Quien entra por este enlace se encuentra el carrito con cosas dentro. Sin una
 * frase que lo explique, eso se lee de dos maneras y las dos son malas: "el
 * sistema se equivocó y me puso cosas" o "esto es un pedido nuevo aparte". La
 * segunda es la peligrosa — confirmaría creyendo que suma, y lo que hace es
 * sustituir.
 *
 * Así que se dicen las tres cosas que cambian su decisión: cuál es su pedido,
 * que lo que confirme REEMPLAZA al anterior, y que el total se recalcula.
 *
 * No es un componente de cliente: no tiene estado ni reloj. Se pinta en el
 * servidor con lo que ya se leyó del pedido.
 */
export function ReplacingOrderBanner({ orderNumber }: { orderNumber: string }) {
  return (
    <div className="px-4 pt-4">
      <div
        // `status` y no `alert`: informa del contexto de la pantalla, no
        // interrumpe una tarea en curso.
        role="status"
        className="mx-auto max-w-5xl rounded-2xl border border-donzarco-gold/40 bg-donzarco-gold/10 px-4 py-3"
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-donzarco-ink">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-donzarco-gold" aria-hidden />
          Estás cambiando tu pedido {shortOrderNumber(orderNumber)}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-zinc-600">
          Ya te pusimos dentro lo que habías pedido: agregá o quitá lo que quieras. Al
          confirmar, este pedido reemplaza al anterior y te mandamos el total actualizado
          con el QR por WhatsApp.
        </p>
      </div>
    </div>
  );
}
