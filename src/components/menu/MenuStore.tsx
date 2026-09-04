'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { MenuItem } from '@/types';
import { useCart } from '@/lib/cart/use-cart';
import { usePromoCart } from '@/lib/cart/use-promo-cart';
import { useServerClock } from '@/lib/menu/use-server-clock';
import { unifiedTotals } from '@/lib/cart/promo-cart';
import { evaluatePromotion, isPurchasable, type Promotion } from '@/lib/promotions/promotion';
import { filterMenuItems, groupByCategory, type CategoryFilter } from '@/lib/menu/catalog';
import { submitOrder } from '@/lib/checkout/client';
import { validateCheckoutForm, type CheckoutFormFields } from '@/lib/checkout/form';
import {
  INITIAL_CHECKOUT_STATE,
  canRetry as canRetryState,
  canSubmit as canSubmitState,
  checkoutReducer,
  isFrozen,
  isSessionBlocked,
} from '@/lib/checkout/state';
import { CartButton } from './CartButton';
import { CartPanel } from './CartPanel';
import { CategoryTabs } from './CategoryTabs';
import { CheckoutPanel } from './CheckoutPanel';
import { OrderSuccess } from './OrderSuccess';
import { ProductCard } from './ProductCard';
import { PromoCard } from './PromoCard';
import { SearchBar } from './SearchBar';

const NO_SESSION_NOTICE = 'Abre el menú desde WhatsApp para confirmar tu pedido.';
/** El enlace ya tiene un pedido: 201, 200 idempotente o 409. */
const SESSION_USED_NOTICE =
  'Este enlace ya fue utilizado. Vuelve a WhatsApp para solicitar un nuevo enlace y realizar otro pedido.';
/** El enlace no es válido o venció: 401. */
const SESSION_INVALID_NOTICE =
  'Este enlace ya no es válido. Vuelve a WhatsApp y solicita nuevamente el menú.';

/**
 * Tienda: catálogo, carrito y checkout.
 *
 * Los productos llegan ya leídos de Supabase por el Server Component. El
 * carrito vive en `localStorage`; el checkout, en un reducer puro
 * (`@/lib/checkout/state`) que concentra las guardas contra el doble envío y el
 * reintento tras un resultado ambiguo.
 *
 * `sessionToken` llega como prop y NO se guarda en el estado ni en
 * `localStorage`: solo se pasa a `submitOrder` en el momento del envío.
 */
