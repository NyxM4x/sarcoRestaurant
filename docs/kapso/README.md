# `docs/kapso/`

## `flow-la-fija.json` — LEGADO, no está en uso

> ⚠️ Este WhatsApp Flow **no forma parte del camino vigente** y sus datos están
> desactualizados: conserva los productos y precios de La Fija (`"1x La Fija —
> Bs. 22"`, `hat_trick`, `doble_o_nada`, `tocino`), que ya no existen en la
> carta de Don Zarco. **No lo importes en Meta ni en Kapso.**

Se conserva como referencia histórica del formato, no como algo a desplegar.

## Cómo se pide de verdad

El pedido se arma en la **web**, no en un formulario dentro de WhatsApp:

1. El cliente escribe algo como "menu", "carta" o "quiero pedir".
   `src/lib/webhook/menu-intent.ts` lo reconoce de forma determinística —sin IA—
   normalizando tildes y evaluando las negaciones primero ("no quiero pedir"
   jamás abre el menú).
2. El backend envía un **CTA URL** con la portada y el botón "Ver menú"
   (`MENU_CTA_BODY_TEXT` y `MENU_URL` en `src/lib/kapso/messages.ts`), a través
   del Shared Menu Dispatch (`src/lib/menu/dispatch.ts`).
3. El botón abre `/menu` con una sesión firmada: fotos, carrito, y checkout que
   cotiza el delivery con Mapbox a partir de la ubicación del cliente.

Ese camino tiene lo que el Flow no puede dar: fotos de los productos y una
tarifa de envío calculada sobre la distancia real.

## Por qué el código del Flow sigue existiendo

`src/app/api/flow/order-summary/route.ts` y `src/lib/flow/*` siguen en el
repositorio y funcionando. Atienden el Data Endpoint y el `nfm_reply` por si el
camino del Flow se retomara. Que estén ahí **no** significa que haya un Flow
activo: hoy ninguno está publicado.
