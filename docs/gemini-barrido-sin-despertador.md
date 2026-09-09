# Prompt para Gemini — el barrido que nadie despierta

> Este archivo **es** el prompt. Copialo entero (Ctrl+A, Ctrl+C) y pegalo en
> Gemini. No hace falta editar nada.

---

## ROL

Sos arquitecto de sistemas backend. Te van a describir un sistema en producción,
un fallo concreto y confirmado con datos, y cuatro opciones para arreglarlo. Tu
trabajo es **elegir una y defenderla**, o proponer una quinta que no se nos
ocurrió.

No escribas código. Lo que hace falta es el criterio: qué opción sobrevive mejor
a un local que abre de noche, con una sola persona técnica, y donde cada pieza
de infraestructura nueva es una pieza más que puede fallar sin avisar.

Respondé en español.

---

## EL NEGOCIO

Un local de trancapechos y hamburguesas en Santa Cruz de la Sierra, Bolivia.
Atiende **de 18:00 a 04:00**, todos los días, **por WhatsApp**. Un bot atiende de
punta a punta: que un humano tenga que entrar al chat se considera un fracaso
del producto.

El cliente recibe un botón, abre un menú web, arma su pedido, manda su ubicación
por WhatsApp, recibe su total, y paga — por QR (transferencia bancaria, manda
foto del comprobante) o en efectivo (paga al recibir).

**Volumen:** decenas de pedidos por noche. No es un sistema grande.

**Equipo:** una persona. No hay turno de guardia, no hay quien mire un panel de
monitoreo a las 3 de la mañana.

---

## LA PILA

| Pieza | Dónde |
|---|---|
| App (Next.js 16) | Vercel, **plan sin crons** |
| Base de datos | Supabase (Postgres 17) |
| WhatsApp | Kapso (proveedor externo, API HTTP) |
| Despertadores | 3 Cloudflare Workers, cron `* * * * *` |

Los tres Cloudflare Workers son idénticos en forma: cada uno se despierta cada
minuto, hace **un solo `POST {}`** con un Bearer a un endpoint interno de la app
en Vercel, y registra un log. No conocen Supabase ni la lógica: solo tocan el
timbre. Cada uno apunta a un endpoint distinto:

```
sarco-webhook-events-recovery-cron  →  POST /api/internal/webhook-events/worker/tick
sarco-notification-recovery-cron    →  POST /api/internal/order-notifications/worker/tick
sarco-telegram-alerts-cron          →  POST /api/internal/telegram-alerts/worker/tick
```

Son tres despliegues **independientes a propósito**. La razón está escrita en el
repo: un evento del inbox de webhooks puede llevar un turno completo del modelo
de lenguaje —11 a 12 segundos medidos en producción— así que encadenar dos
recuperaciones en una sola invocación hace que una le coma el presupuesto de
tiempo a la otra, y que un timeout tumbe a las dos el mismo minuto.

---

## EL FLUJO QUE FALLA

En **efectivo** el cliente ve el costo del envío recién cuando el sistema cotiza
su ubicación. Eso trajo un problema real la madrugada del 05-09-2026:

```
#40  ve "Delivery: Bs. 27"  →  "Muy caro su moto"  →  nunca volvió
#39  ve "Delivery: Bs. 30"  →  "Cancelar pedido"   →  pidió una persona
```

Los dos pedidos **ya estaban en el grupo de reparto** cuando eso pasó: el aviso
al repartidor salía al cotizar, porque en efectivo no hay pago que esperar. El
negocio se quedaba con una comanda que nadie iba a pagar y un repartidor que
podía haberla tomado.

La solución que se construyó: el pedido en efectivo pasa a tener **dos
momentos**.

```
   armar pedido  →  awaiting_location
                        │  el cliente manda su ubicación GPS
                        ▼
                    cotizado          "Comida Bs 48 · Delivery Bs 25 · Total Bs 73"
                    status=confirmed  "¿Confirmás? Escribí CONFIRMO"
                    cash_confirmed_at = NULL
                        │
          ┌─────────────┼──────────────────┐
          │             │                  │
    escribe CONFIRMO   escribe CANCELO   NO CONTESTA NADA
          │             │                  │
          ▼             ▼                  ▼
   cash_confirmed_at  cancelado      ← AQUÍ ESTÁ EL FALLO
   = now()                             debería cancelarse solo a los 20 min
          │
          ▼
   entra a cocina + sale al grupo de reparto
```

Mientras `cash_confirmed_at` sea NULL, el pedido **no aparece en el tablero de
cocina** y **no sale al grupo de reparto**. Eso funciona.

Lo que no funciona es la tercera rama.

---

## EL FALLO, CONFIRMADO CON DATOS

Existe una función que barre esos pedidos. Está escrita, tiene tests, y hace
exactamente lo que debe: busca pedidos en efectivo, `status='confirmed'`, con
`cash_confirmed_at IS NULL` y más de 20 minutos de antigüedad; los pasa a
`cancelled` con un guard optimista, y **le avisa al cliente por WhatsApp** que su
pedido se canceló porque no lo confirmó. Tope de 25 por pasada.

El problema es dónde vive:

```ts
// src/app/api/internal/cron/tick/route.ts
export async function GET(request: Request): Promise<Response> {
  // ... valida el Bearer ...
  const [inbox, notifications, alerts] = await Promise.allSettled([...]);

  const caducados = await expireUnconfirmedCashOrders();   // ← el barrido
  // ...
}
```

Ese endpoint es **`GET /api/internal/cron/tick`**, y fue escrito como *fallback*
de los tres Cloudflare Workers, para el día que Cloudflare esté caído. Un cron de
Vercel lo despertaría.

