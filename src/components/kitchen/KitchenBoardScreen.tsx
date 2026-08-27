'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPollingController } from '@/lib/dashboard/polling';
import { buttonsForStage, nextStage, type KdsAction } from '@/lib/kitchen/kds-status';
import {
  countersFrom,
  gridTickets,
  readyTickets,
  summarizeProducts,
} from '@/lib/kitchen/summary';
import type { KitchenTicket } from '@/lib/kitchen/ticket-view';
import type { KitchenBoard } from '@/lib/kitchen/tickets-repository';
import { kitchenStageAction, kitchenLogoutAction } from '@/app/cocina/actions';
import { KitchenTopBar } from './KitchenTopBar';
import { KitchenTicketCard } from './KitchenTicketCard';
import { KitchenSummaryPanel } from './KitchenSummaryPanel';
import { KitchenReadyPanel } from './KitchenReadyPanel';
import { KitchenConfirmModal } from './KitchenConfirmModal';

/** El tablero refleja en ~10 s lo que haga el encargado desde el panel admin. */
const POLL_MS = 10_000;
/** Un UNICO reloj de 1 s alimenta todos los temporizadores de la pantalla. */
const CLOCK_MS = 1_000;

interface PendingConfirm {
  orderNumber: string;
  action: KdsAction;
  question: string;
  tone: 'green' | 'red';
}

const QUESTIONS: Partial<Record<KdsAction, { question: string; tone: 'green' | 'red' }>> = {
  // El texto habla de "despacharlo" porque asi lo entiende el cocinero; el
  // estado que se guarda es `ready` (despachar al cliente es del encargado).
  complete: {
    question: '¿Está seguro que desea completar el pedido y despacharlo?',
    tone: 'green',
  },
  cancel: { question: '¿Está seguro que desea cancelar el pedido?', tone: 'red' },
};

/**
 * Tablero de cocina. Orquesta polling, reloj compartido y acciones; TODOS los
 * numeros de la pantalla se derivan aqui de una unica fuente de verdad —la
 * lista de tickets— con las funciones puras de `@/lib/kitchen`.
 */
