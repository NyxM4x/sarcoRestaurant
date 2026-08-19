# Runbook operativo — Sistema de notificaciones (Fase 5.2D)

Runbook para operar el sistema de recuperación/reconciliación de notificaciones
de WhatsApp y las alertas Telegram de incidencias.

> **Sin secretos reales.** Este documento solo nombra variables y dónde viven.
> Nunca pegar aquí tokens, chat_id, Bearer ni valores.

## Arquitectura (una sola pieza de cada)

```
Cloudflare Cron (* * * * *)                 ← 1 Worker, 1 Cron, 1 despertador
  → POST {} a /api/internal/order-notifications/worker/tick (Vercel, Bearer)
    → select_due_notification_orders  → claim atómico → recuperación/reconciliación/retry seguro
    → terminal / manual_review
    → pase de alertas: select_due_notification_alerts → claim atómico → Telegram → mark_notification_alerted
```

- Worker Cloudflare: `notification-recovery-cron` (paquete `cloudflare/notification-recovery-cron`).
- Endpoint interno único en Vercel: `POST /api/internal/order-notifications/worker/tick`.
- Toda la deduplicación vive en los **claims atómicos** de la base (migraciones 0004–0007).

## Verificar el Cron

- Estado del Worker/Cron: `npx wrangler deployments status` y `npx wrangler versions list`
  (desde `cloudflare/notification-recovery-cron/`).
- Health check inerte (no dispara el tick): `GET https://<worker>.workers.dev/` → `{"status":"ok"}`.
- Confirmar que el endpoint responde protegido:
  - `POST .../worker/tick` sin Bearer → **401**.
  - `GET  .../worker/tick` → **405**.

## Ver logs en vivo (`wrangler tail`)

Desde `cloudflare/notification-recovery-cron/`:

```
npx wrangler tail notification-recovery-cron --format json
```

En reposo, cada minuto debe verse `cron_started` y luego `cron_completed` con:
`status=200, ok=true, selected=0, processed=0, history_reads=0,
network_send_attempts=0, alerts_selected=0, alert_send_attempts=0,
alerts_sent=0, alerts_rescheduled=0`.

Los logs NUNCA contienen Authorization, token, chat_id, teléfono, dirección,
coordenadas, wamid, order_id, claim_token ni el payload/`results` completo
(el Worker filtra claves sensibles antes de emitir).

## Pausar el Cron correctamente

El Cron es un trigger declarado en `wrangler.jsonc` (`"crons": ["* * * * *"]`).
Para pausar sin borrar el Worker:

1. Preferido (dashboard): Workers & Pages → `notification-recovery-cron` →
   Triggers → Cron Triggers → eliminar/deshabilitar el trigger.
2. Por código: comentar el `crons` en `wrangler.jsonc` y `npx wrangler deploy`.

Pausar el Cron **no** genera pérdida: el trabajo vencido permanece en la base y se
procesará cuando se reactive. No pausar borrando el Worker (perdería el health check).

## Reactivar el Cron

- Dashboard: volver a añadir el Cron Trigger `* * * * *`.
- Por código: restaurar `"crons": ["* * * * *"]` en `wrangler.jsonc` y `npx wrangler deploy`.
- Verificar con `wrangler tail` que reaparecen `cron_started`/`cron_completed`.

## Comprobar trabajo pendiente (due work) — read-only

Con la service-role key (server-side), vía PostgREST RPC:

- `select_due_notification_orders(5)` → recuperación/reconciliación vencida (esperado 0).
- `select_due_notification_alerts(5)` → incidencias con alerta pendiente (esperado 0).

Señales de salud adicionales (deben ser 0 en reposo):
`status='sending'` con `claimed_at` > 120 s; `status='reconciling'` con
`claimed_at` > 300 s; `alert_status='alerting'`; `manual_review_required=true`
con `alerted_at is null`.

## Detectar una alerta atascada

- `alert_status='alerting'` con `alert_claimed_at` > 300 s: claim de alerta
  abandonado. Se **auto-recupera**: `select_due_notification_alerts` lo vuelve a
  ofrecer y el siguiente tick lo reclama de nuevo.
- `alert_status='failed'`: agotó 5 intentos de Telegram → **requiere revisión
  humana** (no se reintenta solo). Revisar `alert_last_error_code` (código corto
  saneado) y el estado de Telegram/red antes de re-armar manualmente.
- `alerted_at` no null + `alert_status='sent'`: alerta entregada; no se re-selecciona.

## Si Telegram falla

- Un fallo de Telegram **solo reprograma la ALERTA**; nunca toca la notificación
  de WhatsApp (estructural: el alert-runner no tiene métodos que muten WhatsApp).
- Clasificación: `permanent` (400/403/404) / `rate_limited` (429, respeta
  `retry_after`) / `transient` (5xx/timeout/red) / `invalid` (ilegible) →
  reprograma con retraso (`ALERT_RETRY_DELAY_SECONDS=300`). Tras 5 intentos → `failed`.
