'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { OrdersListResult } from '@/lib/dashboard/orders-repository';
import type { OrderStatus } from '@/types';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/dashboard/filters';
import { createPollingController } from '@/lib/dashboard/polling';
import { updateOrderStatusAction } from '@/app/dashboard/actions';
import { DashboardHeader } from './DashboardHeader';
import { SummaryCards } from './SummaryCards';
import { OrderFilters, type FilterState } from './OrderFilters';
import { OrderList } from './OrderList';
import { OrderDetailPanel } from './OrderDetailPanel';

const POLL_MS = 12_000;
/** Cada cuánto refresca el reloj compartido (tiempo de espera / expiración de "Nuevo"). */
const WALL_TICK_MS = 30_000;
/** Cuánto tiempo se resalta un pedido como "Nuevo" tras detectarlo. */
const NEW_WINDOW_MS = 90_000;
const INITIAL_FILTERS: FilterState = { statusGroup: '', deliveryType: '', dateRange: 'today', search: '' };

type FetchMode = 'replace' | 'append' | 'silent';

function buildQuery(filters: FilterState, offset: number, limit: number): string {
  const p = new URLSearchParams();
  if (filters.statusGroup) p.set('statusGroup', filters.statusGroup);
  if (filters.deliveryType) p.set('deliveryType', filters.deliveryType);
  p.set('dateRange', filters.dateRange);
  if (filters.search.trim()) p.set('search', filters.search.trim());
  p.set('limit', String(limit));
  p.set('offset', String(offset));
  return p.toString();
}

/** Constructor de AudioContext con fallback webkit, sin `any` y seguro en SSR. */
function getAudioCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (typeof AudioContext !== 'undefined') return AudioContext;
  const w = window as unknown as { webkitAudioContext?: typeof AudioContext };
  return w.webkitAudioContext ?? null;
}

