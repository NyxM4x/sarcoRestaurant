'use client';

import type { KitchenSummary } from '@/lib/kitchen/summary';

/**
 * Panel derecho fijo: RESUMEN DE COCINA.
 *
 * Suma las cantidades de cada producto de los pedidos que ya son trabajo en
 * firme —activos y con el pago confirmado— para cocinar por lotes. Recibe el
 * resumen ya derivado de la lista de tickets: al completar un pedido baja solo,
 * y al devolverlo a cocina vuelve a subir, sin ningún estado que sincronizar.
 *
 * ── Lo retenido se dice, no se esconde ─────────────────────────────────────
 *
 * Un pedido cuyo comprobante nadie ha confirmado todavía no entra en el total;
 * esa es la razón de ser de esta pantalla para el planchero. Pero desaparecer
 * sin más haría que el panel pareciera roto justo cuando acierta, así que lo
 * pendiente se declara abajo, en gris y aparte de la cifra que manda.
 */
export function KitchenSummaryPanel({ summary }: { summary: KitchenSummary }) {
  const enEspera = summary.awaitingOrders > 0;

  return (
    /*
      220 px y no 300.
 
      En la tablet de cocina (1280 px CSS) los 300 px de antes se comían el 23 %
      del ancho —en 12,5 pulgadas físicas se ven como un tercio de la pantalla— y
      ese recorte era justo lo que dejaba el tablero en tres pedidos. Los 80 px
      recuperados son un cuarto de columna de tickets.
 
      Lo que se estrecha es el CONTINENTE, no la cifra: la cantidad sigue siendo
      lo más grande del panel, porque es lo único que se lee de un vistazo desde
      la plancha. Lo que encoge son los márgenes y los rótulos, que se leen una
      vez y ya se saben.
    */
    <aside className="flex w-[220px] shrink-0 flex-col overflow-hidden bg-zinc-900 text-white">
      <div className="shrink-0 border-b border-white/10 px-3 py-2.5">
        <h2 className="text-xs font-extrabold uppercase tracking-widest text-zinc-300">
          Resumen de cocina
        </h2>
        <p className="mt-0.5 text-[11px] font-medium leading-tight text-zinc-400">
          <span className="tabular-nums text-white">{summary.totalUnits}</span> unidades ·{' '}
          <span className="tabular-nums text-white">{summary.countedOrders}</span>{' '}
          {summary.countedOrders === 1 ? 'pedido confirmado' : 'pedidos confirmados'}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {summary.rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-zinc-500">
            {enEspera
              ? 'Todo lo que hay espera confirmación de pago.'
              : 'Nada pendiente por cocinar.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {summary.rows.map((row) => (
              <li
                key={row.name}
                className="flex items-baseline gap-2 rounded-md px-1.5 py-1.5 odd:bg-white/5"
              >
                <span className="w-9 shrink-0 text-right text-lg font-extrabold leading-none tabular-nums text-amber-300">
                  {row.quantity}x
                </span>
                <span className="text-[13px] font-semibold leading-tight text-zinc-100">
                  {row.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pie: lo que todavía NO suma. Deliberadamente apagado —sin ámbar ni
          números grandes— para que no compita con el total: es un aviso de que
          hay trabajo por llegar, no trabajo que hacer. */}
      {enEspera && (
        <div className="shrink-0 border-t border-white/10 bg-black/30 px-3 py-2">
          <p className="text-[10px] font-bold uppercase leading-tight tracking-wider text-zinc-500">
            Esperando confirmación de pago
          </p>
          <p className="mt-0.5 text-[11px] font-medium leading-tight text-zinc-400">
            <span className="tabular-nums text-zinc-200">{summary.awaitingOrders}</span>{' '}
            {summary.awaitingOrders === 1 ? 'pedido' : 'pedidos'} ·{' '}
            <span className="tabular-nums text-zinc-200">{summary.awaitingUnits}</span>{' '}
            {summary.awaitingUnits === 1 ? 'unidad' : 'unidades'} sin sumar
          </p>
        </div>
      )}
    </aside>
  );
}
