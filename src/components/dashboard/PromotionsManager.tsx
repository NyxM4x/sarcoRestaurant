'use client';

import { useMemo, useState, useTransition } from 'react';
import type { MenuItem } from '@/types';
import { savePromotionAction, setPromotionActiveAction } from '@/app/dashboard/actions';
import { formatDateTime } from '@/lib/dashboard/format';
import {
  evaluatePromotion,
  normalPriceOf,
  type Promotion,
  type PromotionComponent,
  type PromotionDraftError,
} from '@/lib/promotions/promotion';
import {
  businessLocalToIso,
  composeSummary,
  expiryLabel,
  isoToBusinessLocal,
  statusHint,
  statusLabel,
} from '@/lib/promotions/promotion-display';

/**
 * Promociones en el panel: crear, editar y encender.
 *
 * ── El ahorro se calcula mientras se escribe, pero no autoriza nada ─────────
 *
 * La cifra que se ve bajo el formulario sale de `normalPriceOf` en el navegador,
 * y es solo una comodidad: cuando se pulsa guardar, el servidor vuelve a leer
 * los precios de `menu_items` y valida otra vez. Entre que se abrió el
 * formulario y se guardó, alguien pudo cambiar el precio de un producto.
 *
 * ── Encender y apagar son dos acciones, no un interruptor ───────────────────
 *
 * `setPromotionActiveAction(id, true|false)` recibe el estado QUE SE QUIERE. Un
 * `toggle` con una doble pulsación —o con un reintento por red lenta— acabaría
 * apagando lo que se quería encender, y en una promoción eso significa que deja
 * de venderse sin que nadie lo haya decidido.
 */

/** Mensaje por cada error de validación. Señala el campo, no "revisa los datos". */
const ERROR_MESSAGES: Record<PromotionDraftError, string> = {
  name_required: 'Ponle un nombre a la promoción.',
  name_too_long: 'El nombre no puede pasar de 80 caracteres.',
  description_too_long: 'La descripción no puede pasar de 300 caracteres.',
  price_not_positive: 'El precio tiene que ser mayor que cero.',
  price_not_below_normal: 'El precio de la promoción tiene que ser MENOR que el normal.',
  components_required: 'Una promoción necesita al menos dos unidades en total.',
  quantity_not_integer: 'Las cantidades tienen que ser números enteros.',
  quantity_out_of_range: 'Cada cantidad va de 1 a 20.',
  duplicate_component: 'Hay un producto repetido: cambia su cantidad en vez de añadirlo dos veces.',
  unknown_component: 'Uno de los productos ya no está en el menú.',
  component_unavailable: 'Uno de los productos está agotado. Actívalo antes de usarlo aquí.',
  window_out_of_order: 'El vencimiento tiene que ser posterior al inicio.',
  invalid_date: 'Revisa las fechas: alguna no se entiende.',
};

const bs = (amount: number): string =>
  Number.isInteger(amount) ? `Bs ${amount}` : `Bs ${amount.toFixed(2)}`;

interface DraftComponent {
  menuItemId: string;
  quantity: number;
}

const VACIO = {
  id: null as string | null,
  revision: null as number | null,
  name: '',
  description: '',
  promoPrice: '',
  startsAt: '',
  endsAt: '',
  components: [] as DraftComponent[],
};