**Pero el plan de Vercel no admite crons.** No hay `vercel.json` en el repo, y la
documentación interna lo dice con todas las letras: *"El plan de Vercel actual no
admite crons, así que hoy ese fallback no está programado."*

Y los tres Cloudflare Workers apuntan a otros tres endpoints. **Ninguno apunta a
`/api/internal/cron/tick`.**

Así que nadie llama nunca a ese endpoint, y el barrido nunca corre.

### La prueba

Consulta a la base de producción, hoy:

```sql
select count(*) as sin_confirmar, min(created_at), max(created_at)
from orders
where payment_method = 'cash' and status = 'confirmed'
  and cash_confirmed_at is null;
```

```
sin_confirmar | mas_antiguo               | mas_reciente
           11 | 2026-09-06 00:58:23+00    | 2026-09-09 07:38:58+00
```

Si el barrido corriera cada minuto, no debería existir **ninguno** de más de 20
minutos. Hay 11, y el más viejo lleva **tres días**.

### Qué significan esos 11 pedidos

- El cliente **nunca recibió el aviso** de que su pedido se canceló. Once
  personas quedaron sin respuesta.
- El pedido sigue contando como su "pedido abierto" durante 24 h, lo que le
  **tapa el menú** para volver a pedir.
- Las cuentas de la noche salen sucias: pedidos `confirmed` que nadie cocinó.
- Nadie se enteró nunca. **El fallo es silencioso**, que es lo que lo hace caro.

---

## LO QUE HAY QUE DECIDIR

**Cómo hacer que ese barrido corra**, sabiendo que hay al menos dos barridos más
esperando entrar después (un pedido por QR cotizado al que nunca llega el
comprobante, y un carrito que nunca llega a cotizarse porque el cliente no manda
su ubicación). Sea cual sea la respuesta, va a tener que sostener a los tres.

---

## LAS CUATRO OPCIONES

### A — Un cuarto Cloudflare Worker dedicado

Mover el barrido a su propio endpoint `POST /api/internal/orders/expiry/worker/tick`
y crear `cloudflare/sarco-order-expiry-cron/`, copiando el patrón de los otros
tres. Cron `* * * * *`, un `POST` por minuto, su propio secreto y su propia
observabilidad.

- **A favor:** es el patrón que el repo ya usa tres veces y que funciona. El
  barrido tiene su propio presupuesto de tiempo y sus propios logs. Los tres
  barridos futuros caben en el mismo worker sin tocar nada más.
- **En contra:** una cuarta pieza de infraestructura que desplegar a mano
  (`wrangler deploy` con su secreto), que mantener y que puede caerse en
  silencio como se cayó esta. Nadie vigila que los otros tres sigan vivos.

### B — Colgarlo de un Worker que ya corre

Añadir la llamada al barrido dentro de un endpoint que ya se despierta cada
minuto — el de alertas de Telegram, que es el más liviano.

- **A favor:** cero infraestructura nueva. Un cambio de dos líneas y el barrido
  corre desde el próximo deploy.
- **En contra:** va contra la razón por la que los tres Workers están separados.
  El barrido puede mandar hasta 25 mensajes de WhatsApp en una pasada, y esos
  mensajes competirían por el mismo presupuesto de 55 segundos que las alertas de
  reparto. Un aviso de reparto que no sale es un repartidor que no sale.

### C — Sin cron: cancelar en el momento en que alguien lee

No despertar nada. El sistema ya lee esos pedidos varias veces por minuto —cuando
el cliente escribe por WhatsApp, cuando la cocina refresca el tablero, cuando el
encargado abre el panel—. Aprovechar cualquiera de esos momentos para cerrar lo
que ya venció.

- **A favor:** cero infraestructura, imposible que "deje de correr" porque no
  corre nada por su cuenta. La expiración ya se deriva al leer en este sistema:
  un pedido vencido ya se comporta como vencido aunque su fila diga otra cosa.
- **En contra:** el aviso al cliente depende de que alguien pase por ahí. El
  cliente que no vuelve a escribir nunca recibe su "tu pedido se canceló", y es
  exactamente el cliente del que hablamos: el que no contestó. Cerraría la fila
  tarde o nunca.

### D — pg_cron dentro de Supabase

Que la base se despierte sola. Postgres marca los vencidos y encola el aviso en
la tabla de notificaciones que **ya tiene su propio Worker corriendo cada minuto**
para mandar WhatsApp.

- **A favor:** no depende ni de Vercel ni de una pieza nueva de Cloudflare. El
  despertador vive en el mismo sitio que los datos.
- **En contra:** la regla de negocio —qué pedido vence y cuándo— quedaría escrita
  en SQL además de en TypeScript, o solo en SQL. Dos versiones de la misma regla
  es como empiezan a divergir. Y hay que confirmar que el plan de Supabase
  permita `pg_cron`.

---

## LO QUE TE PEDIMOS

1. **Elegí una opción y defendela.** Cuál, y por qué esa y no las otras tres.

2. **Decinos qué es lo que más nos va a doler de tu elección dentro de seis
   meses**, con este equipo y este negocio.

3. **El problema de fondo:** las cuatro opciones arreglan *este* barrido, pero
   ninguna resuelve que un despertador pueda morirse sin que nadie se entere —
   que es lo que acaba de pasar durante tres días. ¿Cómo se detecta eso sin
   montar un stack de monitoreo que nadie va a mirar? Nos interesa más esta
   respuesta que la anterior.

4. **Si ves una quinta opción mejor, decila.**

5. **Un detalle de producto, no de arquitectura:** ¿veinte minutos es el plazo
   correcto para cancelarle el pedido a alguien que no contesta, en un local que
   atiende de 18:00 a 04:00 y donde el cliente está decidiendo si le parece caro
   el envío? El cliente no sabe que existe ese plazo: nadie se lo dice.
