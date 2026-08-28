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
    <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden bg-zinc-900 text-white">
      <div className="shrink-0 border-b border-white/10 px-5 py-4">
        <h2 className="text-sm font-extrabold uppercase tracking-widest text-zinc-300">
          Resumen de cocina
        </h2>
        <p className="mt-1 text-xs font-medium text-zinc-400">
          <span className="tabular-nums text-white">{summary.totalUnits}</span> unidades ·{' '}
          <span className="tabular-nums text-white">{summary.countedOrders}</span>{' '}
          {summary.countedOrders === 1 ? 'pedido confirmado' : 'pedidos confirmados'}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {summary.rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-zinc-500">
            {enEspera
              ? 'Todo lo que hay espera confirmación de pago.'
              : 'Nada pendiente por cocinar.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {summary.rows.map((row) => (
              <li
                key={row.name}
                className="flex items-baseline gap-3 rounded-lg px-2 py-2 odd:bg-white/5"
              >
                <span className="w-12 shrink-0 text-right text-xl font-extrabold tabular-nums text-amber-300">
                  {row.quantity}x
                </span>
                <span className="text-sm font-semibold leading-snug text-zinc-100">{row.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pie: lo que todavía NO suma. Deliberadamente apagado —sin ámbar ni
          números grandes— para que no compita con el total: es un aviso de que
          hay trabajo por llegar, no trabajo que hacer. */}
      {enEspera && (
        <div className="shrink-0 border-t border-white/10 bg-black/30 px-5 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
            Esperando confirmación de pago
          </p>
          <p className="mt-0.5 text-xs font-medium text-zinc-400">
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
