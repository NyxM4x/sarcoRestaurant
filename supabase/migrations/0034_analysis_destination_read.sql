-- 0034 · Lo que el modelo LEYÓ como destino del dinero
--
-- ── Por qué hacen falta estas tres columnas ─────────────────────────────────
--
-- El análisis ya acusaba: `account_mismatch`, `holder_mismatch`,
-- `bank_mismatch`. Lo que no guardaba es CONTRA QUÉ comparó — leía la cuenta,
-- el titular y el banco de la imagen, los contrastaba con los configurados, y
-- tiraba lo leído.
--
-- El efecto se vio la noche del 02→03-09-2026: de 45 comprobantes, 24 salieron
-- `suspicious` y ninguno era falso —se verificaron uno a uno con la banca
-- móvil—. Nueve de ellos acusaban al titular. Con lo leído tirado, saber si el
-- fallo estaba en la LECTURA (el modelo cogió el remitente en vez del
-- beneficiario) o en la COMPARACIÓN (falta un alias) exigía volver a abrir cada
-- imagen a mano, una por una, al día siguiente.
--
-- Una acusación que no se puede auditar acaba ignorándose. Guardar lo leído
-- convierte esa auditoría en una consulta.
--
-- Y sirve dos veces: el ticket puede DECIR lo que leyó —"dice que el dinero fue
-- a: <nombre>"— en vez de afirmar que no es nuestra cuenta. Un hecho se
-- comprueba de un vistazo; una acusación hay que ir a verificarla.
--
-- ── Sobre el dato ───────────────────────────────────────────────────────────
--
-- Es lo que ya viaja hoy en memoria durante el análisis, y de la parte que
-- describe a QUIEN COBRA (el negocio), no a quien paga: el remitente no se
-- guarda ni se guardaba. Nullable siempre: `null` es "no se leyó", y las filas
-- anteriores a esta migración se quedan así para siempre, que es la verdad.

alter table public.payment_proofs
  add column if not exists analysis_destination_account text,
  add column if not exists analysis_destination_holder  text,
  add column if not exists analysis_destination_bank    text;

comment on column public.payment_proofs.analysis_destination_account is
  'Cuenta destino tal como el modelo la leyó en la imagen. NULL = no se leyó.';
comment on column public.payment_proofs.analysis_destination_holder is
  'Titular destino tal como el modelo lo leyó. NULL = no se leyó.';
comment on column public.payment_proofs.analysis_destination_bank is
  'Banco destino tal como el modelo lo leyó. NULL = no se leyó.';
