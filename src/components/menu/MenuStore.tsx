'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { MenuItem } from '@/types';
import { useCart } from '@/lib/cart/use-cart';
import { usePromoCart } from '@/lib/cart/use-promo-cart';
import { useServerClock } from '@/lib/menu/use-server-clock';
import { unifiedTotals } from '@/lib/cart/promo-cart';
import { evaluatePromotion, isPurchasable, type Promotion } from '@/lib/promotions/promotion';
import { orderSectionsForMode, promoModeAt } from '@/lib/promotions/promo-mode';
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

const NO_SESSION_NOTICE = 'Abre el menú desde WhatsApp para confirmar tu pedido.';
/** Pedidos nuevos pausados por saturación (0038, 14-09-2026). */
const ORDERS_PAUSED_NOTICE =
  'Estamos con demasiados pedidos y pausamos los nuevos por un rato. Vuelve a intentarlo en unos minutos.';
/** El enlace ya tiene un pedido: 201, 200 idempotente o 409. */
const SESSION_USED_NOTICE =
  'Este enlace ya fue utilizado. Vuelve a WhatsApp para solicitar un nuevo enlace y realizar otro pedido.';
/** El enlace no es válido o venció: 401. */
const SESSION_INVALID_NOTICE =
  'Este enlace ya no es válido. Vuelve a WhatsApp y solicita nuevamente el menú.';
/**
 * El enlace venía a CAMBIAR un pedido que ya está pagado (07-09-2026).
 *
 * Empieza por la buena noticia y a propósito: quien lee esto acaba de armar un
 * carrito que no va a poder mandar, y lo primero que necesita saber es que su
 * pedido no se perdió. Después, qué hacer con lo que quería añadir.
 *
 * No lo manda a hablar con nadie: al escribir por WhatsApp recibe el botón del
 * menú, que es exactamente lo que hace falta para el pedido nuevo.
 */
