'use client';

import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import type { MenuItem } from '@/types';
import { useCart } from '@/lib/cart/use-cart';
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
  sessionToken,
}: {
  items: MenuItem[];
  sessionToken: string | null;
}) {
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [query, setQuery] = useState('');
  const [cartOpen, setCartOpen] = useState(false);

  const cart = useCart(items);
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
          // Único punto de vaciado: solo tras 201 o 200 confirmados.
          cart.clear();
          setCartOpen(false);
          return;
        }

        dispatch({ type: 'FAILURE', failure: result.failure });
      } finally {
        inFlight.current = false;
      }
    },
    [cart],
  );

  const handleSubmit = useCallback(() => {
    if (inFlight.current || submitting) return;
    if (!sessionToken) return;
    // Guarda explícita: el envío normal solo procede desde el formulario. No se
    // delega en que el reducer ignore SUBMIT, porque entonces `send` correría
    // igual y dispararía una petición sin transición de estado.
    if (!canSubmitState(checkout)) return;

    const validation = validateCheckoutForm(checkout.fields, cartItems);
    if (!validation.ok) {
      dispatch({ type: 'VALIDATION_FAILED', errors: validation.errors });
      return;
    }

    dispatch({ type: 'SUBMIT', snapshot: validation.value });
    void send(sessionToken, validation.value);
  }, [cartItems, checkout, sessionToken, submitting, send]);

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

  const hasResults = groups.length > 0;
  const checkoutOpen = checkout.step === 'form' || checkout.step === 'submitting' || checkout.step === 'failed';
  const showCartButton = cart.hydrated && cart.units > 0 && !cartOpen && !checkoutOpen && checkout.step !== 'success';

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
          units={cart.units}
          total={cart.summary.total}
          onOpen={() => setCartOpen(true)}
        />
      ) : null}

      <CartPanel
        open={cartOpen && cart.units > 0 && !checkoutOpen && checkout.step !== 'success'}
        summary={cart.summary}
        items={items}
        onClose={() => setCartOpen(false)}
        onAdd={cart.add}
        onRemove={cart.remove}
        onContinue={handleOpenCheckout}
        canCheckout={canCheckout}
        checkoutNotice={cartNotice}
      />

      <CheckoutPanel
        open={checkoutOpen}
        fields={checkout.fields}
        errors={checkout.errors}
        summary={cart.summary}
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
