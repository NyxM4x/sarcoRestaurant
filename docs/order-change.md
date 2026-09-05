# Cambiar un pedido ya armado

Documento **trackeado** del flujo que abre el botón *"Cambiar mi pedido"*
(migración 0035, 04-09-2026).

> **REQUISITO OPERATIVO: aplicar la migración 0035 ANTES de desplegar este
> código.** Sin la columna `menu_sessions.replaces_order_id`, la consulta que
> excluye los enlaces de cambio al reutilizar una sesión falla, y con ella el
> envío del menú — para todos los clientes, no solo para los que quieran
> cambiar algo. Es el mismo orden que exige 0015 para el ledger del menú:
> primero la base, después el código.

## El problema

El cliente arma su pedido, recibe su total y su QR, y entonces se acuerda de la
soda. Hasta ahora eso no tenía camino:

- si volvía al menú y pedía otra vez, quedaban **dos pedidos** suyos vivos —dos
  comandas, dos envíos, dos QR— y alguien tenía que entrar al chat a deshacerlo;
- si escribía "mándame 2 sodas más", el bot le contestaba con el recordatorio
  del comprobante, que no tenía nada que ver con lo que había pedido.

El dueño no quiere entrar a los chats para resolver esto. Así que el cliente
tiene que poder hacerlo solo.

## Lo que NO pasa por aquí

| El cliente dice | Qué es | Dónde se resuelve |
|---|---|---|
| "sin cebolla", "con harta mayonesa" | preferencia de cocina | se escribe en `orders.notes` — ver `docs/menu-dispatch.md` |
| "mándame 2 sodas más", "no puse la gaseosa" | cambio de líneas | **este documento** |

La frontera la decide `webhook/order-change-intent.ts`, y su asimetría es
deliberada: una preferencia mal tratada molesta; un cambio de líneas anotado
como preferencia deja el total viejo con comida nueva.

## El recorrido

```
1. cliente:  "agregame una gaseosa"          (pedido confirmed, sin comprobante)
2. bot:      CTA "Cambiar mi pedido"  →  menu_sessions.replaces_order_id = #7
3. cliente:  abre el menú, con SU pedido ya dentro del carrito
4. cliente:  confirma        →  create_order_web_v4 crea el pedido #12
5. after():  replaceSupersededOrder() cancela #7
6. sistema:  #12 sigue el camino normal (ubicación → cotización → total + QR)
```

**El enlace es la autoridad.** A qué pedido sustituye vive en la sesión, no en
el navegador: nadie puede cambiar un parámetro de la URL y cancelar el pedido de
otro. Y una sesión de cambio **nunca se reutiliza** como enlace de menú
(`findValidByPhone` la excluye), porque devolvérsela a quien solo pidió la carta
cancelaría un pedido que nadie quería cancelar.

## Por qué se crea un pedido nuevo en vez de editar el viejo

Editar significaría reescribir líneas, promociones y totales **fuera** de
`create_order_web_v4`, que es la única función que sabe releer precios,
revalidar combos y recalcular importes en una transacción. Un segundo camino de
escritura sobre `orders` es lo que este proyecto no tiene, y no compensa
estrenarlo aquí: el resultado visible para el cliente es el mismo y el rastro
queda más claro — se ve qué pidió antes y qué cambió.

El precio de esa decisión es que **el número cambia** (#7 → #12). Por eso el
texto del botón y el banner del menú avisan de que llegará el total actualizado.

## Las guardas de la cancelación

`replaceSupersededOrder` (`src/lib/orders/order-replacement.ts`) cancela el
anterior solo si se cumple todo:

| Guarda | Por qué |
|---|---|
| mismo teléfono que la sesión | lo único que impide que un enlace filtrado cancele el pedido de otro |
| estado `confirmed` | un pedido en la plancha o en camino es comida hecha |
| sin pago `accepted` ni `pending_review` | hay dinero apuntando a ese total; lo mira una persona |

Si alguna falla, **el pedido nuevo queda creado igual**. Es deliberado: el
cliente pidió, y quedarse sin pedido sería peor que quedar con dos. El caso sale
en el log (`order_replacement_payment_in_flight`, `order_replacement_phone_mismatch`)
y se ve en el panel.

Una consulta caída al mirar los pagos cuenta como **pago vivo**: "no lo sabemos"
con dinero de por medio se trata como un sí.

## El carrito precargado

`loadOrderCart` lee `order_items` y `order_promotions` del pedido y los devuelve
con la forma exacta del carrito (`{código: cantidad}`). Se siembran **una vez** y
**solo sobre un carrito vacío**: si el cliente ya tenía algo dentro, es suyo.

Se leen los **códigos, no los precios**. Los precios los relee la RPC al
confirmar, igual que en cualquier pedido: entre el pedido viejo y el corregido
pueden haber cambiado, y el que vale es el de ahora.

## Pendientes conocidos

- **El envío se cobra dos veces si acaban existiendo dos pedidos** (05-09-2026).
  El pedido #26 y el #27 de la misma noche, del mismo teléfono y a la misma
  ubicación, cobraron Bs 10 de envío cada uno. El cliente lo reclamó.

  Lo que evita el caso está desplegado —ese cliente ahora corrige su pedido en
  vez de armar otro— pero si aun así se crean los dos, el segundo sigue
  cobrando su envío.

  **No se puede arreglar sin migración**, y conviene saber por qué antes de
  intentarlo: `apply_delivery_quote` (migración 0009) tiene un *money guard* que
  exige que el importe del envío coincida EXACTAMENTE con el tarifario de la
  distancia — a ≤3 km, Bs 10. Pasar `0` no rebaja el envío: lanza excepción y
  **deja el pedido sin cotizar**. Ese guard es la defensa final contra un envío
  manipulado, así que rebajarlo pide un permiso explícito (un parámetro del tipo
  "ya se cobra en otro pedido") y no un hueco general para el cero.

  Ya existe la mitad del trabajo: `findReusedDistanceMeters`
  (`delivery/quote-order.ts`) es exactamente la consulta "mismo cliente, mismo
  punto" que haría falta, hoy usada para no pagar dos veces a Mapbox.


- **La ubicación se vuelve a pedir.** El pedido corregido nace
  `awaiting_location` como cualquier otro, así que el cliente manda su pin otra
  vez. No se paga Mapbox de nuevo (`findReusedDistanceMeters` reutiliza la
  medición del mismo punto), pero es un paso que se le podría ahorrar heredando
  las coordenadas del pedido anulado.
- **Dos botones de cambio seguidos.** Si el cliente escribe dos veces y usa los
  dos enlaces, el segundo apunta a un pedido ya cancelado (`skipped:
  not_confirmed`) y quedarían dos pedidos nuevos. Requiere que abra los dos
  enlaces a propósito.
- **El QR viejo sigue en el chat.** El cliente podría pagar el monto anterior. El
  texto del botón y el banner del menú avisan del total actualizado, pero nada
  impide el pago equivocado; lo detecta el análisis del comprobante, que compara
  el monto.
- **Cambiar después de pagar** no está soportado y no debería estarlo sin una
  persona: hay dinero recibido contra un total concreto.