export function PromotionsManager({
  initial,
  catalog,
  serverNow,
}: {
  initial: Promotion[];
  /** Productos ACTIVOS: son los únicos que se pueden meter en un combo nuevo. */
  catalog: MenuItem[];
  serverNow: number;
}) {
  const [form, setForm] = useState(VACIO);
  const [errores, setErrores] = useState<PromotionDraftError[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, startGuardar] = useTransition();

  const porId = useMemo(() => new Map(catalog.map((i) => [i.id, i])), [catalog]);

  /** Los componentes del formulario, resueltos contra el catálogo. */
  const resueltos: PromotionComponent[] = useMemo(
    () =>
      form.components.flatMap((c) => {
        const item = porId.get(c.menuItemId);
        if (item === undefined) return [];
        return [
          {
            menuItemId: item.id,
            code: item.code,
            name: item.name,
            category: item.category,
            unitPrice: item.price,
            quantity: c.quantity,
            isActive: item.is_active,
          },
        ];
      }),
    [form.components, porId],
  );

  const normal = normalPriceOf(resueltos);
  const promo = Number(form.promoPrice);
  const promoValido = Number.isFinite(promo) && promo > 0;
  // Nunca se pinta un ahorro negativo: si el precio se pasa, el aviso de abajo
  // lo dice con palabras en vez de mostrar "Ahorro Bs -10" como si fuera válido.
  const ahorro = promoValido && promo < normal ? normal - promo : 0;

  const disponibles = catalog.filter(
    (item) => !form.components.some((c) => c.menuItemId === item.id),
  );

  const limpiar = () => {
    setForm(VACIO);
    setErrores([]);
    setAviso(null);
  };

  const editar = (p: Promotion) => {
    setForm({
      id: p.id,
      revision: p.revision,
      name: p.name,
      description: p.description ?? '',
      promoPrice: String(p.promoPrice),
      startsAt: isoToBusinessLocal(p.startsAt),
      endsAt: isoToBusinessLocal(p.endsAt),
      components: p.components.map((c) => ({ menuItemId: c.menuItemId, quantity: c.quantity })),
    });
    setErrores([]);
    setAviso(null);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const guardar = () => {
    if (guardando) return;
    setErrores([]);
    setAviso(null);

    startGuardar(async () => {
      const res = await savePromotionAction({
        id: form.id,
        expectedRevision: form.revision,
        name: form.name,
        description: form.description.trim() === '' ? null : form.description.trim(),
        promoPrice: Number(form.promoPrice),
        startsAt: businessLocalToIso(form.startsAt),
        endsAt: businessLocalToIso(form.endsAt),
        components: form.components,
      });

      if (res.ok) {
        limpiar();
        setAviso('Guardada. Se crea apagada: enciéndela desde la lista.');
        return;
      }
      if (res.reason === 'invalid') {
        setErrores(res.errors);
        return;
      }
      setAviso(
        res.reason === 'stale'
          ? 'Alguien la modificó mientras la editabas. Recarga la página para ver la versión actual.'
          : res.reason === 'not_found'
            ? 'Esa promoción ya no existe.'
            : res.reason === 'unauthorized'
              ? 'No tienes permiso para esto.'
              : 'No se pudo guardar. Intenta de nuevo.',
      );
    });
  };

  const cambiarEstado = (p: Promotion, encender: boolean) => {
    // Confirmación solo al ENCENDER: apagar es reversible y urgente —se acabó un
    // producto y hay que sacarla del menú ya—, mientras que encender publica un
    // precio a todos los clientes.
    if (encender && !window.confirm(`¿Publicar "${p.name}" en el menú?`)) return;

    setAviso(null);
    startGuardar(async () => {
      const res = await setPromotionActiveAction(p.id, encender);
      if (res.ok) {
        setAviso(encender ? 'Publicada en el menú.' : 'Retirada del menú.');
        return;
      }
      setAviso(
        res.reason === 'not_publishable'
          ? `No se puede publicar: ${statusHint(res.status) ?? statusLabel(res.status)}`
          : res.reason === 'not_found'
            ? 'Esa promoción ya no existe.'
            : res.reason === 'unauthorized'
              ? 'No tienes permiso para esto.'
              : 'No se pudo cambiar. Intenta de nuevo.',
      );
    });
  };

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight">🎉 Promociones</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Combos de productos existentes con precio propio. No cambian el precio de los productos
        sueltos.
      </p>

      {/* ── Formulario ────────────────────────────────────────────────── */}
      <div className="mt-5 rounded-2xl border border-black/[0.07] bg-white p-4 dark:border-white/10 dark:bg-zinc-900">
        <h3 className="text-sm font-semibold">
          {form.id === null ? 'Nueva promoción' : 'Editando promoción'}
        </h3>

        <label className="mt-4 block text-xs font-medium text-zinc-500">
          Nombre
          <input
            type="text"
            value={form.name}
            maxLength={80}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="2 lomitos goleadores"
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-zinc-900 dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>

        <label className="mt-3 block text-xs font-medium text-zinc-500">
          Descripción (opcional)
          <input
            type="text"
            value={form.description}
            maxLength={300}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-zinc-900 dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>

        {/* ── Componentes ───────────────────────────────────────────── */}
        <p className="mt-4 text-xs font-medium text-zinc-500">Productos del combo</p>

        {resueltos.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-400">Todavía no has agregado ninguno.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {resueltos.map((c) => (
              <li
                key={c.menuItemId}
                className="flex items-center gap-3 rounded-lg border border-black/[0.07] px-3 py-2 dark:border-white/10"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                <span className="text-xs tabular-nums text-zinc-500">{bs(c.unitPrice)}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={c.quantity}
                  aria-label={`Cantidad de ${c.name}`}
                  onChange={(e) => {
                    // Se admite cualquier entero del rango; lo que no sea un
                    // número se ignora en vez de dejar el campo en NaN.
                    const n = Number.parseInt(e.target.value, 10);
                    if (!Number.isInteger(n)) return;
                    setForm({
                      ...form,
                      components: form.components.map((x) =>
                        x.menuItemId === c.menuItemId
                          ? { ...x, quantity: Math.min(20, Math.max(1, n)) }
                          : x,
                      ),
                    });
                  }}
                  className="w-16 rounded-lg border border-black/10 px-2 py-1 text-sm tabular-nums dark:border-white/15 dark:bg-zinc-950"
                />
                <button
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      components: form.components.filter((x) => x.menuItemId !== c.menuItemId),
                    })
                  }
                  aria-label={`Quitar ${c.name}`}
                  className="rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <select
          value=""
          aria-label="Agregar producto al combo"
          onChange={(e) => {
            const id = e.target.value;
            if (id === '') return;
            // El producto ya elegido no está en la lista, así que no puede
            // duplicarse desde aquí.
            setForm({ ...form, components: [...form.components, { menuItemId: id, quantity: 1 }] });
          }}
          className="mt-3 w-full rounded-lg border border-dashed border-black/15 px-3 py-2 text-sm text-zinc-600 dark:border-white/20 dark:bg-zinc-950 dark:text-zinc-300"
        >
          <option value="">+ Agregar producto…</option>
          {disponibles.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} — {bs(item.price)}
            </option>
          ))}
        </select>

        {/* ── Precio y cifras en vivo ───────────────────────────────── */}
        <label className="mt-4 block text-xs font-medium text-zinc-500">
          Precio de la promoción (Bs)
          <input
            type="number"
            min={0}
            step="0.5"
            value={form.promoPrice}
            onChange={(e) => setForm({ ...form, promoPrice: e.target.value })}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm tabular-nums text-zinc-900 dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>

        <dl className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-black/[0.03] px-3 py-2 text-sm dark:bg-white/[0.04]">
          <div>
            <dt className="text-xs text-zinc-500">Normal</dt>
            <dd className="tabular-nums line-through decoration-zinc-400">{bs(normal)}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Promo</dt>
            <dd className="tabular-nums font-semibold">{promoValido ? bs(promo) : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Ahorro</dt>
            <dd className="tabular-nums font-semibold text-donzarco-red">{bs(ahorro)}</dd>
          </div>
        </dl>

        {/* ── Vigencia ──────────────────────────────────────────────── */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-zinc-500">
            Inicio (opcional)
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15 dark:bg-zinc-950"
            />
          </label>
          <label className="block text-xs font-medium text-zinc-500">
            Vencimiento (opcional)
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15 dark:bg-zinc-950"
            />
          </label>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Las fechas usan la hora del local (Bolivia). Sin fechas, la promoción se enciende y se
          apaga a mano.
        </p>

        {/* ── Errores y avisos ──────────────────────────────────────── */}
        {errores.length > 0 && (
          <ul className="mt-4 space-y-1 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {[...new Set(errores)].map((e) => (
              <li key={e}>{ERROR_MESSAGES[e]}</li>
            ))}
          </ul>
        )}
        {aviso !== null && (
          <p role="status" className="mt-4 rounded-lg bg-black/[0.04] px-3 py-2 text-sm dark:bg-white/[0.06]">
            {aviso}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={guardar}
            disabled={guardando}
            className="rounded-lg bg-donzarco-red-dark px-4 py-2 text-sm font-medium text-white hover:bg-donzarco-red-hover disabled:opacity-50"
          >
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
          <button
            type="button"
            onClick={limpiar}
            disabled={guardando}
            className="rounded-lg border border-black/10 px-4 py-2 text-sm hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/[0.06]"
          >
            Cancelar
          </button>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Una promoción nueva se crea apagada. Se enciende desde la lista, y solo si su precio es
          menor que el normal.
        </p>
      </div>

      {/* ── Lista ─────────────────────────────────────────────────────── */}
      {initial.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500">Todavía no hay promociones.</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {initial.map((p) => {
            const evaluada = evaluatePromotion(p, serverNow);
            const vence = expiryLabel(p.endsAt, serverNow);
            const pista = statusHint(evaluada.status);
            const activa = evaluada.status === 'available';

            return (
              <li
                key={p.id}
                className="rounded-2xl border border-black/[0.07] bg-white p-4 dark:border-white/10 dark:bg-zinc-900"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{p.name}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">{composeSummary(p.components)}</p>
                  </div>
                  {/* El estado va con TEXTO, no solo con color. */}
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                      activa
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                        : evaluada.status === 'scheduled'
                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300'
                          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}
                  >
                    {statusLabel(evaluada.status)}
                  </span>
                </div>

                <p className="mt-2 text-sm tabular-nums">
                  <span className="text-zinc-400 line-through">{bs(evaluada.normalPrice)}</span>{' '}
                  <span className="font-semibold">{bs(evaluada.promoPrice)}</span>{' '}
                  <span className="text-donzarco-red">Ahorra {bs(evaluada.savings)}</span>
                </p>

                {vence !== null && <p className="mt-1 text-xs text-zinc-500">{vence}</p>}
                {pista !== null && <p className="mt-1 text-xs text-zinc-500">{pista}</p>}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => editar(p)}
                    disabled={guardando}
                    className="rounded-lg border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/[0.06]"
                  >
                    Editar
                  </button>
                  {p.isActive ? (
                    <button
                      type="button"
                      onClick={() => cambiarEstado(p, false)}
                      disabled={guardando}
                      className="rounded-lg border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/[0.06]"
                    >
                      Desactivar
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => cambiarEstado(p, true)}
                      disabled={guardando}
                      className="rounded-lg bg-donzarco-red-dark px-3 py-1.5 text-sm font-medium text-white hover:bg-donzarco-red-hover disabled:opacity-50"
                    >
                      Activar
                    </button>
                  )}
                </div>

                <p className="mt-2 text-[11px] text-zinc-400">
                  Actualizada {formatDateTime(p.updatedAt)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
