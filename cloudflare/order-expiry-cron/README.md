# sarco-order-expiry-cron

> **Tenencia.** Este Worker despierta EXCLUSIVAMENTE a Sarco
> (`https://sarco-restaurant.vercel.app`) y su nombre desplegable lleva el
> prefijo `sarco-` para no colisionar con los Workers de otro restaurante en la
> misma cuenta de Cloudflare. `test/no-cross-tenant.test.ts` falla si alguna
> configuración ejecutable vuelve a apuntar a otro despliegue — o al tick de
> otro worker, que es el error fácil en un paquete que nace copiado.

Cloudflare Worker que despierta, mediante un **Cron Trigger**, el **barrido de
pedidos caducados** desplegado en Vercel.

> **Despliegue INDEPENDIENTE** de los otros tres crons. Son cuatro Workers,
> cuatro Crons y cuatro endpoints. No se fusionan, y el porqué está más abajo.

## Qué barre

El pedido en **efectivo** que ya fue cotizado —el cliente vio su total y la
pregunta— y que **nadie confirmó ni canceló en veinte minutos**
(`CASH_CONFIRM_TIMEOUT_MS`). Se cancela y se le avisa al cliente por WhatsApp.

## Por qué este Worker tuvo que existir

El barrido llevaba desde el **05-09-2026** escrito, probado y desplegado. Y
**nunca se había ejecutado en producción.**

Vivía dentro de `GET /api/internal/cron/tick`, que es el *fallback* de los otros
tres Workers para el día que Cloudflare esté caído. A ese endpoint lo
despertaría un cron de Vercel — pero **el plan de Vercel no admite crons** (ver
`docs/RECOVERY_CRON.md`), no hay `vercel.json` en el repo, y ninguno de los tres
Workers apuntaba a esa ruta.

Nadie la llamaba. Nunca.

Se descubrió el **09-09-2026** mirando la base:

```sql
select count(*) as sin_confirmar, min(created_at), max(created_at)
from orders
where payment_method = 'cash' and status = 'confirmed'
  and cash_confirmed_at is null;
```

```
sin_confirmar | mas_antiguo            | mas_reciente
           11 | 2026-09-06 00:58:23+00 | 2026-09-09 07:38:58+00
```

Si el barrido corriera, no debería existir **ninguno** de más de veinte minutos.
Había once, y el más viejo llevaba **tres días**. Once clientes que nunca
recibieron el aviso de que su pedido se canceló, cada uno con un pedido fantasma
tapándole el menú durante 24 horas, y las cuentas de la noche sucias con pedidos
`confirmed` que nadie cocinó.

**Nadie se enteró en tres días.** Un despertador que no suena no produce ningún
error: no hay excepción, no hay 500, no hay alerta. Simplemente no pasa nada.

Ese es el modo de fallo que este Worker viene a cerrar — y es exactamente el que
puede volver a abrirse si **este** deja de sonar. Ver "Cómo saber que sigue
vivo".

## Por qué es un Worker APARTE de los otros tres

Por el mismo motivo por el que ellos son tres y no uno, y aquí con un filo
extra: el peor caso de este tick son **veinticinco avisos por WhatsApp**
(`MAX_POR_BARRIDO`). Si Kapso se pone lento, eso se come el presupuesto de la
invocación entera.

Colgarlo del Worker de alertas de Telegram —el más liviano, el candidato
obvio— pondría en riesgo el aviso al grupo de reparto. Y un aviso de reparto que
no sale es un repartidor que no sale.

**Nunca se arriesga el flujo de OPERACIONES —que la comida llegue— por un
proceso de LIMPIEZA.** Cancelar pedidos fantasma puede esperar al minuto que
viene; una comanda pagada que nadie lleva, no.

## Qué hace, exactamente

Cada minuto, Cloudflare invoca:

```
POST https://sarco-restaurant.vercel.app/api/internal/orders/expiry/worker/tick
Authorization: Bearer <WORKER_INTERNAL_TOKEN>
Content-Type: application/json

{}
```

Una sola petición por ejecución. Sin bucles, sin reintentos, sin fallback: ante
timeout o error, la recuperación es el Cron del minuto siguiente, con el trabajo
intacto en la base.

El Worker **no decide nada**: no conoce Supabase, ni Kapso, ni qué pedido se
cancela. Solo toca el timbre.

### Por qué el cron es de un minuto y no de veinte

El plazo se mide **por pedido**, no por tanda. Un pedido que cumple sus veinte
minutos justo después de un barrido esperaría cuarenta si el cron fuera de
veinte. Un tick en vacío no cuesta nada: la consulta va por un índice parcial
(`ix_orders_cash_pending`) y la mayoría de los minutos no encuentra ninguna fila.

## Despliegue

```bash
cd cloudflare/order-expiry-cron
npm install

# El secreto va aparte del código, SIEMPRE. Debe coincidir con el
# INTERNAL_API_TOKEN de Vercel — el mismo valor que usan los otros tres Workers.
npx wrangler secret put WORKER_INTERNAL_TOKEN

npx wrangler deploy
```

El endpoint `/api/internal/orders/expiry/worker/tick` **tiene que estar
desplegado en Vercel antes** de que el Worker empiece a llamarlo. Si no lo está,
el tick registra `cron_upstream_error` y no rompe nada — pero tampoco barre.

## Cómo saber que sigue vivo

Este Worker existe porque su predecesor murió en silencio durante tres días. La
misma pregunta se le puede hacer a él, y se responde con la **misma consulta que
lo destapó**: si vuelve a aparecer un pedido en efectivo sin confirmar de más de
veinte minutos, este Worker no está corriendo.

En los logs de Cloudflare (`observability` está activada), la señal es
`cron_completed` una vez por minuto. Su ausencia es la avería; `cancelled: 0` es
el caso normal y sano.

## Pruebas

```bash
npm test        # núcleo del cron + prueba de tenencia
npm run typecheck
```

`test/no-cross-tenant.test.ts` es una prueba **arquitectónica**: recorre toda la
configuración ejecutable del paquete y falla si apunta a otro restaurante, al
tick de otro worker, o al fallback `/api/internal/cron/tick` donde este barrido
estuvo enterrado.
