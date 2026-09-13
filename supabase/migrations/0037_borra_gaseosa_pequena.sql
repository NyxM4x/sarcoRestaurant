-- ============================================================================
-- 0037 — `gaseosa_pequena` se BORRA, no se deja agotada
--
-- 0018 la desactivó. Entonces alcanzaba: un producto inactivo desaparecía del
-- menú. Desde `62a8c0d` ya no — los inactivos se pintan en gris con "Agotado",
-- a propósito, para que el cliente no escriba preguntando si todavía se hace.
--
-- Y ahí quedó a la vista una confusión que `is_active` arrastra desde el día
-- uno: funde dos estados que no son el mismo.
--
--     agotado hoy      → vuelve mañana; decírselo al cliente es un servicio
--     retirado siempre → no vuelve; decírselo es ruido
--
-- La gaseosa pequeña es del segundo tipo, y además nunca fue nuestra: llegó
-- heredada del catálogo de La Fija, jamás estuvo a la venta y nunca se vendió
-- una. Anunciarla como "Agotado" es prometer algo que no existe.
--
-- Para ese producto —el que nunca formó parte de la carta— la respuesta no es
-- una bandera nueva: es que la fila no esté. Un campo `retired_at` habría que
-- justificarlo con productos que SÍ se vendieron y hoy no se hacen; ese caso
-- no ha aparecido todavía y esta migración no lo inventa.
--
-- ── Por qué esta vez SÍ se puede borrar ─────────────────────────────────────
--
-- 0018 y 0030 explican por qué no se borraba: `order_items.menu_item_id` es
-- ON DELETE RESTRICT y un producto vendido no se puede quitar del catálogo.
-- Cierto — y sigue siéndolo para las gaseosas de 0030, que sí se vendieron.
--
-- Esta no. Cero líneas en `order_items` y cero en `promotion_items`.
--
-- ── El bloque de abajo no confía en esa frase ───────────────────────────────
--
-- El recuento se hace CONTRA EL CATÁLOGO DE POSTGRES, no contra una lista de
-- tablas escrita a mano. La diferencia importa: `promotion_items` (0031) apunta
-- aquí y estuvo a punto de pasar desapercibida porque la escribieron como
-- `references public.menu_items` y se la buscaba como `references menu_items`.
-- Una FK que se añada mañana entra sola en esta comprobación.
--
-- Si algo la referencia, la migración ABORTA diciendo qué tabla y cuántas
-- filas. El RESTRICT también abortaría, pero con un mensaje del motor sobre una
-- restricción; este dice qué hacer.
--
-- Idempotente: aplicarla dos veces no falla.
--
-- NO ejecutar automáticamente. Aplicar manualmente después de 0036.
-- Postgres / Supabase.
-- ============================================================================

begin;

do $mig$
declare
  v_id  uuid;
  v_fk  record;
  v_n   bigint;
  v_uso text := '';
begin
  select id into v_id
    from public.menu_items
   where code = 'gaseosa_pequena';

  if v_id is null then
    raise notice '0037: gaseosa_pequena ya no está en menu_items. Nada que hacer.';
    return;
  end if;

  -- Toda columna de toda tabla que tenga una FK hacia `menu_items`.
  for v_fk in
    select con.conrelid::regclass as tabla,
           att.attname            as columna
      from pg_constraint con
      join lateral unnest(con.conkey) as k(attnum) on true
      join pg_attribute att
        on att.attrelid = con.conrelid
       and att.attnum   = k.attnum
     where con.contype  = 'f'
       and con.confrelid = 'public.menu_items'::regclass
  loop
    execute format('select count(*) from %s where %I = $1', v_fk.tabla, v_fk.columna)
       into v_n
      using v_id;

    if v_n > 0 then
      v_uso := v_uso || format(' %s.%s=%s', v_fk.tabla, v_fk.columna, v_n);
    end if;
  end loop;

  if v_uso <> '' then
    raise exception
      '0037: gaseosa_pequena todavía está referenciada:%. NO se borra — déjala is_active = false y revisá qué la usa.',
      v_uso;
  end if;

  delete from public.menu_items where id = v_id;

  raise notice '0037: gaseosa_pequena borrada (id %).', v_id;
end;
$mig$;

commit;
