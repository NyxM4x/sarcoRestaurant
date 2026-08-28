-- ============================================================================
-- 0026 — Numeración por JORNADA de servicio (reinicia en 1 cada noche)
--
-- Hasta ahora el número salía de una secuencia global: `ORD-000019`, creciendo
-- para siempre. El dueño pidió que empiece en 1 cada día, y tiene razón: en
-- cocina se grita "¡el siete!", no "¡el cero cero cero cero diecinueve!".
--
-- ── El local cierra DESPUÉS de medianoche ───────────────────────────────────
--
-- Don Zarco abre a las 18:00 y cierra a las 04:00. Reiniciar el contador a
-- medianoche partiría cada noche en dos y dejaría DOS "pedido 1" en el mismo
-- servicio, con dos comandas distintas y el mismo nombre. Así que el corte va
-- al mediodía: la jornada del 28 va del 28 a las 12:00 al 29 a las 12:00, hora
-- de Bolivia, y el servicio entero cabe holgado dentro.
--
-- Es la MISMA definición que usa `src/lib/orders/business-day.ts` para el
-- tablero de cocina y los filtros del panel. Aquí se expresa con
-- `at time zone 'America/La_Paz'` en vez de con un desfase fijo porque es lo
-- legible en SQL; coinciden siempre, porque Bolivia no tiene horario de verano.
--
-- ── Por qué el número guardado NO es solo "7" ───────────────────────────────
--
-- `order_number` es único para siempre, y tiene que serlo: es la referencia con
-- la que se busca un pedido en el panel, la que viaja en los mensajes y la que
-- alguien dice por teléfono tres días después. Un "7" a secas colisionaría con
-- el 7 de anoche a la primera.
--
-- Así que se guarda `ORD-260828-007`: lleva la jornada dentro, es único, y se
-- ordena solo alfabéticamente. Lo que se PINTA en grande es el `007` — la
-- pantalla decide cómo mostrarlo, la base garantiza que no se repita.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0025.
-- Postgres / Supabase.
-- ============================================================================

begin;

-- ── Contador por jornada ────────────────────────────────────────────────────
--
-- Una fila por noche. `last_number` es el último correlativo entregado.
create table if not exists public.order_daily_counters (
  business_day date primary key,
  last_number  integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint order_daily_counters_last_number_positive check (last_number >= 0)
);

drop trigger if exists trg_order_daily_counters_updated_at on public.order_daily_counters;
create trigger trg_order_daily_counters_updated_at
  before update on public.order_daily_counters
  for each row execute function public.set_updated_at();

alter table public.order_daily_counters enable row level security;

-- ── La jornada de un instante ───────────────────────────────────────────────
--
-- Función aparte y no una expresión repetida: la definición del corte tiene que
-- existir UNA sola vez. El día que el local cambie de horario, esto se toca en
-- un sitio y nada más.
create or replace function public.business_day_of(at timestamptz)
returns date
language sql
immutable
as $$
  -- A hora local, se restan 12 horas y se toma la fecha: todo lo anterior al
  -- mediodía cae en la jornada del día anterior, que es la noche que se estaba
  -- trabajando.
  select ((at at time zone 'America/La_Paz') - interval '12 hours')::date;
$$;

-- ── El número siguiente ─────────────────────────────────────────────────────
--
-- El `insert … on conflict do update … returning` es ATÓMICO: dos pedidos
-- simultáneos en plena hora punta reciben números distintos sin bloquear la
-- tabla ni exigir una transacción especial de quien llama. Comprobar-y-después-
-- incrementar tendría una ventana entre los dos pasos; esto no la tiene.
create or replace function public.next_order_number()
returns text
language plpgsql
as $$
declare
  jornada date;
  correlativo integer;
begin
  jornada := public.business_day_of(now());

  insert into public.order_daily_counters as c (business_day, last_number)
  values (jornada, 1)
  on conflict (business_day)
    do update set last_number = c.last_number + 1
  returning c.last_number into correlativo;

  -- `ORD-AAMMDD-NNN`. Tres dígitos cubren 999 pedidos en una noche; si alguna
  -- vez se pasara, `lpad` no trunca — el número sigue creciendo y sigue siendo
  -- único, solo ocupa un carácter más.
  return 'ORD-' || to_char(jornada, 'YYMMDD') || '-' || lpad(correlativo::text, 3, '0');
end;
$$;

-- La secuencia `order_number_seq` de 0001 queda SIN USO pero no se borra: si
-- hubiera que volver atrás, recrear la función vieja no debería depender además
-- de recuperar el valor al que había llegado la secuencia.

commit;
