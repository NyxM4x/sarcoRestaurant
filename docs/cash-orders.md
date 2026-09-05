# El pedido en efectivo

Documento **trackeado** del flujo del pedido que se paga al recibir (migración
0036, 05-09-2026).

> **REQUISITO OPERATIVO: aplicar la migración 0036 ANTES de desplegar este
> código.** El tablero de cocina lee `orders.cash_confirmed_at` para no enseñar
> pedidos sin confirmar; sin la columna esa consulta falla y la cocina se queda
> **sin tablero**, no solo sin esta función.

## El problema

En efectivo no hay comprobante que revisar, así que no hay ningún momento
"pagado" que dispare nada. El aviso al grupo de reparto salía al **cotizar**,
que parecía el único momento disponible.

Pero el cliente ve el precio del envío en ese mismo mensaje, y es entonces
cuando decide. La madrugada del 05-09-2026, dos clientes seguidos:

| | Ve | Escribe | Qué quedó |
|---|---|---|---|
| #40 | Delivery Bs 27 | *"Muy caro su moto"* | nunca volvió |
| #39 | Delivery Bs 30 | *"Cancelar pedido"* | pidió una persona |

Los dos pedidos ya estaban en el teléfono de quien reparte. El negocio se
quedaba con una comanda que nadie iba a pagar y un repartidor que podía haberla
tomado.

## El recorrido

```
1. cliente:  arma su pedido en el menú y manda su ubicación
2. bot:      desglose + total + "¿Confirmás? CONFIRMO / CANCELAR"
             ↑ nada en cocina, nada en Telegram
3. cliente:  "CONFIRMO"
4. sistema:  escribe cash_confirmed_at → el ticket aparece en el KDS
             → sale el aviso al grupo de reparto
5. bot:      "Listo, tu pedido #40 ya está en cocina. Pagás Bs 63 al recibirlo."
```

Con **CANCELAR** el pedido pasa a `cancelled` y se le contesta. Sin respuesta,
un barrido lo cancela a los **20 minutos** y se lo avisa
(`CASH_CONFIRM_TIMEOUT_MS`, en `orders/cash-confirm-service.ts`, invocado desde
el latido del cron).

## Las decisiones que no son obvias

**Una columna y no un estado nuevo.** `orders.status` describe dónde está el
pedido en la cocina. "El cliente todavía no dijo que sí" no es un sitio de la
cocina: es un hecho sobre el cliente, y cabe en su columna sin tocar un dominio
que leen seis pantallas.

**Un timestamp y no un booleano.** La otra pregunta que se le hace a esa columna
es "¿cuánto lleva sin confirmar?".

**Una palabra entera, no un número.** La otra pregunta del flujo —"¿querés
agregar algo?", `order-review-reply.ts`— usa `1` y `2`. Aquí se pide CONFIRMO o
CANCELAR porque lo que está en juego es distinto: allí el error manda un botón
de más, y aquí agenda o tira un pedido.

**"Muy caro su moto" NO es un CANCELAR.** Cancelar es lo único sin vuelta atrás,
así que solo lo disparan las formas explícitas; una queja sigue su camino y el
pedido caduca solo si el cliente no vuelve. Tiene su test.

**El ticket sale de la vista, no de la base.** Mientras no confirme, el pedido no
se pinta en el KDS —mismo patrón que el pedido con comprobante rechazado— pero
sigue vivo esperando su respuesta. Cancelarlo ahí sería decidir por el cliente.

**Nunca dos preguntas abiertas a la vez.** Si ese cliente pide un cambio antes de
confirmar, recibe el botón de MODIFICAR directo y no la pregunta del desglose:
dos preguntas con sus propias palabras en el mismo chat harían que un "1" suyo
ya no supiéramos a cuál iba.

## Lo que NO pasa por aquí

| El cliente dice | Dónde se resuelve |
|---|---|
| "sin cebolla" | nota de cocina — `webhook/order-change-intent.ts` |
| "una gaseosa también" | rearmar el pedido — `docs/order-change.md` |
| "paso a recogerlo" | cambio a recojo — `orders/pickup-switch-service.ts` |

## Pendientes conocidos

- **El barrido depende del latido.** Si el cron no corre, los pedidos sin
  confirmar no se cancelan solos: se quedan pendientes, que es la degradación
  buena (nadie cocina ni reparte nada), pero ensucian el panel.
- **Cancelar después de confirmar no está soportado.** Ese pedido puede estar en
  la plancha o en la moto, y `cancelCashOrder` lo rechaza a propósito. Lo mira
  una persona.
