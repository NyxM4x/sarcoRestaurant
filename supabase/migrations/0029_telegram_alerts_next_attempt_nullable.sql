-- ============================================================================
-- 0029 — `telegram_alerts.next_attempt_at` vuelve a ser anulable
--
-- 0028 dejó dos restricciones que juntas son imposibles de satisfacer, y el
-- resultado es que NINGUNA alerta podía cerrarse jamás.
--
-- ── Las dos reglas que se contradicen ───────────────────────────────────────
--
-- La columna se declaró `not null default now()`, con este comentario justo
-- encima: «NULL = no agendada, invisible para el worker». El comentario
-- describe el diseño correcto —es el mismo de `webhook_events` en 0016 y de
-- `order_notifications` en 0005, donde la columna SÍ es anulable—; el
-- `not null` lo contradice.
--
-- Cincuenta líneas más abajo, el CHECK `terminal_not_scheduled` exige
-- exactamente lo que el `not null` prohíbe:
--
--     status in ('pending', 'sending') or next_attempt_at is null
--
-- Así que para pasar a `sent` o `failed` hace falta `next_attempt_at = null`,
-- y ese valor la columna no lo admite. No hay valor que cumpla las dos.
--
-- ── Lo que provocaba: cinco avisos por pedido ───────────────────────────────
--
-- El envío salía BIEN. Lo que reventaba era la escritura del desenlace:
--
--   1. el fast path reclama la fila y manda el aviso — sale el mensaje;
--   2. `markSent` intenta `next_attempt_at = null` y choca con el `not null`;
--   3. `runClaimedAlert` traga la excepción (perder el desenlace se consideraba
--      recuperable) y la fila se queda en `sending` con su lease de 60 s;
--   4. al vencer el lease, `claim_due_telegram_alerts` la recupera —acepta una
--      `sending` con lease vencido— y vuelve a mandar el MISMO aviso;
--   5. repetir hasta `attempts = max_attempts`.
--
-- Cinco mensajes idénticos al grupo de reparto, uno por minuto, y la fila
-- terminando en `sending` para siempre: ni `sent` ni `failed`, o sea fuera del
-- panel de fallidas, que es justo donde una persona habría podido verla.
--
-- El backoff de 30 s / 2 min / 8 min no llegaba a notarse porque `reschedule`
-- nunca se llamaba: la cadencia real era la del lease.
--
-- Es exactamente el duplicado que 0028 venía a impedir —dos repartidores
-- saliendo con el mismo pedido—, reintroducido por el tipo de una columna.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0028.
-- Postgres / Supabase.
-- ============================================================================

begin;

-- ── El arreglo ──────────────────────────────────────────────────────────────
--
-- La columna vuelve a ser anulable. El `default now()` se conserva: una fila
-- NUEVA nace agendada para ya, que es lo que se quiere; lo que cambia es que
-- una fila TERMINAL puede desagendarse, que es lo que el CHECK pedía.
alter table public.telegram_alerts
  alter column next_attempt_at drop not null;

-- ── Las filas que quedaron atascadas ────────────────────────────────────────
--
-- Se cierran como `sent`, no como `failed`: el mensaje SÍ salió por Telegram
-- —varias veces— y `last_error` está en null porque no hubo ningún error de
-- envío. Marcarlas `failed` diría que el grupo no se enteró, y es al revés.
--
-- `sent_at` se pone a `updated_at`, el instante del último intento real, en vez
-- de a `now()`: es la hora en que de verdad salió el aviso, y ninguna alerta
-- histórica debería aparecer enviada en el momento de aplicar la migración.
update public.telegram_alerts
   set status          = 'sent',
       sent_at         = updated_at,
       next_attempt_at = null,
       claimed_until   = null
 where status  = 'sending'
   and sent_at is null;

commit;
