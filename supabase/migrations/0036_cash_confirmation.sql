-- ============================================================================
-- 0036 — El pedido en efectivo no se agenda hasta que el cliente lo confirme
--
-- La madrugada del 05-09-2026, dos clientes seguidos:
--
--   #40  ve "Delivery: Bs. 27"  →  "Muy caro su moto"  →  nunca volvió
--   #39  ve "Delivery: Bs. 30"  →  "Cancelar pedido"   →  pidió una persona
--
-- Los dos pedidos ya estaban en el grupo de reparto cuando eso pasó. En
-- efectivo el aviso sale al COTIZAR —no hay pago que esperar, así que ese era
-- el único momento disponible— y el cliente ve el costo del envío en ese mismo
-- instante. Si le parece caro, el negocio ya tiene una comanda que nadie va a
-- llevar y un repartidor que puede haberla tomado.
--
-- Con esta columna el pedido en efectivo pasa a tener dos momentos: cotizado
-- —tiene su total, y el cliente decide— y CONFIRMADO, que es cuando entra a
-- cocina y sale al reparto.
--
-- ── Por qué una columna y no un estado nuevo ────────────────────────────────
--
-- `orders.status` describe dónde está el pedido en la cocina: nuevo, en la
-- plancha, listo, en camino. "El cliente todavía no dijo que sí" no es un sitio
-- de la cocina — es un hecho sobre el cliente, y cabe en su propia columna sin
-- tocar el dominio de un estado que leen seis pantallas.
--
-- ── Por qué un TIMESTAMP y no un booleano ───────────────────────────────────
--
-- Porque la pregunta que se va a hacer no es solo "¿confirmó?" sino "¿cuánto
-- lleva sin confirmar?": el pedido que nadie contesta se cancela solo a los
-- veinte minutos. Un booleano obligaría a mirar `created_at` y suponer, y esa
-- suposición se rompe el día que la cotización tarde.
--
-- NULL significa "todavía no", y para un pedido por QR significa "no aplica":
-- ahí lo que confirma es el comprobante, y esta columna no se mira nunca.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0035.
-- REQUISITO OPERATIVO: aplicar ANTES de desplegar el código que la usa. El
-- tablero de cocina la lee para no enseñar pedidos sin confirmar; sin la
-- columna, esa consulta falla y la cocina se queda sin tablero.
-- Postgres / Supabase.
-- ============================================================================

begin;

alter table orders
  add column if not exists cash_confirmed_at timestamptz;

comment on column orders.cash_confirmed_at is
  'Cuándo el cliente confirmó su pedido en EFECTIVO por WhatsApp (escribió '
  'CONFIRMO). NULL = todavía no lo hizo, y entonces el pedido no entra a cocina '
  'ni sale al grupo de reparto. En pedidos por QR es siempre NULL: allí lo que '
  'confirma el pedido es el comprobante aceptado.';

-- Índice PARCIAL para la única pregunta que se le hace a esta columna desde un
-- barrido: "¿qué pedidos en efectivo llevan demasiado tiempo sin confirmar?".
-- Los confirmados no tienen por qué ocupar sitio en él.
create index if not exists ix_orders_cash_pending
  on orders (created_at)
  where cash_confirmed_at is null and payment_method = 'cash';

commit;