const ORDER_PAID_NOTICE =
  'Tu pedido anterior ya está pagado y en preparación, así que este enlace ya no puede ' +
  'cambiarlo. Escribinos por WhatsApp y armamos un pedido nuevo con lo que falte.';

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
  ordersPaused = false,
  whatsappChatUrl = null,
}: {
  /**
   * El chat de WhatsApp del negocio (`wa.me`), armado en el servidor. Es el
   * botón de la pantalla de "Pedido registrado"; `null` = número sin configurar.
   */
  whatsappChatUrl?: string | null;
  /**
   * ¿Pedidos nuevos pausados por saturación? (0038) Leído en el servidor. Se
   * puede mirar el menú y armar el carrito, pero no confirmar.
   */
  ordersPaused?: boolean;
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
  const [cartOpen, setCartOpen] = useState(false);

  /**
   * El alto REAL de la barra fija, publicado como `--menu-bar-h`
   * (EXPERIMENTAL, rediseno-menu-fastfood, 17-09-2026).
   *
   * Los encabezados de categoría se anclan justo debajo de la barra, así que
   * necesitan su alto. Escribirlo a mano como número mágico envejece mal: basta
   * que alguien cambie el padding del buscador para que los títulos queden
   * tapados a medias, y es de esas cosas que nadie vuelve a mirar.
   *
   * Medirlo en vivo lo mantiene correcto solo. `globals.css` trae un valor de
   * arranque para el primer render (aquí todavía no hay DOM que medir).
   */
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const barra = barRef.current;
    if (!barra) return;

    const publicar = () => {
      document.documentElement.style.setProperty('--menu-bar-h', `${barra.offsetHeight}px`);
    };
    publicar();

    // El alto cambia al rotar el teléfono o si el texto crece: no basta medirlo
    // una vez al montar.
    const observer = new ResizeObserver(publicar);
    observer.observe(barra);
    return () => observer.disconnect();
  }, []);

  // El instante del servidor, avanzando. Sin esto, una pestaña abierta desde
  // hace horas seguiría mostrando una promoción que ya venció.
  const ahora = useServerClock(serverNow);

  /**
   * ¿Noche de promoción? (14-09-2026). Ver `promotions/promo-mode`.
   *
   * Con el reloj del servidor, igual que las tarjetas de los combos: a las 00:00
   * la pestaña abierta vuelve sola al menú de siempre —orden, sueltos y
   * efectivo— sin recargar.
   */
  const modo = useMemo(() => promoModeAt(promotions, ahora), [promotions, ahora]);
  // `modo` es un objeto nuevo en cada tick del reloj. La lista de productos solo
  // tiene que rehacerse cuando cambia QUÉ se esconde, no cada 30 segundos.
  const soloEnCombo = [...modo.comboOnlyCodes].sort().join(',');

  /**
   * Lo que se puede VER: el catálogo menos lo que esta noche va solo en combo.
   *
   * El suelto se esconde en vez de pintarse "Agotado": no está agotado, está
   * dentro de la tarjeta de arriba, y un Trancapecho en gris debajo del combo de
   * Trancapechos haría pensar que el combo tampoco se puede pedir.
   */
  const visibles = useMemo(() => {
    const ocultos = new Set(soloEnCombo === '' ? [] : soloEnCombo.split(','));
    return ocultos.size === 0 ? items : items.filter((item) => !ocultos.has(item.code));
  }, [items, soloEnCombo]);

  /**
   * Lo que se puede COBRAR, que no es lo que se puede VER (07-09-2026).
   *
   * Desde que la vitrina enseña los agotados en gris, `items` trae también lo
   * que no está a la venta. El carrito no puede verlo: `calculateOrder` recorre
   * la lista que se le pasa y hace una línea de todo lo que tenga cantidad, así
   * que pasarle la lista entera resucitaría el producto agotado que quedó
   * guardado en el navegador del cliente — y se lo cobraría.
   *
   * El servidor lo rechazaría al crear el pedido (`orders/service` usa
   * `listActive`), pero eso es un error DESPUÉS de que el cliente lo dio por
   * pedido. La lista de aquí es la que evita llegar hasta ahí.
   *
   * Sale de `visibles` y no de `items`: el Trancapecho que quedó en el carrito
   * antes de la promoción tampoco puede cobrarse suelto esta noche.
   */
  const aLaVenta = useMemo(() => visibles.filter((item) => item.is_active), [visibles]);

  const cart = useCart(aLaVenta);
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

  const modoActivo = modo.active;
  const groups = useMemo(
    () =>
      // En noche de promoción las bebidas suben debajo de Promociones: son lo
      // que acompaña al combo. A las 00:00 vuelve el orden de siempre.
      orderSectionsForMode(groupByCategory(filterMenuItems(visibles, category)), {
        active: modoActivo,
      }),
    [visibles, category, modoActivo],
  );

  /**
   * El formulario tal como se pinta y se envía.
   *
   * Sin efectivo, el método es QR y punto; sin recojo, la entrega es envío y
   * punto. Se DERIVA aquí en vez de escribirlo en el reducer con un efecto. Así
   * no hay un render con "Efectivo" o "Recojo" marcado en un formulario que ya
   * no lo ofrece, y a las 00:00 lo que el cliente había elegido sigue intacto.
   */
  const fields = useMemo(() => {
    let f = checkout.fields;
    if (!modo.cashAllowed && f.payment_method !== 'qr') f = { ...f, payment_method: 'qr' as const };
    if (!modo.pickupAllowed && f.delivery_type !== 'delivery') {
      f = { ...f, delivery_type: 'delivery' as const };
    }
    return f;
  }, [checkout.fields, modo.cashAllowed, modo.pickupAllowed]);

  const hasSession = sessionToken !== null;
  // El checkout solo está disponible con un enlace que aún no se haya bloqueado,
  // y con los pedidos nuevos abiertos (0038).
  const canCheckout = hasSession && !isSessionBlocked(checkout) && !ordersPaused;
  const frozen = isFrozen(checkout);
  const submitting = checkout.step === 'submitting';

  const cartNotice = ordersPaused
    ? ORDERS_PAUSED_NOTICE
    : checkout.sessionBlockReason === 'used'
      ? SESSION_USED_NOTICE
      : checkout.sessionBlockReason === 'invalid'
        ? SESSION_INVALID_NOTICE
        : checkout.sessionBlockReason === 'paid'
          ? ORDER_PAID_NOTICE
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

    // `fields` y no `checkout.fields`: lo que se envía es lo que se ve.
    const validation = validateCheckoutForm(fields, cartItems, cartPromotions);
    if (!validation.ok) {
      dispatch({ type: 'VALIDATION_FAILED', errors: validation.errors });
      return;
    }

    dispatch({ type: 'SUBMIT', snapshot: validation.value });
    void send(sessionToken, validation.value);
  }, [cartItems, cartPromotions, checkout, fields, sessionToken, submitting, send]);

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
      {/* Barra fija: fondo a todo el ancho, contenido centrado con el catálogo.
          EXPERIMENTAL (rediseno-menu-fastfood): vidrio oscuro en vez del crema
          de siempre, para no desentonar con el degradado de `page.tsx`. */}
      <div
        ref={barRef}
        className="sticky top-0 z-20 bg-donzarco-ink/85 px-4 pt-4 pb-3 shadow-lg shadow-black/20 backdrop-blur-md"
      >
        <div className="mx-auto max-w-5xl space-y-3">
          <CategoryTabs active={category} onChange={setCategory} />
        </div>
      </div>

      <div className="mx-auto max-w-5xl space-y-6 px-4 pb-40">
        {/* Antes del catálogo y solo si hay algo que ofrecer. Sin promociones
            vendibles no se pinta ni el encabezado: una sección vacía titulada
            "PROMOCIONES" promete algo que no existe. */}
        {vendibles.length > 0 && (
          <section aria-label="Promociones">
            <SectionHeader label="Promociones" tone="promo" />
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
              <SectionHeader label={group.label} />
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
          <p className="rounded-3xl bg-donzarco-ink/80 px-4 py-10 text-center text-sm text-white/80 ring-1 ring-white/15 backdrop-blur-sm">
            {/* Sin buscador (17-09-2026) esto ya solo puede pasar si la
                categoría elegida quedó sin nada que ofrecer. */}
            Por ahora no hay nada en esta categoría. Elige otra.
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
        fields={fields}
        cashAllowed={modo.cashAllowed}
        pickupAllowed={modo.pickupAllowed}
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
        <OrderSuccess order={checkout.order} whatsappChatUrl={whatsappChatUrl} />
      ) : null}
    </>
  );
}

