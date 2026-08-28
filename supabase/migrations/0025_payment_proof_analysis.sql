-- ============================================================================
-- 0025 — Análisis automático del comprobante (filtro anti-retoque)
--
-- 0021 dejó `analysis_status` preparado para "un analizador automático que hoy
-- NO existe". Esta migración le da sitio al resultado de ese analizador.
--
-- ── Qué problema resuelve ───────────────────────────────────────────────────
--
-- Desde que cocina revisa los comprobantes, quien mira la pantalla decide con
-- prisa y con las manos ocupadas. Un comprobante retocado —cambiar el monto, o
-- reenviar el de otro pedido— pasa el filtro humano justo en la hora punta, que
-- es cuando más se intenta. Los errores del retoque, en cambio, son casi
-- siempre puntuales y comprobables: la cuenta destino, el nombre del titular,
-- el monto y el número de transacción.
--
-- El análisis los lee y los contrasta. NO decide nada: no acepta, no rechaza y
-- no oculta el comprobante. Solo deja escrito qué encontró para que la persona
-- que revisa lo vea antes de pulsar.
--
-- ── Por qué el veredicto y los motivos viven separados ──────────────────────
--
-- `analysis_verdict` responde "¿hay que mirar esto con lupa?" y los motivos
-- dicen POR QUÉ. Sin los motivos, una alerta es un color que no se puede
-- discutir ni auditar: nadie sabe si saltó por el monto o por el nombre, y una
-- alerta que no se entiende se aprende a ignorar en una semana.
--
-- ── El número de transacción es el dato más valioso ─────────────────────────
--
-- El hash del contenido (0021) reconoce el MISMO archivo reenviado. No reconoce
-- una captura nueva del mismo pago —otro recorte, otro brillo, otro teléfono—,
-- que es el reenvío que de verdad se intenta. El número de transacción sí: es
-- el identificador del banco, y repetirlo en dos pedidos distintos es un hecho,
-- no una sospecha. Por eso lleva índice propio.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0024.
-- Postgres / Supabase.
-- ============================================================================

begin;

alter table public.payment_proofs
  -- Veredicto del análisis. NULL mientras no se haya analizado.
  add column if not exists analysis_verdict   text,
  -- Códigos de motivo, en el orden en que se detectaron. Vacío = nada que decir.
  add column if not exists analysis_reasons   text[] not null default '{}',
  -- Lo que el análisis leyó en la imagen. Se guarda para poder contrastar
  -- después, no para presentarlo como verdad: son datos de una lectura óptica.
  add column if not exists analysis_amount    numeric(10, 2),
  add column if not exists analysis_reference text,
  -- Modelo que hizo la lectura, para poder explicar un resultado viejo.
  add column if not exists analysis_model     text,
  add column if not exists analyzed_at        timestamptz;

-- Dominio cerrado del veredicto.
--
--   ok          lo leído cuadra con la cuenta y el monto esperados;
--   suspicious  hay al menos un dato que NO cuadra (los motivos dicen cuál);
--   unreadable  no se pudo leer lo suficiente. NO es una acusación: una foto
--               borrosa o un recorte a medias acaban aquí, y el operador decide
--               igual que antes de que existiera el análisis.
alter table public.payment_proofs
  drop constraint if exists payment_proofs_analysis_verdict_check;
alter table public.payment_proofs
  add constraint payment_proofs_analysis_verdict_check
  check (analysis_verdict is null or analysis_verdict in ('ok', 'suspicious', 'unreadable'));

-- Coherencia: hay veredicto EXACTAMENTE cuando el análisis terminó bien. Sin
-- esto cabría un `pending` con veredicto —una alerta que nadie sabe de dónde
-- salió— o un `done` sin él, que es una casilla vacía imposible de interpretar.
alter table public.payment_proofs
  drop constraint if exists payment_proofs_analysis_coherence;
alter table public.payment_proofs
  add constraint payment_proofs_analysis_coherence check (
    (analysis_status = 'done' and analysis_verdict is not null and analyzed_at is not null)
    or (analysis_status <> 'done' and analysis_verdict is null)
  );

-- Reutilización del número de transacción: el mismo identificador del banco en
-- dos comprobantes distintos. Parcial porque solo interesan los que lo tienen.
create index if not exists idx_payment_proofs_analysis_reference
  on public.payment_proofs (analysis_reference)
  where analysis_reference is not null;

commit;
