# webhook-events-recovery-cron

Cloudflare Worker que despierta, mediante un **Cron Trigger**, el recovery del
**inbox durable de webhooks** (`webhook_events`) desplegado en Vercel.

> **Despliegue INDEPENDIENTE de `notification-recovery-cron`.** Son dos Workers,
> dos Crons y dos endpoints. No se fusionan, y el porqué está más abajo.

## Propósito

Cada minuto, Cloudflare invoca:

```
POST https://la-fija-orders.vercel.app/api/internal/webhook-events/worker/tick
Authorization: Bearer <WORKER_INTERNAL_TOKEN>
Content-Type: application/json

{}
```

y registra un log saneado con el resultado. No procesa eventos, no conoce
Supabase, Kapso, OpenAI, teléfonos ni mensajes, y no reintenta dentro de la
misma ejecución.

## Por qué no comparte Worker con las notificaciones

Un evento de este inbox puede llevar **un turno completo del agente**, y en
Production eso son 11–12 s medidos. Encadenar los dos recoveries en la misma
ventana de 55 s tiene dos problemas: uno le come el presupuesto al otro, y si la
invocación se pasa de tiempo **fallan los dos** ese minuto.

La durabilidad de los mensajes de clientes no debe depender de la salud del
worker de notificaciones. Por eso son dos despliegues con presupuestos
separados y observabilidad separada.

El Worker de notificaciones **no se toca**: conserva su invariante de un único
POST por ejecución.

## Arquitectura

```
Cloudflare Cron (* * * * *)
   └─ scheduled(controller, env, ctx)
        └─ ctx.waitUntil(runWebhookRecoveryTick(env, deps))
             └─ UN POST {} con Bearer y timeout ~55 s
                  └─ traduce la respuesta a UN log saneado
                       └─ termina (el siguiente minuto es la recuperación)
```

- **Como máximo un POST por ejecución.** Sin bucles, sin retry, sin fallback.
- **Timeout ≈ 55 s**, por debajo del `maxDuration = 60` del endpoint y por
  encima de su presupuesto interno de reloj (42 s): así el endpoint cierra por
  su cuenta y devuelve recuentos en vez de que le cortemos la respuesta.
- La concurrencia la resuelven los *claims* atómicos de la base
  (`FOR UPDATE SKIP LOCKED` y el lease), no este Worker.

Archivos:

- `src/cron.ts` — núcleo puro y testeable (`runWebhookRecoveryTick`).
- `src/index.ts` — Module Worker: `scheduled()` + `fetch()` (health check inerte).
- `wrangler.jsonc` — nombre, entrypoint, **un** Cron, `vars`.
- `test/cron.test.ts` — pruebas sin red real.

## Dependencias antes de que sirva de algo

Este Worker **no funciona solo**. Necesita, en este orden:

1. **Migración `0016`** aplicada a mano en Supabase (columnas `attempts`,
   `max_attempts`, `updated_at`, `next_attempt_at`, el índice parcial y los dos
   RPC de reclamo).
2. El endpoint `/api/internal/webhook-events/worker/tick` **desplegado** en
   Production.
3. `VERCEL_INTERNAL_TOKEN` configurado en Vercel.

Desplegarlo antes no rompe nada —el endpoint devolverá 404 y el log dirá
`cron_contract_error`— pero tampoco sirve.

## Variables y secretos

| Nombre | Tipo | Dónde |
| --- | --- | --- |
| `WORKER_TICK_URL` | variable pública | `wrangler.jsonc → vars` |
| `WORKER_INTERNAL_TOKEN` | **secreto** | Cloudflare secret (nunca en el repo) |

`WORKER_INTERNAL_TOKEN` debe coincidir con `VERCEL_INTERNAL_TOKEN` del endpoint.
Es el **mismo valor** que usa `notification-recovery-cron`, guardado por
separado en cada Worker. **Nunca** se escribe en `wrangler.jsonc`, código,
tests, README ni logs.

## Instalar

```bash
cd cloudflare/webhook-events-recovery-cron
npm install
```

## Probar

```bash
npm test
```

Las pruebas no llaman a Vercel, Supabase ni Kapso, y no usan secretos reales.

## Ejecutar localmente

```bash
cp .dev.vars.example .dev.vars   # rellenar el token SOLO para local

npx wrangler dev --test-scheduled
# En otra terminal:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

`.dev.vars` está en `.gitignore`: nunca se versiona.

## Guardar el secreto

```bash
npx wrangler secret put WORKER_INTERNAL_TOKEN
```

> El valor NO se incluye aquí ni en ningún archivo versionado.

## Desplegar

```bash
npx wrangler deploy
```

## Verificar

- Estado: `npx wrangler deployments status` y `npx wrangler versions list`.
- Health check inerte (**no** dispara el tick):
  `GET https://<worker>.workers.dev/` → `{"service":"webhook-events-recovery-cron","status":"ok"}`.
- Contrato del endpoint:
  - `POST .../worker/tick` sin Bearer → **401**.
  - `GET  .../worker/tick` → **405**.

```bash
npx wrangler tail webhook-events-recovery-cron --format json
```

En reposo, cada minuto debe verse `cron_started` y luego `cron_completed` con
`claimed: 0`, `processed: 0`, `failed: 0`. Un tick sin trabajo es un **no-op
sano**, no un error: el camino normal es `after()`, y este Worker solo recoge lo
que aquel no llegó a ejecutar.

## Eventos del log

| Evento | Significado |
| --- | --- |
| `cron_started` | arranca la ejecución |
| `cron_completed` | 200 con `ok`, `claimed`, `processed`, `failed`, `budget_exhausted`, `duration_ms` |
| `cron_unauthorized` | 401: el Bearer no coincide con `VERCEL_INTERNAL_TOKEN` |
| `cron_contract_error` | 400/404/405/422, config ausente o estado inesperado |
| `cron_rate_limited` | 429 |
| `cron_upstream_error` | 5xx del endpoint |
| `cron_timeout` | venció nuestro timeout; **no** se reintenta aquí |
| `cron_fetch_error` | fallo de red genuino |
| `cron_invalid_response` | 200 ilegible o con forma inesperada |

Ningún log lleva token, `Authorization`, URL, payload, teléfono, WAMID ni claves
de idempotencia.

## Pausar el Cron

El Cron es un trigger declarado en `wrangler.jsonc` (`"crons": ["* * * * *"]`).

1. Preferido (dashboard): Workers & Pages → `webhook-events-recovery-cron` →
   Triggers → Cron Triggers → eliminar/deshabilitar.
2. Por código: comentar `crons` en `wrangler.jsonc` y `npx wrangler deploy`.

Pausarlo **no** pierde trabajo: las filas vencidas siguen en `webhook_events` y
se recogen al reactivarlo. Lo que sí se pierde mientras está pausado es la red
de seguridad — con el Cron parado, un `after()` que no llegue a correr deja ese
mensaje sin atender hasta que vuelva.

## Límites

| Concepto | Valor | Dónde |
| --- | --- | --- |
| Eventos por tick | 3 | `INBOX_TICK_BUDGET` |
| Presupuesto de reloj del endpoint | 42 s | `INBOX_TICK_WALL_CLOCK_MS` |
| Timeout del Worker | 55 s | `TICK_TIMEOUT_MS` |
| `maxDuration` endpoint Vercel | 60 s | ruta `worker/tick` |

Tres eventos y no cinco porque un turno del agente tarda 11–12 s: cinco no caben
en 55 s, y un tick que muere a mitad no recupera nada. No hace falta más caudal
— el Worker corre cada minuto y esto es el camino de recuperación, no el normal.