/**
 * Encabezado de categoría, anclado mientras dura su sección (EXPERIMENTAL,
 * rediseno-menu-fastfood, 17-09-2026).
 *
 * ── El arrastre y el empujón son de CSS, no de JavaScript ───────────────────
 *
 * Antes era texto suelto que se perdía al primer deslizamiento: a media lista
 * uno ya no sabía si seguía en Platos o en Bebidas. Ahora cada encabezado es
 * `sticky` DENTRO de su propia `<section>`, y ahí está todo el truco:
 *
 *   - mientras se recorre su sección, se queda clavado bajo la barra;
 *   - cuando la sección se acaba, su propio borde inferior lo empuja hacia
 *     arriba, y el encabezado de la siguiente ocupa el lugar.
 *
 * No hace falta escuchar el scroll ni medir posiciones: el navegador lo hace
 * solo porque el contenedor que lo limita es su sección. Por eso importa que
 * ningún ancestro entre la sección y aquí tenga `overflow` distinto de
 * `visible` — eso rompería el anclaje sin decir nada (ver `page.tsx`, que
 * evita `overflow-hidden` en el `<main>` a propósito).
 *
 * `z-10` contra el `z-20` de la barra: al ser empujado, el encabezado pasa por
 * DEBAJO del vidrio del buscador en vez de encima.
 */
function SectionHeader({ label, tone = 'catalogo' }: { label: string; tone?: 'catalogo' | 'promo' }) {
  const fondo =
    tone === 'promo'
      ? 'from-donzarco-gold via-orange-500 to-red-600'
      : 'from-red-700 via-red-600 to-orange-500';

  return (
    <h2
      className={`sticky top-[var(--menu-bar-h)] z-10 -mx-4 mb-3 overflow-hidden bg-gradient-to-r px-4 py-2 shadow-lg shadow-black/30 ring-1 ring-black/20 ${fondo}`}
    >
      {/* La trama de puntos va en su propia capa para que el texto no la herede. */}
      <span className="menu-halftone pointer-events-none absolute inset-0 opacity-40" aria-hidden />
      <span className="font-display relative text-2xl tracking-wider text-yellow-300 italic uppercase drop-shadow-[0_2px_0_rgba(0,0,0,0.55)]">
        {label}
      </span>
    </h2>
  );
}
