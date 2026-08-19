# notification-recovery-cron

Cloudflare Worker **compartido** que despierta, mediante un **Cron Trigger**, el
worker interno de recuperación de notificaciones desplegado en Vercel.

> **Un único Cron compartido, NO uno por restaurante.** En el futuro varios
> restaurantes usarán el mismo Worker, el mismo Cron y el mismo endpoint. El
> endpoint y la base de datos resuelven el tenant y seleccionan el trabajo;
> Cloudflare solo "despierta" el sistema con una petición vacía.

## Propósito

Cada minuto, Cloudflare invoca:

```
POST https://la-fija-orders.vercel.app/api/internal/order-notifications/worker/tick
Authorization: Bearer <WORKER_INTERNAL_TOKEN>
Content-Type: application/json

{}
```

y registra un log saneado con el resultado. No procesa notificaciones, no conoce
pedidos, teléfonos ni restaurantes, y no reintenta dentro de la misma ejecución.

## Arquitectura

```
Cloudflare Cron (* * * * *)
   └─ scheduled(controller, env, ctx)
        └─ ctx.waitUntil(runNotificationRecoveryTick(env, deps))
             └─ UN POST {} con Bearer y timeout ~55 s
                  └─ traduce la respuesta a UN log saneado
                       └─ termina (el siguiente minuto es la recuperación)
```

- **Como máximo un POST por ejecución.** Sin bucles, sin retry, sin fallback.
- **Timeout** ≈ 55 s (≤ `maxDuration = 60` del endpoint). Al vencer, aborta y
  registra `cron_timeout`; NO hace un segundo POST.
- La concurrencia la resuelven los *claims* atómicos de la base, no este Worker.
  No se necesitan Durable Objects, Queues ni locks.

Archivos:

- `src/cron.ts` — núcleo puro y testeable (`runNotificationRecoveryTick`).
- `src/index.ts` — Module Worker: `scheduled()` + `fetch()` (health check inerte).
- `wrangler.jsonc` — nombre, entrypoint, `compatibility_date`, **un** Cron, `vars`.
- `test/cron.test.ts` — pruebas sin red real.

## Variables y secretos

| Nombre | Tipo | Dónde |
| --- | --- | --- |
| `WORKER_TICK_URL` | variable pública | `wrangler.jsonc → vars` |
| `WORKER_INTERNAL_TOKEN` | **secreto** | Cloudflare secret (nunca en el repo) |

`WORKER_INTERNAL_TOKEN` debe coincidir con `VERCEL_INTERNAL_TOKEN` del endpoint.
**Nunca** se escribe en `wrangler.jsonc`, código, tests, README ni logs.

## Instalar

```bash
cd cloudflare/notification-recovery-cron
npm install
```

## Probar

```bash
# Desde este directorio (usa vitest):
npm test
```

Las pruebas no llaman a Vercel, Supabase ni Kapso, y no usan secretos reales.

## Ejecutar localmente

```bash
# Copia el ejemplo y rellena el token SOLO para local (no versionar):
cp .dev.vars.example .dev.vars

# Levanta el Worker y dispara el Cron manualmente en local:
npx wrangler dev --test-scheduled
# En otra terminal:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

`.dev.vars` está en `.gitignore`: nunca se versiona.

## Guardar el secreto

```bash
npx wrangler secret put WORKER_INTERNAL_TOKEN
# Pega el valor cuando lo pida. Debe coincidir con VERCEL_INTERNAL_TOKEN.
```

> El valor del token NO se incluye aquí ni en ningún archivo versionado.

## Desplegar

```bash
npx wrangler deploy
```

> La **activación real** del Cron (deploy + secret + prueba controlada) se hará
> en una fase posterior de cierre. Esta microfase solo implementa y prueba el
> Worker localmente.

## Verificar el Cron

- En el dashboard de Cloudflare: *Workers & Pages → notification-recovery-cron →
  Triggers → Cron Triggers* debe listar **exactamente un** trigger `* * * * *`.
- Cloudflare interpreta el Cron en **UTC**; para "cada minuto" la zona horaria no
  altera la frecuencia.
- Los cambios de Cron pueden tardar algunos minutos en propagarse.
- Los logs (`wrangler tail` u *Observability*) deben mostrar `cron_started` y
  `cron_completed` (o el evento de error correspondiente), nunca secretos.

## Retirar o pausar el Cron

- **Pausar (recomendado)**: dejar el array de crons **vacío** y re-desplegar:

  ```jsonc
  "triggers": {
    "crons": []
  }
  ```

  ```bash
  npx wrangler deploy
  ```

  > ⚠️ Un array **vacío** es lo que desactiva el trigger. **Comentar o quitar la
  > propiedad `triggers.crons`** NO desactiva un trigger ya desplegado: Wrangler
  > solo reconcilia los crons que declaras, y si no declaras ninguno puede dejar
  > intacto el que ya existe en Cloudflare. Para apagarlo con certeza, declara
  > `"crons": []` y re-despliega (o elimina el trigger en el dashboard).

- **Retirar por completo**: `npx wrangler delete` elimina el Worker entero.

No crear un segundo trigger para el mismo propósito ni un Worker por restaurante.

## Logs (saneados)

Eventos: `cron_started`, `cron_completed`, `cron_timeout`, `cron_network_error`,
`cron_unauthorized`, `cron_contract_error`, `cron_rate_limited`,
`cron_upstream_error`, `cron_invalid_response`.

Solo se registran: `status`, `duration_ms`, `ok`, `selected`, `processed`,
`history_reads`, `network_send_attempts`, `budget_exhausted` y `results_count`.
Nunca: token, `Authorization`, URL, `order_id`, teléfonos, `wamid`, `claim_token`
ni cuerpos completos.