- Si faltan `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, el sender devuelve
  `config_missing` **sin** hacer fetch: el tick sigue siendo un no-op sano.
- Caso ambiguo (Telegram 200 pero falla la persistencia): se registra
  `alert_error(persist_after_send)`, el claim caduca y se recupera (at-least-once).

## Si Kapso falla

- Un fallo de Kapso **no** modifica el estado de alerta (presupuestos y rutas
  independientes).
- Envío: timeout/red/HTTP se clasifican; los ambiguos van a
  `pending_reconciliation` (nunca reenvío ciego). `GET /messages` reconcilia
  (≤2 por tick); un error de historial se reprograma, jamás se disfraza de
  `not_found`. Agotados los intentos → terminal/manual_review.

## 401 del endpoint

`cron_unauthorized` en los logs = el Bearer del Worker no coincide con el token
de Vercel. Verificar que el secreto `WORKER_INTERNAL_TOKEN` (Cloudflare) es
idéntico a `INTERNAL_API_TOKEN` (Vercel Production). Rotar ambos a la vez si
se sospecha exposición (ver abajo). No imprimir los valores.

## Secretos: qué existen y dónde viven

| Secreto | Dónde vive | Uso |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel Production | Acceso backend a Supabase (omite RLS) |
| `INTERNAL_API_TOKEN` | Vercel Production | Bearer del endpoint `worker/tick` |
| `WORKER_INTERNAL_TOKEN` | Cloudflare secret | Igual valor que `INTERNAL_API_TOKEN` |
| `KAPSO_API_KEY` | Vercel Production | API de Kapso (envío / `GET /messages`) |
| `KAPSO_WEBHOOK_SECRET` | Vercel Production | Verificación HMAC del webhook |
| `MENU_SESSION_SECRET` | Vercel Production | HMAC de sesiones de menú |
| `TELEGRAM_BOT_TOKEN` | Vercel Production | Envío de alertas Telegram (server-only) |
| `TELEGRAM_CHAT_ID` | Vercel Production | Destino de las alertas (server-only) |

- Ninguna variable sensible usa `NEXT_PUBLIC_`. Cloudflare **no** tiene secretos
  de Telegram (solo `WORKER_INTERNAL_TOKEN`). `.env.local` está gitignored.

## Qué secreto rotar si se expone

- **`TELEGRAM_BOT_TOKEN`**: pendiente de rotación (se compartió durante la
  configuración inicial). Rotar vía `@BotFather` (`/revoke` / nuevo token) y
  actualizar `TELEGRAM_BOT_TOKEN` en Vercel Production. No afecta a WhatsApp.
- `INTERNAL_API_TOKEN` / `WORKER_INTERNAL_TOKEN`: si se exponen, rotar **ambos
  a la vez** (deben coincidir) — Vercel env + `wrangler secret put`.
- Cualquier otro: rotar en su plataforma y redeploy.

## Verificar que no hay duplicados

- Observar ≥2 `cron_completed` consecutivos: `alerts_sent` debe ser 0 salvo el
  tick que atiende una incidencia real (y esa incidencia solo produce **una**
  alerta: `alert_attempt_count=1`, `alert_status='sent'`, luego no se re-selecciona).
- Una notificación `status='sent'` nunca se degrada; una alerta `sent` nunca se
  re-selecciona. La unicidad de wamid saliente la garantiza el índice global.

## Validar que la base esté limpia (post-prueba)

Read-only:
- `select_due_notification_orders(5)=0` y `select_due_notification_alerts(5)=0`.
- 0 filas `alert_status='alerting'`; 0 claims stale (send >120 s, reconcile >300 s).
- 0 filas `order_number LIKE 'TEST-ALERT-%'` (ningún dato sintético de prueba).
- Conteos de `orders` / `order_notifications` iguales al estado esperado.

Limpieza de una prueba sintética: borrar en orden de FK (notificación hija →
orden padre) por id exacto; nunca tocar filas reales.

## Límites efectivos (topes que impiden bucles)

| Límite | Valor | Dónde |
|---|---|---|
| Pedidos por tick | 5 | `WORKER_ORDER_LIMIT` |
| Envíos Kapso por tick | 1 | `MAX_NETWORK_SENDS_PER_WORKER_RUN` |
| `GET /messages` por tick | 2 | `MAX_HISTORY_READS_PER_WORKER_RUN` |
| Alertas Telegram por tick | 1 | `MAX_ALERT_SENDS_PER_WORKER_RUN` |
| Timeout Worker Cloudflare | 55 s | `TICK_TIMEOUT_MS` |
| `maxDuration` endpoint Vercel | 60 s | ruta `worker/tick` |
| Timeout envío WhatsApp | 20 s | `NOTIFICATION_SEND_TIMEOUT_MS` |
| Timeout fetch Telegram | 10 s | `telegram.ts` |
| Claim envío stale | 120 s | RPC 0005 |
| Claim reconciliación stale | 300 s | RPC 0005 |
| Claim alerta stale | 300 s | RPC 0007 |
| Máx. intentos WhatsApp | 5 | `max_attempts` (0005) |
| Máx. intentos reconciliación | 5 | `max_attempts` (0005) |
| Máx. intentos Telegram | 5 | RPC 0007 |