export function KitchenBoardScreen({
  initial,
  serverNow,
}: {
  initial: KitchenBoard;
  serverNow: number;
}) {
  const [tickets, setTickets] = useState<KitchenTicket[]>(initial.tickets);
  // Arranca con el reloj del SERVIDOR para no provocar desajuste de hidratacion.
  const [nowMs, setNowMs] = useState<number>(serverNow);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [readyOpen, setReadyOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [, startAction] = useTransition();

  const busyRef = useRef<string | null>(null);
  useEffect(() => {
    busyRef.current = busyOrder;
  }, [busyOrder]);

  // ── Contadores y resumen: derivados, nunca guardados aparte ───────────────
  const counters = useMemo(() => countersFrom(tickets), [tickets]);
  const summary = useMemo(() => summarizeProducts(tickets), [tickets]);
  const grid = useMemo(() => gridTickets(tickets), [tickets]);
  const ready = useMemo(() => readyTickets(tickets), [tickets]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/kitchen/orders', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.href = '/dashboard/login';
        return;
      }
      if (!res.ok) {
        setOffline(true);
        return;
      }
      const board = (await res.json()) as KitchenBoard;
      setTickets(board.tickets);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Polling moderado, sin solaparse y pausado con la pestana oculta. Mientras
  // una accion esta en vuelo se salta el ciclo, para que la respuesta del
  // servidor no pelee con la actualizacion optimista.
  useEffect(() => {
    const controller = createPollingController({
      intervalMs: POLL_MS,
      isActive: () =>
        busyRef.current === null &&
        (typeof document === 'undefined' || document.visibilityState === 'visible'),
      onTick: () => refresh(),
    });
    controller.start();
    return () => controller.stop();
  }, [refresh]);

  // Reloj compartido: un solo interval para TODOS los temporizadores.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  /** Aplica la transicion en local para que la tablet responda al instante. */
  const applyOptimistic = useCallback((orderNumber: string, action: KdsAction) => {
    setTickets((prev) =>
      prev.map((t) => {
        if (t.orderNumber !== orderNumber) return t;
        const target = nextStage(t.stage, action);
        // Combinacion no permitida: la interfaz la ignora (protege del doble toque).
        if (target === null) return t;
        return {
          ...t,
          stage: target,
          completedAt: target === 'done' ? new Date().toISOString() : null,
        };
      }),
    );
  }, []);

  const run = useCallback(
    (orderNumber: string, action: KdsAction) => {
      if (busyOrder !== null) return;
      setBusyOrder(orderNumber);
      setMessage(null);
      applyOptimistic(orderNumber, action);
      startAction(async () => {
        try {
          const result = await kitchenStageAction(orderNumber, action);
          if (!result.ok) setMessage(result.message);
        } catch {
          setMessage('No se pudo guardar el cambio. Vuelve a intentarlo.');
        } finally {
          setBusyOrder(null);
          // Tras cualquier resultado (y siempre tras un conflicto) se recarga el
          // tablero: el estado real de la base manda sobre lo optimista.
          await refresh();
        }
      });
    },
    [applyOptimistic, busyOrder, refresh],
  );

  /** Punto de entrada de todos los botones: decide si hace falta confirmar. */
  const handleAction = useCallback(
    (orderNumber: string, action: KdsAction) => {
      if (busyOrder !== null) return;
      const ticket = tickets.find((t) => t.orderNumber === orderNumber);
      if (!ticket) return;
      // La accion debe existir para la etapa actual: doble toque = sin efecto.
      const button = buttonsForStage(ticket.stage).find((b) => b.action === action);
      if (!button) return;
      const q = QUESTIONS[action];
      if (button.confirm && q) {
        setPending({ orderNumber, action, question: q.question, tone: q.tone });
        return;
      }
      run(orderNumber, action);
    },
    [busyOrder, run, tickets],
  );

  const confirm = useCallback(() => {
    if (!pending) return;
    const { orderNumber, action } = pending;
    setPending(null);
    run(orderNumber, action);
  }, [pending, run]);

  const logout = useCallback(() => {
    startAction(async () => {
      await kitchenLogoutAction();
    });
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-zinc-100 text-zinc-900">
      <KitchenTopBar
        counters={counters}
        refreshing={refreshing}
        offline={offline}
        onOpenReady={() => setReadyOpen(true)}
        onLogout={logout}
      />

      <div className="flex min-h-0 flex-1">
        {/* Grid central: las tarjetas llenan una columna hacia abajo y desbordan
            a la derecha. El wrap vertical exige altura definida: la da `h-full`
            dentro de este contenedor flex. */}
        <main className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
          {grid.length === 0 ? (
            <div className="grid h-full place-items-center">
              <div className="text-center">
                <p className="text-2xl font-bold text-zinc-400">No hay pedidos en cocina</p>
                <p className="mt-1 text-sm text-zinc-400">
                  Los pedidos confirmados aparecerán aquí automáticamente.
                </p>
              </div>
            </div>
          ) : (
            <div className="inline-flex h-full flex-col flex-wrap content-start gap-4">
              {grid.map((ticket) => (
                <KitchenTicketCard
                  key={ticket.orderNumber}
                  ticket={ticket}
                  nowMs={nowMs}
                  busy={busyOrder !== null}
                  onAction={handleAction}
                  // Tras decidir un pago se recarga el tablero: el estado real
                  // lo tiene el servidor, y puede que el encargado haya decidido
                  // desde su panel un segundo antes.
                  onPaymentDecided={refresh}
                />
              ))}
            </div>
          )}
        </main>

        <KitchenSummaryPanel summary={summary} />
      </div>

      {message && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-6"
        >
          <p className="pointer-events-auto rounded-xl bg-zinc-900 px-6 py-4 text-base font-semibold text-white shadow-2xl">
            {message}
          </p>
        </div>
      )}

      {readyOpen && (
        <KitchenReadyPanel
          tickets={ready}
          busyOrder={busyOrder}
          onAction={run}
          onClose={() => setReadyOpen(false)}
        />
      )}

      {pending && (
        <KitchenConfirmModal
          question={pending.question}
          tone={pending.tone}
          confirmLabel="SÍ"
          busy={busyOrder !== null}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
