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
import { useKitchenChime } from '@/lib/kitchen/use-kitchen-chime';
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
  /**
   * ¿Se pudo consultar el estado de los pagos? (0028)
   *
   * `false` NO es "no hay pagos": es "no lo sabemos". El tablero sigue entero y
   * la puerta de INICIAR se abre —parar la cocina por un fallo de la base sería
   * peor que cocinar un pedido de más— pero la pantalla tiene que decirlo. Sin
   * este aviso la degradación era invisible: se cocinaba sin verificar el pago
   * y nada lo insinuaba.
   */
  const [paymentsAvailable, setPaymentsAvailable] = useState(initial.paymentsAvailable);
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

  // Campana al entrar un pedido nuevo: en cocina se mira la plancha, no la
  // pantalla, y un ticket que aparece en silencio se queda esperando.
  const { soundOn, toggleSound, soundBlocked } = useKitchenChime(tickets);

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
      setPaymentsAvailable(board.paymentsAvailable);
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

  /**
   * Al volver a mirar la pantalla, refresca YA.
   *
   * El polling se pausa con la pestana oculta —correcto: no tiene sentido
   * consultar la base contra una pantalla que nadie mira— pero al volver
   * reprograma el siguiente ciclo en vez de recuperar el tiempo perdido. El
   * efecto era que la tablet ensenaba el estado de cuando se dejo de mirar, y
   * habia que recargar a mano para ver un comprobante que ya habia llegado.
   *
   * En cocina esa espera se nota mas que en cualquier otro sitio: la pantalla se
   * apaga, se atiende otra cosa, y al volver lo primero que se hace es decidir
   * con lo que hay delante. Si lo que hay delante esta caducado, se decide mal.
   */
  useEffect(() => {
    const alVolver = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', alVolver);
    // `focus` cubre el caso de volver desde otra ventana sin que la pestana
    // llegara a ocultarse (dos navegadores lado a lado, o alt-tab).
    window.addEventListener('focus', alVolver);
    return () => {
      document.removeEventListener('visibilitychange', alVolver);
      window.removeEventListener('focus', alVolver);
    };
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
        soundOn={soundOn}
        onToggleSound={toggleSound}
        soundBlocked={soundBlocked}
      />

      {/* Degradación VISIBLE. Va sobre el grid y a ancho completo: es una
          condición de toda la pantalla, no de un ticket, y quien entra a media
          noche tiene que verla sin buscarla. */}
      {!paymentsAvailable && (
        <div
          role="status"
          className="shrink-0 bg-amber-100 px-4 py-2 text-center text-sm font-bold text-amber-900 ring-1 ring-inset ring-amber-300"
        >
          No se pudo consultar el estado de los pagos. Revisa el comprobante antes de
          empezar cada pedido.
        </div>
      )}

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