export function MenuStore({
  items,
  promotions,
  serverNow,
  sessionToken,
  replacingOrder = null,
}: {
  items: MenuItem[];
  /** Combos publicables, ya leídos en el servidor. */
  promotions: Promotion[];
  /**
   * Reloj del SERVIDOR en el momento de renderizar. Con él se decide si un
   * combo está vigente: el celular del cliente puede tener la hora mal, y una
   * promoción que vence a las 23:31 no puede depender de eso.
   *
   * `useServerClock` lo hace avanzar sumándole el tiempo transcurrido, para que
   * una pestaña abierta durante horas no se quede en el pasado.
   */
  serverNow: number;
  sessionToken: string | null;
  /**
   * El pedido que este enlace viene a CAMBIAR (0035), ya leído en el servidor.
   *
   * Cuando llega, el carrito se siembra con lo que el cliente había pedido para
   * que solo tenga que tocar lo que quiere cambiar. Ausente = enlace normal, y
   * entonces esta pantalla se comporta exactamente como siempre.
   */
  replacingOrder?: {
    orderNumber: string;
    items: Record<string, number>;
    promotions: Record<string, number>;
  } | null;
}) {
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [query, setQuery] = useState('');
  const [cartOpen, setCartOpen] = useState(false);

  // El instante del servidor, avanzando. Sin esto, una pestaña abierta desde
  // hace horas seguiría mostrando una promoción que ya venció.
  const ahora = useServerClock(serverNow);

  const cart = useCart(items);
  const promos = usePromoCart(promotions, ahora);

  /**
   * El pedido que se está cambiando, de vuelta en el carrito (0035).
   *
   * ── Solo una vez, y solo sobre un carrito vacío ───────────────────────────
   *
   * Una vez, porque si no cada render devolvería el carrito a su estado
   * original y el cliente no podría quitar nada. Y solo si está vacío, porque
   * un carrito con cosas dentro es del cliente: puede haber empezado a armar
   * algo antes de tocar el botón, y pisarle eso sería borrarle trabajo.
   *
   * Se espera a `hydrated`: hasta entonces `cart.cart` está vacío por
   * construcción —el snapshot del servidor es siempre nulo— y sembrar ahí
   * pisaría el carrito guardado sin haberlo leído.
   */
  const sembrado = useRef(false);
  useEffect(() => {
    if (sembrado.current || !replacingOrder || !cart.hydrated) return;
    sembrado.current = true;

    const vacio =
      Object.keys(cart.cart).length === 0 && Object.keys(promos.state).length === 0;
    if (!vacio) return;

    cart.seed(replacingOrder.items);
    promos.seed(replacingOrder.promotions);
  }, [replacingOrder, cart, promos]);
  // TODO lo que se pinta —el botón, la cabecera, el resumen— sale de aquí. Dos
  // estados separados que se suman por su cuenta en cada pantalla producen el
  // fallo clásico: "0 productos, Bs 0,00" con un combo dentro.
  const unified = unifiedTotals(cart.summary, promos.summary);
  const [checkout, dispatch] = useReducer(checkoutReducer, INITIAL_CHECKOUT_STATE);

  /**
   * Segunda barrera contra el doble envío, además del reducer: cubre el caso de
   * dos toques en el mismo tick, antes de que React aplique el nuevo estado.
   */
  const inFlight = useRef(false);

  const groups = useMemo(
    () => groupByCategory(filterMenuItems(items, category, query)),
    [items, category, query],
  );

  const hasSession = sessionToken !== null;
  // El checkout solo está disponible con un enlace que aún no se haya bloqueado.
  const canCheckout = hasSession && !isSessionBlocked(checkout);
  const frozen = isFrozen(checkout);
  const submitting = checkout.step === 'submitting';

  const cartNotice =
    checkout.sessionBlockReason === 'used'
      ? SESSION_USED_NOTICE
      : checkout.sessionBlockReason === 'invalid'
        ? SESSION_INVALID_NOTICE
        : hasSession
          ? null
          : NO_SESSION_NOTICE;

  /** Combos vendibles AHORA, en el formato que espera el checkout. */
  const cartPromotions = useMemo(
    () =>
      promos.summary.lines.map((line) => ({
        promotion_id: line.promotionId,
        quantity: line.quantity,
        // La revisión que el cliente vio. Si cambió, el servidor lo rechaza en
        // vez de cobrarle una versión que no estaba mirando.
        revision: line.revision,
      })),
    [promos.summary.lines],
  );

  /** Líneas del carrito en el formato que espera el checkout. */
  const cartItems = useMemo(
    () =>
      cart.summary.lines.map((line) => ({
        code: line.product_code,
        quantity: line.quantity,
      })),
    [cart.summary.lines],
  );

  /** Envía el pedido y traduce el resultado a acciones del reducer. */
  const send = useCallback(
    async (token: string, snapshot: Parameters<typeof submitOrder>[1]) => {
      inFlight.current = true;
      try {
        const result = await submitOrder(token, snapshot);

        if (result.ok) {
          dispatch({ type: 'SUCCESS', order: result.order, created: result.created });
          // Único punto de vaciado: solo tras 201 o 200 confirmados. Los dos
          // carritos, o el cliente vería su combo intacto tras pagarlo.
          cart.clear();
          promos.clear();
          setCartOpen(false);
          return;
        }

        dispatch({ type: 'FAILURE', failure: result.failure });
      } finally {
        inFlight.current = false;
      }
    },
    [cart, promos],
  );

  const handleSubmit = useCallback(() => {
    if (inFlight.current || submitting) return;
    if (!sessionToken) return;
    // Guarda explícita: el envío normal solo procede desde el formulario. No se
    // delega en que el reducer ignore SUBMIT, porque entonces `send` correría
    // igual y dispararía una petición sin transición de estado.
    if (!canSubmitState(checkout)) return;

    const validation = validateCheckoutForm(checkout.fields, cartItems, cartPromotions);
    if (!validation.ok) {
      dispatch({ type: 'VALIDATION_FAILED', errors: validation.errors });
      return;
    }

    dispatch({ type: 'SUBMIT', snapshot: validation.value });
    void send(sessionToken, validation.value);
  }, [cartItems, cartPromotions, checkout, sessionToken, submitting, send]);

  const handleRetry = useCallback(() => {
    if (inFlight.current || submitting) return;
    if (!sessionToken || !checkout.snapshot) return;
    if (!canRetryState(checkout)) return;

    // Se reenvía la fotografía guardada, nunca el carrito actual: si el pedido
    // ya se creó, el fingerprint coincide y el backend responde 200.
    dispatch({ type: 'RETRY' });
    void send(sessionToken, checkout.snapshot);
  }, [checkout, sessionToken, submitting, send]);

  const handleFieldChange = useCallback((field: keyof CheckoutFormFields, value: string) => {
    dispatch({ type: 'SET_FIELD', field, value });
  }, []);

  const handleOpenCheckout = useCallback(() => {
    if (!canCheckout) return;
    dispatch({ type: 'OPEN_FORM' });
  }, [canCheckout]);

  const handleBackToCart = useCallback(() => {
    dispatch({ type: 'CLOSE' });
    setCartOpen(true);
  }, []);

  const handleCloseCheckout = useCallback(() => {
    dispatch({ type: 'CLOSE' });
  }, []);

  const handleBackToMenu = useCallback(() => {
    dispatch({ type: 'CLOSE' });
    setCartOpen(false);
  }, []);

  /**
   * Las promociones que se pueden comprar AHORA.
   *
   * El filtro se hace aquí y no en el servidor porque el estado depende del
   * reloj: una promoción que vence a mitad de la sesión deja de mostrarse sin
   * recargar. Y como el instante es el del servidor, no lo decide el celular.
   */
  const vendibles = useMemo(
    () =>
      promotions
        .map((promotion) => ({ promotion, pricing: evaluatePromotion(promotion, ahora) }))
        .filter(({ pricing }) => isPurchasable(pricing)),
    [promotions, ahora],
  );

  const hasResults = groups.length > 0;
  const checkoutOpen = checkout.step === 'form' || checkout.step === 'submitting' || checkout.step === 'failed';
  const showCartButton =
    cart.hydrated && unified.units > 0 && !cartOpen && !checkoutOpen && checkout.step !== 'success';

  return (
    <>
      {/* Barra fija: fondo a todo el ancho, contenido centrado con el catálogo. */}
      <div className="sticky top-0 z-20 bg-donzarco-surface px-4 pt-4 pb-3">
        <div className="mx-auto max-w-5xl space-y-3">
          <SearchBar value={query} onChange={setQuery} />
          <CategoryTabs active={category} onChange={setCategory} />
        </div>
      </div>

      <div className="mx-auto max-w-5xl space-y-6 px-4 pb-40">
        {/* Antes del catálogo y solo si hay algo que ofrecer. Sin promociones
            vendibles no se pinta ni el encabezado: una sección vacía titulada
            "PROMOCIONES" promete algo que no existe. */}
        {vendibles.length > 0 && (
          <section aria-label="Promociones">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-bold tracking-wide text-donzarco-red-dark uppercase">
              <span className="h-4 w-1 rounded-full bg-donzarco-gold" aria-hidden />
              Promociones
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {vendibles.map(({ promotion, pricing }) => (
                <PromoCard
                  key={promotion.id}
                  promotion={promotion}
                  pricing={pricing}
                  quantity={promos.quantity(promotion.id)}
                  now={ahora}
                  onAdd={() => promos.add(promotion.id)}
                  onRemove={() => promos.remove(promotion.id)}
                />
              ))}
            </div>
          </section>
        )}

        {hasResults ? (
          groups.map((group) => (
            <section key={group.category} aria-label={group.label}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-bold tracking-wide text-donzarco-red-dark uppercase">
                <span className="h-4 w-1 rounded-full bg-donzarco-red" aria-hidden />
                {group.label}
              </h2>
              {/* Móvil: 1 columna (igual que antes). Tablet: 2. Desktop amplio: 3. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {group.items.map((item) => (
                  <ProductCard
                    key={item.code}
                    item={item}
                    quantity={cart.quantity(item.code)}
                    onAdd={() => cart.add(item.code)}
                    onRemove={() => cart.remove(item.code)}
                  />
                ))}
              </div>
            </section>
          ))
        ) : (
          <p className="rounded-2xl bg-white px-4 py-10 text-center text-sm text-zinc-500 ring-1 ring-zinc-200">
            No encontramos nada con “{query.trim()}”. Prueba con otra palabra o
            elige otra categoría.
          </p>
        )}
      </div>

      {showCartButton ? (
        <CartButton
          units={unified.units}
          total={unified.total}
          onOpen={() => setCartOpen(true)}
        />
      ) : null}

      <CartPanel
        open={cartOpen && unified.units > 0 && !checkoutOpen && checkout.step !== 'success'}
        summary={cart.summary}
        promoSummary={promos.summary}
        items={items}
        now={ahora}
        onClose={() => setCartOpen(false)}
        onAdd={cart.add}
        onRemove={cart.remove}
        onAddPromo={promos.add}
        onRemovePromo={promos.remove}
        onContinue={handleOpenCheckout}
        canCheckout={canCheckout}
        checkoutNotice={cartNotice}
      />

      <CheckoutPanel
        open={checkoutOpen}
        fields={checkout.fields}
        errors={checkout.errors}
        summary={cart.summary}
        promoSummary={promos.summary}
        submitting={submitting}
        frozen={frozen}
        failure={checkout.failure}
        canRetry={canRetryState(checkout)}
        canSubmit={canSubmitState(checkout)}
        onChange={handleFieldChange}
        onSubmit={handleSubmit}
        onRetry={handleRetry}
        onBackToCart={handleBackToCart}
        onClose={handleCloseCheckout}
      />

      {checkout.step === 'success' && checkout.order ? (
        <OrderSuccess order={checkout.order} onBackToMenu={handleBackToMenu} />
      ) : null}
    </>
  );
}
