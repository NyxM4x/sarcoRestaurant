-- ============================================================================
-- 0028 — Outbox durable de alertas Telegram + etiqueta de monto del comprobante
--
-- Dos cosas sin relación entre sí que viajan juntas porque se decidieron a la
-- vez. Se pueden aplicar por separado: son dos bloques independientes.
--
-- ── Bloque A: por qué un outbox y no un timestamp ───────────────────────────
--
-- Hasta ahora el aviso al grupo de reparto se protegía con
-- `orders.delivery_notice_sent_at`, un timestamp que se escribía ANTES de
-- llamar a Telegram. Si Telegram fallaba después, el pedido quedaba marcado
-- como avisado para siempre: nadie salía a repartirlo y lo único que quedaba
-- era un `log.warn` que nadie lee. El nombre de la columna mentía —decía
-- "enviado" y significaba "reclamado"— y esa mentira es justo la que impide
-- darse cuenta mirando la base.
--
-- El aviso de handoff era peor todavía: no tenía ni columna. El agente se
-- pausaba 120 minutos, el cliente quedaba esperando a una persona, y si
-- Telegram fallaba nadie se enteraba nunca.
--
-- Aquí el estado se escribe DESPUÉS de saber qué pasó, y un fallo transitorio
-- vuelve a la cola. Es el mismo patrón que `order_notifications` lleva meses
-- usando para los mensajes al cliente.
--
-- ── Por qué una tabla propia y no `order_notifications` ─────────────────────
--
-- Aquella está atada a `order_id` y su reconciliación consulta el historial de
-- mensajes de WhatsApp para averiguar si un envío dudoso llegó. Ninguna de las
-- dos cosas sirve aquí: el aviso de handoff no tiene pedido —es de una
-- conversación— y Telegram no se reconcilia leyendo WhatsApp. Meterlos ahí
-- obligaría a dejar la mitad de las columnas en NULL y a que el worker
-- distinguiera dos clases de fila que no se parecen en nada.
--
-- ── Bloque B: por qué una etiqueta y no dos cifras ──────────────────────────
--
-- En delivery, por QR se cobra solo la comida y el envío se paga al recibir el
-- pedido. Pero hay clientes que pagan todo junto por QR, y hasta ahora no
-- había forma de saber cuál de las dos cosas hizo cada uno. El repartidor
-- llegaba sin saber si le tocaba cobrar la carrera.
--
-- La etiqueta lo responde de un vistazo. No es una cifra más en el ticket: son
-- tres palabras, porque un ticket que se mira a un metro y con prisa no admite
-- dos números que hay que comparar mentalmente con un tercero.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0027.
-- Postgres / Supabase.
-- ============================================================================

begin;

-- ══ BLOQUE A — Outbox durable de alertas Telegram ═══════════════════════════