export function OrdersDashboard({
  initial,
  serverNow,
  rainSurcharge = false,
}: {
  initial: OrdersListResult;
  serverNow: number;
  /** Estado del recargo por lluvia, leido en servidor. */
  rainSurcharge?: boolean;
}) {
  const [data, setData] = useState<OrdersListResult>(initial);
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [, startAction] = useTransition();
  // Se inicializa con la hora del servidor para no provocar mismatch de hidratación.
  const [lastUpdated, setLastUpdated] = useState<number>(serverNow);
  // Reloj compartido del dashboard: un solo interval alimenta el tiempo de espera
  // de TODAS las tarjetas (sin timers por card) y la expiración de "Nuevo".
  const [wallNow, setWallNow] = useState<number>(serverNow);
  // Pedidos marcados como "Nuevo": orderNumber → instante de detección.
  const [newOrders, setNewOrders] = useState<Record<string, number>>({});
  const [soundOn, setSoundOn] = useState(false);

  const filtersRef = useRef(filters);
  const countRef = useRef(initial.orders.length);
  // Conjunto base de pedidos ya vistos: contra él se detectan los nuevos.
  const seenRef = useRef<Set<string>>(new Set(initial.orders.map((o) => o.orderNumber)));
  // Salta UNA detección (evita marcar un aluvión al volver de una pestaña oculta).
  const skipDetectRef = useRef(false);
  const soundOnRef = useRef(soundOn);
  const audioRef = useRef<AudioContext | null>(null);

  // Los refs se sincronizan en efectos (nunca durante el render).
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  useEffect(() => {
    countRef.current = data.orders.length;
  }, [data.orders.length]);
  useEffect(() => {
    soundOnRef.current = soundOn;
  }, [soundOn]);

  // Sonido corto de dos tonos vía WebAudio (sin assets ni dependencias). Solo
  // suena si el operador activó el sonido. Nunca se invoca en la carga inicial:
  // únicamente desde la detección de un pedido nuevo por polling.
  const playChime = useCallback(() => {
    if (!soundOnRef.current) return;
    try {
      const Ctor = getAudioCtor();
      if (!Ctor) return;
      let ctx = audioRef.current;
      if (!ctx) {
        ctx = new Ctor();
        audioRef.current = ctx;
      }
      if (ctx.state === 'suspended') void ctx.resume();
      const t0 = ctx.currentTime;
      const beep = (freq: number, start: number, dur: number) => {
        const osc = ctx!.createOscillator();
        const gain = ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.14, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(gain).connect(ctx!.destination);
        osc.start(start);
        osc.stop(start + dur);
      };
      beep(880, t0, 0.16);
      beep(1174.7, t0 + 0.14, 0.18);
    } catch {
      /* audio no disponible en este entorno: silencio, sin romper nada */
    }
  }, []);

  // Reconcilia el conjunto visto y decide qué pedidos son "Nuevos".
  const reconcile = useCallback(
    (incoming: string[], mode: FetchMode, detectNew: boolean) => {
      if (mode === 'replace') {
        // Carga inicial / cambio de filtros / reintento: nueva base, sin marcas.
        seenRef.current = new Set(incoming);
        setNewOrders({});
        return;
      }
      if (mode === 'append') {
        // Paginación: los pedidos que llegan son antiguos, nunca "Nuevos".
        for (const n of incoming) seenRef.current.add(n);
        return;
      }
      // silent (polling o refresco manual)
      if (detectNew && !skipDetectRef.current) {
        const additions = incoming.filter((n) => !seenRef.current.has(n));
        if (additions.length > 0) {
          const t = Date.now();
          setNewOrders((prev) => {
            const copy = { ...prev };
            for (const n of additions) copy[n] = t;
            return copy;
          });
          playChime();
        }
      }
      skipDetectRef.current = false;
      seenRef.current = new Set(incoming);
    },
    [playChime],
  );

  const fetchPage = useCallback(
    async (offset: number, limit: number, mode: FetchMode, detectNew: boolean) => {
      if (mode === 'silent') setRefreshing(true);
      else setLoading(true);
      setError(false);
      try {
        const res = await fetch(`/api/dashboard/orders?${buildQuery(filtersRef.current, offset, limit)}`, {
          cache: 'no-store',
        });
        if (res.status === 401) {
          window.location.href = '/dashboard/login';
          return;
        }
        if (!res.ok) {
          setError(true);
          return;
        }
        const next = (await res.json()) as OrdersListResult;
        setData((prev) => (mode === 'append' ? { ...next, orders: [...prev.orders, ...next.orders] } : next));
        setLastUpdated(Date.now());
        reconcile(next.orders.map((o) => o.orderNumber), mode, detectNew);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [reconcile],
  );

  const loadFirst = useCallback(() => fetchPage(0, DEFAULT_PAGE_SIZE, 'replace', false), [fetchPage]);
  const loadMore = useCallback(
    () => fetchPage(countRef.current, DEFAULT_PAGE_SIZE, 'append', false),
    [fetchPage],
  );
  const refresh = useCallback(
    (detectNew = false) =>
      fetchPage(0, Math.min(Math.max(countRef.current, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE), 'silent', detectNew),
    [fetchPage],
  );

  // Acción rápida contextual desde la tarjeta: usa la MISMA Server Action y
  // validaciones existentes. Evita doble clic con `busyOrder`.
  const handleQuickAction = useCallback(
    (orderNumber: string, to: OrderStatus) => {
      if (busyOrder) return;
      setBusyOrder(orderNumber);
      startAction(async () => {
        try {
          await updateOrderStatusAction(orderNumber, to);
          await refresh(false);
        } finally {
          setBusyOrder(null);
        }
      });
    },
    [busyOrder, refresh],
  );

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      const next = !on;
      // Desbloqueo de autoplay: el AudioContext se crea/reanuda DENTRO del gesto
      // del usuario (este click). Así el primer chime posterior podrá sonar.
      if (next) {
        try {
          const Ctor = getAudioCtor();
          if (Ctor) {
            if (!audioRef.current) audioRef.current = new Ctor();
            void audioRef.current.resume();
          }
        } catch {
          /* sin audio: el toggle queda activo pero no sonará */
        }
      }
      return next;
    });
  }, []);

  // Refetch al cambiar filtros (búsqueda con debounce).
  useEffect(() => {
    const t = setTimeout(() => {
      loadFirst();
    }, filters.search ? 400 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.statusGroup, filters.deliveryType, filters.dateRange, filters.search]);

  // Polling moderado, pausado con la pestaña oculta y sin solaparse. El tick
  // detecta pedidos nuevos (detectNew = true).
  useEffect(() => {
    const controller = createPollingController({
      intervalMs: POLL_MS,
      isActive: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      onTick: () => refresh(true),
    });
    controller.start();
    return () => controller.stop();
  }, [refresh]);

  // Al volver de una pestaña oculta, salta la siguiente detección para no marcar
  // de golpe todos los pedidos acumulados mientras no se miraba.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') skipDetectRef.current = true;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Reloj compartido: actualiza `wallNow` y poda marcas "Nuevo" ya expiradas.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setWallNow(now);
      setNewOrders((prev) => {
        let changed = false;
        const copy: Record<string, number> = {};
        for (const [k, ts] of Object.entries(prev)) {
          if (now - ts < NEW_WINDOW_MS) copy[k] = ts;
          else changed = true;
        }
        return changed ? copy : prev;
      });
    }, WALL_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const newOrderNumbers = useMemo(() => {
    const s = new Set<string>();
    for (const [k, ts] of Object.entries(newOrders)) {
      if (wallNow - ts < NEW_WINDOW_MS) s.add(k);
    }
    return s;
  }, [newOrders, wallNow]);

  return (
    <>
      <DashboardHeader
        nowMs={serverNow}
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        onRefresh={() => refresh(false)}
        soundOn={soundOn}
        onToggleSound={toggleSound}
        rainSurcharge={rainSurcharge}
      />

      <div className="mb-6">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Resumen de hoy</p>
        <SummaryCards summary={data.summary} loading={loading && data.orders.length === 0} />
      </div>

      <div className="mb-4">
        <OrderFilters value={filters} onChange={setFilters} />
      </div>

      <OrderList
        orders={data.orders}
        loading={loading}
        error={error}
        activeOrder={selected}
        busyOrder={busyOrder}
        newOrderNumbers={newOrderNumbers}
        nowMs={wallNow}
        onSelect={setSelected}
        onQuickAction={handleQuickAction}
        hasMore={data.hasMore}
        onLoadMore={loadMore}
        onRetry={loadFirst}
      />

      {selected && (
        <OrderDetailPanel
          key={selected}
          orderNumber={selected}
          onClose={() => setSelected(null)}
          onUpdated={() => refresh(false)}
        />
      )}
    </>
  );
}
