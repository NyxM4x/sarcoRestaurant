-- ============================================================================
-- 0023 — Claim de captura de comprobantes (arregla el comprobante huérfano)
--
-- Sin esto, 0021 tenía una ventana real de pérdida: la fila se insertaba en
-- `pending`, después se subía el archivo y solo entonces pasaba a `stored`. Si
-- el proceso moría entre insertar y subir, la fila quedaba en `pending` para
-- siempre — y una reentrega de Kapso encontraba el WAMID ya existente, decidía
-- "ya capturado" y se marchaba. El comprobante del cliente se perdía en
-- silencio, que es la peor forma de perderlo.
--
-- ── El claim con arrendamiento (lease) ──────────────────────────────────────
--
-- Ahora la fila nace RECLAMADA (`capturing`) por un token concreto y con la
-- hora del claim. Eso permite distinguir tres situaciones que antes se
-- confundían en una sola:
--
--   * `stored`                         → ya está: no se repite nada.
--   * `capturing` con claim FRESCO     → otro worker está en ello ahora mismo.
--   * `capturing` con claim VENCIDO    → aquel worker murió: se puede reintentar.
--
-- El mismo patrón que ya usa `order_notifications` desde 0004 (claim_token +
-- claimed_at + estado intermedio), por coherencia con la casa.
--
-- ── El CAS del cierre ───────────────────────────────────────────────────────
--
-- `markStored` pasa a ser condicional sobre el token: solo cierra quien todavía
-- sostiene el claim. Un worker resucitado que vuelve de una pausa larga, cuya
-- fila ya fue re-reclamada por otro, PIERDE (`lost_claim`) en vez de pisar el
-- trabajo del que sí terminó.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0022.
-- Postgres / Supabase.
-- ============================================================================

begin;

-- ── Columnas del claim ──────────────────────────────────────────────────────

alter table public.payment_proofs
  add column if not exists claim_token uuid,
  add column if not exists claimed_at  timestamptz;

-- ── Estado intermedio `capturing` ───────────────────────────────────────────
-- Se reemplaza el CHECK para admitir el estado nuevo. `pending` se conserva por
-- compatibilidad con cualquier fila anterior a esta migración.

alter table public.payment_proofs
  drop constraint if exists payment_proofs_capture_status_check;

alter table public.payment_proofs
  add constraint payment_proofs_capture_status_check
  check (capture_status in ('pending', 'capturing', 'stored', 'failed'));

-- Coherencia: mientras se captura hay SIEMPRE un claim con su hora. Sin esto,
-- una fila `capturing` sin token sería irreclamable e irreintentable: el mismo
-- agujero que esta migración viene a cerrar, con otro nombre.
alter table public.payment_proofs
  drop constraint if exists payment_proofs_claim_coherence;

alter table public.payment_proofs
  add constraint payment_proofs_claim_coherence check (
    (capture_status = 'capturing' and claim_token is not null and claimed_at is not null)
    or capture_status <> 'capturing'
  );

-- Búsqueda de claims vencidos (reintento). Parcial: solo interesan los que
-- siguen en curso, que son unos pocos en cualquier momento dado.
create index if not exists idx_payment_proofs_stale_claims
  on public.payment_proofs (claimed_at)
  where capture_status = 'capturing';

commit;
