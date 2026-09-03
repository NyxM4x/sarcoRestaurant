-- ============================================================================
-- 0033 — Quién decide si el envío ya está pagado: una persona
--
-- El ticket de cocina dice qué se cobra en la puerta, y hasta ahora esa frase
-- salía SIEMPRE de una deducción: la etiqueta del análisis del comprobante y,
-- si no la había, la regla general del pedido. Cuando la deducción no alcanza
-- —el modelo no pudo leer el monto, o leyó una cifra que no cuadra con ninguno
-- de los dos importes válidos— el ticket seguía afirmando "COBRAR ENVÍO", y esa
-- afirmación no la había comprobado nadie.
--
-- Pasó de verdad. Clientes que pagaron el total por QR recibieron al repartidor
-- pidiéndoles el envío otra vez, y el repartidor no tenía cómo saberlo: en la
-- puerta de una casa no se abre un comprobante.
--
-- ── Por qué una marca manual y no una regla más lista ───────────────────────
--
-- Se puede afinar la deducción —tratar "pagó de más" como envío cubierto, por
-- ejemplo— pero eso solo mueve la frontera: siempre habrá un comprobante
-- borroso, un monto ilegible o un cliente que transfirió en dos veces. Debajo
-- de toda regla automática queda un caso que solo se resuelve mirando la
-- imagen, y quien la mira es quien empaca.
--
-- Así que esto no compite con el análisis: lo remata. La deducción sigue siendo
-- la respuesta por defecto, y esta columna es la palabra de quien miró.
--
-- ── Tres estados, no dos ────────────────────────────────────────────────────
--
--   NULL   nadie se pronunció. Manda la deducción de siempre.
--   true   una persona vio el comprobante y dice que el envío está pagado.
--   false  una persona vio el comprobante y dice que hay que cobrarlo.
--
-- `false` NO es lo mismo que NULL, y por eso la columna es anulable en vez de
-- tener un default. NULL significa "no consta"; `false` significa "consta que
-- hay que cobrar", y el ticket puede decir la segunda con seguridad y la
-- primera solo con reservas.
--
-- ── Por qué vive en `orders` y no en `payment_proofs` ───────────────────────
--
-- Porque no es un juicio sobre un ARCHIVO: es un hecho sobre el PEDIDO. El
-- cliente pudo pagar en dos comprobantes, o traer el dinero en la mano, o
-- haberlo arreglado por teléfono. Colgarlo de un comprobante obligaría a elegir
-- cuál de ellos lleva la marca, y a repetirla si mañana llega otro.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0032.
-- Postgres / Supabase.
-- ============================================================================

begin;

alter table public.orders
  add column if not exists delivery_fee_paid boolean;

-- Cuándo se marcó. Solo para poder reconstruir después qué se sabía y desde
-- cuándo: si un cliente reclama, la diferencia entre "se marcó antes de salir"
-- y "se marcó al volver" es toda la historia.
alter table public.orders
  add column if not exists delivery_fee_paid_at timestamptz;

-- Las dos columnas van juntas o no van.
--
-- Una marca sin fecha no se puede auditar y una fecha sin marca no significa
-- nada. El CHECK lo impide en la base y no en el código que escribe, porque
-- mañana habrá otro código que escriba.
alter table public.orders
  drop constraint if exists orders_delivery_fee_paid_coherence;
alter table public.orders
  add constraint orders_delivery_fee_paid_coherence
  check (
    (delivery_fee_paid is null and delivery_fee_paid_at is null)
    or (delivery_fee_paid is not null and delivery_fee_paid_at is not null)
  );

commit;