create table if not exists public.telegram_alerts (
  id             uuid primary key default gen_random_uuid(),

  -- Qué clase de aviso es. Decide el texto y el chat de destino, y por eso es
  -- un dominio cerrado: un valor nuevo sin código que lo entienda produciría
  -- una fila que el worker recoge, no sabe enviar y reintenta hasta agotarse.
  kind           text not null,

  -- A qué se refiere el aviso. Para `delivery_notice` es el `orders.id`; para
  -- `handoff_notice`, el teléfono normalizado del cliente.
  --
  -- Va como texto y sin FK a propósito: son dos dominios distintos y una FK
  -- solo podría apuntar a uno. La integridad se gana con la clave única de
  -- abajo, que es lo que de verdad impide el aviso duplicado.
  target_ref     text not null,

  status         text not null default 'pending',

  -- El texto ya construido. Se guarda para que el reintento mande EXACTAMENTE
  -- lo mismo que el primer intento: reconstruirlo en cada intento haría que un
  -- aviso reenviado media hora después dijera cosas distintas —otra dirección
  -- geocodificada, otro importe— sobre el mismo hecho.
  --
  -- Lleva teléfono y ubicación del cliente, igual que el mensaje que sale. La
  -- retención de esta tabla es la del aviso, no la del pedido: ver el borrado
  -- de abajo.
  body           text not null,

  attempts       integer not null default 0,
  max_attempts   integer not null default 5,

  -- Cuándo puede volver a intentarse. NULL = no agendada, invisible para el
  -- worker. Es el mismo invariante que protege a `order_notifications`: una
  -- fila terminal jamás queda agendada, así que no puede resucitar sola.
  next_attempt_at timestamptz not null default now(),

  -- Lease del reclamo. Mientras esté vigente, ninguna otra ejecución la toca.
  claimed_until  timestamptz,

  -- Por qué falló el último intento. Código corto y saneado, nunca el body ni
  -- la respuesta cruda del proveedor.
  last_error     text,

  sent_at        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.telegram_alerts
  drop constraint if exists telegram_alerts_kind_check;
alter table public.telegram_alerts
  add constraint telegram_alerts_kind_check
  check (kind in ('delivery_notice', 'handoff_notice'));

-- Dominio cerrado del estado.
--
--   pending  esperando su turno (o su reintento);
--   sending  reclamada, con lease vigente;
--   sent     confirmada por Telegram. Terminal;
--   failed   intentos agotados o error permanente. Terminal, y visible en el
--            panel para que una persona avise a mano.
alter table public.telegram_alerts
  drop constraint if exists telegram_alerts_status_check;
alter table public.telegram_alerts
  add constraint telegram_alerts_status_check
  check (status in ('pending', 'sending', 'sent', 'failed'));

-- Coherencia: `sent_at` existe EXACTAMENTE cuando el aviso salió.
--
-- Sin esto cabría una fila `sent` sin instante —imposible de auditar— o una
-- `failed` con fecha de envío, que es la contradicción que esta migración
-- viene a eliminar: no se puede volver a marcar "enviado" algo que no se envió.
alter table public.telegram_alerts
  drop constraint if exists telegram_alerts_sent_coherence;
alter table public.telegram_alerts
  add constraint telegram_alerts_sent_coherence check (
    (status = 'sent' and sent_at is not null)
    or (status <> 'sent' and sent_at is null)
  );

-- Un terminal NUNCA queda agendado.
alter table public.telegram_alerts
  drop constraint if exists telegram_alerts_terminal_not_scheduled;
alter table public.telegram_alerts
  add constraint telegram_alerts_terminal_not_scheduled check (
    status in ('pending', 'sending') or next_attempt_at is null
  );

alter table public.telegram_alerts
  drop constraint if exists telegram_alerts_attempts_check;
alter table public.telegram_alerts
  add constraint telegram_alerts_attempts_check
  check (attempts >= 0 and max_attempts between 1 and 10);

-- ── LA CLAVE QUE IMPIDE EL DUPLICADO ────────────────────────────────────────
--
-- Un aviso por (kind, target_ref). Es la garantía que sustituye al claim sobre
-- el timestamp: quien intenta encolar un aviso que ya existe choca contra este
-- índice y no encola nada.
--
-- Sigue siendo cierto lo que decía el código anterior —para el grupo de
-- reparto, un pedido duplicado es peor que uno ausente, porque dos personas
-- podrían salir a llevar lo mismo—. Lo que cambia es que ahora la protección
-- vive en la base y no en el orden de dos escrituras, así que reintentar el
-- ENVÍO ya no arriesga un segundo aviso.
create unique index if not exists idx_telegram_alerts_target
  on public.telegram_alerts (kind, target_ref);

-- El worker selecciona por vencimiento. Parcial: las terminales no se miran.
create index if not exists idx_telegram_alerts_due
  on public.telegram_alerts (next_attempt_at)
  where status in ('pending', 'sending');

-- El panel lista las que fallaron, que es lo único que pide una acción humana.
create index if not exists idx_telegram_alerts_failed
  on public.telegram_alerts (created_at desc)
  where status = 'failed';


-- ── Reclamo atómico ─────────────────────────────────────────────────────────
--
-- `for update skip locked` es lo que permite que dos ticks concurrentes no se
-- peleen por la misma fila: el segundo salta la que el primero tiene tomada en
-- vez de bloquearse esperándola.
--
-- Reclamar SUBE `attempts` en el mismo acto. Contar el intento al terminar
-- dejaría que una invocación muerta a mitad no gastara nada y volviera para
-- siempre.
create or replace function public.claim_due_telegram_alerts(
  p_limit integer,
  p_lease_seconds integer
)
returns setof public.telegram_alerts
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with vencidas as (
    select a.id
      from public.telegram_alerts a
     where a.status in ('pending', 'sending')
       and a.next_attempt_at is not null
       and a.next_attempt_at <= now()
       -- Una `sending` solo se recupera si su lease venció de verdad.
       and (a.status = 'pending' or a.claimed_until is null or a.claimed_until <= now())
       and a.attempts < a.max_attempts
     order by a.next_attempt_at asc
     limit greatest(p_limit, 0)
     for update skip locked
  )
  update public.telegram_alerts t
     set status        = 'sending',
         attempts      = t.attempts + 1,
         claimed_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         updated_at    = now()
    from vencidas v
   where t.id = v.id
  returning t.*;
end;
$$;

-- ── Retención ───────────────────────────────────────────────────────────────
--
-- El body lleva teléfono y ubicación, así que no se guarda para siempre. Se
-- borra lo ya resuelto pasados 30 días; lo `failed` se conserva porque es
-- justo lo que alguien tiene que poder revisar.
create or replace function public.purge_old_telegram_alerts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.telegram_alerts
   where status = 'sent'
     and sent_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;


-- ══ BLOQUE B — Etiqueta de monto del comprobante ════════════════════════════

alter table public.payment_proofs
  -- Contra cuál de los dos importes cuadró lo que el modelo leyó.
  --
  -- Es un DERIVADO calculado en código comparando dos números, no algo que
  -- diga el modelo: el modelo solo lee la cifra. Esa frontera es la misma que
  -- ya separa `analysis-vision` de `analysis`, y da igual de qué lado esté la
  -- etiqueta: leer es percepción, decidir es del negocio.
  add column if not exists analysis_amount_label text;

-- Dominio cerrado.
--
--   pago_total      cuadra con productos + envío. El cliente ya pagó la
--                   carrera y al repartidor no le deben nada;
--   pago_productos  cuadra con el subtotal. El envío se cobra al entregar;
--   revisar_monto   ni una cosa ni la otra —incluido el monto que no se pudo
--                   leer—. Un importe que no se puede confirmar no es un
--                   importe: se mira el comprobante antes de cocinar.
--
-- NULL = no había contra qué comparar (comprobante sin pedido asociado) o el
-- análisis no llegó a correr. Ausencia de dato, nunca un aprobado.
alter table public.payment_proofs
  drop constraint if exists payment_proofs_analysis_amount_label_check;
alter table public.payment_proofs
  add constraint payment_proofs_analysis_amount_label_check
  check (
    analysis_amount_label is null
    or analysis_amount_label in ('pago_total', 'pago_productos', 'revisar_monto')
  );

commit;
