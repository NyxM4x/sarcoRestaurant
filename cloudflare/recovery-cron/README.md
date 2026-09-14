# sarco-recovery-cron

> **Tenencia.** Este Worker despierta EXCLUSIVAMENTE a Sarco
> (`https://sarco-restaurant.vercel.app`) y su nombre desplegable lleva el
> prefijo `sarco-` para no colisionar con los Workers de otro restaurante en la
> misma cuenta de Cloudflare. `test/no-cross-tenant.test.ts` falla si alguna
> configuración ejecutable apunta a otro despliegue, o si la app tiene una ruta
> `worker/tick` que este Worker no despierta.

El **único despertador** de Sarco. Cada minuto, un Cron Trigger hace cuatro
`POST {}` **en paralelo**, uno por recuperación:

| Recuperación | Endpoint | Si no corre |
|---|---|---|
| `webhook_events` | `/api/internal/webhook-events/worker/tick` | Un mensaje de WhatsApp cortado a mitad (texto, ubicación, **foto del comprobante**) se pierde en silencio |
| `order_notifications` | `/api/internal/order-notifications/worker/tick` | El cliente no recibe su aviso |
| `telegram_alerts` | `/api/internal/telegram-alerts/worker/tick` | El repartidor no se entera del pedido |
| `order_expiry` | `/api/internal/orders/expiry/worker/tick` | Pedidos fantasma abiertos durante días |

El Worker **no decide nada**: no conoce Supabase, ni Kapso, ni qué pedido se
recupera. Solo toca los timbres.

## Por qué uno solo (14-09-2026)

Hasta esa fecha eran **cuatro Workers**, uno por endpoint. El plan Free de
Cloudflare admite **cinco Cron Triggers por cuenta**, y la cuenta la comparte
otro restaurante del mismo operador que ya usa tres. No cabían:

1. Dos de los cuatro (`webhook-events` y `notification-recovery`) **nunca se
   desplegaron**, y nadie lo notó: un despertador que no existe no da error.
2. El 13-09-2026 una clienta pagó Bs 72 por QR, la foto de su comprobante quedó
   trabada a mitad de proceso y **nadie la retomó**. El pedido nunca llegó a la
   cocina y se canceló solo a las dos horas.
3. Al desplegarlos, Cloudflare rechazó sus crons: `This account has reached the
   Workers Free limit of 5 cron triggers per account.`

Con un solo Worker, Sarco ocupa **un lugar de cinco**. Y el fallo con el que
empezó todo —dos despliegues de cuatro olvidados— deja de ser posible: o está el
despertador o no está.

La alternativa (una cuenta de Cloudflare por restaurante) se descartó: deja la
cuenta en 4 de 5 otra vez, y multiplica las piezas que se pueden olvidar. La
comparación completa está en `docs/gemini-limite-crons-cloudflare.md`.

## Por qué en paralelo

Los cuatro eran despliegues separados para que una recuperación lenta no le
comiera el tiempo a otra: un evento del inbox puede llevar un turno completo del
agente (11–12 s), y el barrido de caducados puede mandar 25 WhatsApp seguidos.

Eso **se conserva**. Cada endpoint sigue siendo su propia invocación en Vercel
con sus 60 s, y aquí cada uno espera con su **propio** `AbortController` de
55 s. Lo único que se comparte es quién toca el timbre. Encadenarlos —uno
detrás de otro— sí rompería la garantía; lanzarlos juntos, no.

## Límites del plan Free

| Límite | Free | Este Worker |
|---|---|---|
| Cron Triggers por cuenta | 5 | 1 |
| CPU por invocación | 10 ms | 4 peticiones, 4 JSON pequeños, 5 logs. Esperar la red no cuenta |
| Conexiones simultáneas | 6 | 4 (una prueba impide pasar de 6) |
| Subpeticiones | 50 | 4 |

La CPU hay que **medirla en producción** tras desplegar: en el panel del Worker
(Metrics → CPU time). Si alguna vez se acerca a 10 ms, Cloudflare corta la
invocación entera y se ve como `exceededCpu` en los logs.

## Despliegue

```bash
cd cloudflare/recovery-cron
npm install
npm test

# El secreto va aparte del código, SIEMPRE. Debe coincidir con el
# INTERNAL_API_TOKEN de Vercel producción.
npx wrangler secret put WORKER_INTERNAL_TOKEN

npx wrangler deploy
npx wrangler tail sarco-recovery-cron --format pretty
```

Para otro restaurante: copiar la carpeta, cambiar `name` y `APP_BASE_URL`, y
cargar su secreto. Una pieza y un secreto por cliente.

## Cómo saber que sigue vivo

La línea que hay que mirar es **`cron_finished`**, una por minuto:

```json
{"event":"cron_finished","all_completed":true,"completed":4,"total":4,
 "outcomes":{"webhook_events":"completed","order_notifications":"completed",
 "telegram_alerts":"completed","order_expiry":"completed"}}
```

- `all_completed: false` dice **cuál** cayó y cómo (`unauthorized`, `timeout`,
  `upstream_error`…). Cada recuperación deja además su propio log con
  `recovery: <nombre>`.
- Recuentos en cero (`claimed: 0`, `cancelled: 0`) son el caso **normal**: el
  camino rápido es el `after()` de Vercel, y esto solo recoge lo que aquel no
  terminó.
- La avería de verdad es que `cron_finished` **deje de aparecer**. Eso este
  Worker no lo puede avisar por sí mismo; hace falta un vigilante externo.

## Cómo revertir

Dejar `"crons": []` en `wrangler.jsonc` y volver a desplegar, o quitar el
trigger en el panel (Workers & Pages → `sarco-recovery-cron` → Settings →
Triggers). Pausarlo **no pierde trabajo**: las filas vencidas siguen en la base
y se recogen al reactivarlo.

## Pruebas

```bash
npm test          # núcleo del cron + prueba de tenencia y de rutas
npm run typecheck
```
