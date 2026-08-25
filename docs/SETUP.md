# SETUP — Don Zarco Orders

Guía para levantar el proyecto en local y preparar Supabase. El backend
(`/api/flow/order-summary`, `/api/kapso/webhook` con `nfm_reply` y `location`)
ya está implementado y probado localmente contra Supabase real (Fases 1–3.3B).
Todavía faltan: Kapso Function, `flow.json`, Workflow y el webhook real de
Kapso — ver [ROADMAP](#próximos-pasos). Para desplegar en Vercel, ver
[DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md).

## Requisitos

- Node.js 18.18+ (probado con Node 24).
- npm.
- Una cuenta de Supabase (se creará un proyecto **exclusivo** para Don Zarco).

## 1. Instalar y correr en local

```bash
cd don-zarco-orders
npm install
npm run dev      # http://localhost:3000  (landing → /dashboard)
```

Scripts:

- `npm run dev` — servidor de desarrollo.
- `npm run build` — build de producción.
- `npm run start` — sirve el build.
- `npm run lint` — ESLint.
- `npm run test` — pruebas unitarias (Vitest).

## 2. Variables de entorno

1. Copia el ejemplo y complétalo:

   ```bash
   cp .env.example .env.local
   ```

2. **Todas son server-only**: ninguna se expone al navegador (ninguna usa el
   prefijo `NEXT_PUBLIC_`, y solo se leen desde `src/lib/env/env.ts`). Detalle y
   comentarios en [`.env.example`](../.env.example):

   | Variable | Obligatoria | Para qué sirve |
   |---|---|---|
   | `SUPABASE_URL` | ✅ Sí | URL del proyecto Supabase; usada por el cliente admin. |
   | `SUPABASE_SERVICE_ROLE_KEY` | ✅ Sí | Clave `service_role` (omite RLS) — **solo backend**, nunca en logs ni en el navegador. |
   | `INTERNAL_API_TOKEN` | ✅ Sí (para `/api/flow/order-summary`) | Bearer compartido que autentica las llamadas de la Kapso Function hacia Vercel. |
   | `KAPSO_API_KEY` | ✅ Sí (para enviar mensajes) | Header `X-API-Key` al llamar a la API de mensajes de Kapso. |
   | `KAPSO_WEBHOOK_SECRET` | ✅ Sí (para el webhook) | Secreto HMAC para validar `X-Webhook-Signature`. **Se obtiene después** de crear el webhook en el panel de Kapso — no antes. |
   | `KAPSO_PHONE_NUMBER_ID` | ✅ Sí (para enviar mensajes) | ID del número de WhatsApp Cloud API conectado en Kapso. |
   | `KAPSO_API_BASE_URL` | ⬜ Opcional | Override de la URL base de mensajes de Kapso, solo para pruebas locales (p. ej. un servidor falso). **En producción debe omitirse**: sin ella, el cliente usa la URL oficial por defecto (`https://api.kapso.ai/meta/whatsapp/v24.0`, ver `src/lib/kapso/client.ts`). |
   | `APP_BASE_URL` | ✅ Sí | URL pública de la app. En local: `http://localhost:3000`. **En producción será la URL del deployment de Vercel** — actualízala ahí una vez que la conozcas. |

   La validación de estas variables es **lazy**: solo corre cuando se usa el
   cliente de Supabase o de Kapso (`getServerEnv()` en `src/lib/env/env.ts`), no
   durante el build. Por eso el build no requiere credenciales reales. Las
   variables opcionales vacías (`""`) se tratan como no definidas.

## 3. Configurar Supabase (manual)

> ⚠️ Las migraciones **no** se ejecutan desde el código: se aplican a mano.
> Los siguientes pasos son para el proyecto exclusivo de Don Zarco.

1. Crea un **proyecto nuevo y exclusivo** en Supabase (no reutilizar otros).
2. Aplica el esquema **completo**, en orden numérico estricto.

   No basta con `0001_init.sql`: cada migración posterior añade tablas,
   funciones y RPCs de los que depende el código. Saltarse una no da error al
   aplicarla — falla más tarde, en runtime, la primera vez que alguien intenta
   hacer un pedido.

   - **SQL Editor** (Dashboard de Supabase): pega y ejecuta, uno por uno:

     | # | Archivo | Qué agrega |
     |---|---|---|
     | 1 | `0001_init.sql` | `menu_items`, `orders`, `order_items`, `webhook_events` |
     | 2 | `0002_menu_sessions.sql` | `menu_sessions` |
     | 3 | `0003_web_checkout.sql` | RPC de checkout web |
     | 4 | `0004_order_notifications.sql` | `order_notifications` |
     | 5 | `0005_order_notification_recovery.sql` | recuperación y reintentos |
     | 6 | `0006_discover_stale_reconciling_notifications.sql` | detección de colgadas |
     | 7 | `0007_notification_alert_claims.sql` | claims de alerta |
     | 8 | `0008_payment_method.sql` | método de pago |
     | 9 | `0009_dynamic_delivery.sql` | delivery dinámico |
     | 10 | `0010_delivery_quote_result.sql` | resultado de cotización |
     | 11 | `0011_fix_delivery_quote_result_guard_order.sql` | corrección del guard |
     | 12 | `0012_add_order_received_notification.sql` | aviso de pedido recibido |
     | 13 | `0013_dynamic_delivery_notifications.sql` | notificaciones de delivery |
     | 14 | `0014_agent_foundation.sql` | tablas del agente de WhatsApp |
     | 15 | `0015_menu_send_deliveries.sql` | `menu_send_deliveries` |
     | 16 | `0016_webhook_events_durable_inbox.sql` | inbox durable de webhooks |
     | 17 | [`supabase/seed.sql`](../supabase/seed.sql) | **la carta de Don Zarco** |
     | 18 | `0017_don_zarco_menu.sql` | ver nota de abajo |
     | 19 | `0018_retire_gaseosa_pequena.sql` | retira un producto de la carta |
     | 20 | `0019_delivery_notice.sql` | marca del aviso al grupo de reparto |
     | 21 | `0020_dashboard_users.sql` | **`dashboard_users`** (acceso interno) |

   - **Supabase CLI** (si lo usas localmente):
     ```bash
     supabase db push          # aplica las 20 migraciones en orden
     # luego ejecuta el seed manualmente (SQL Editor o psql)
     ```

   > **Sobre `0017_don_zarco_menu.sql` en una base nueva:** es la migración que
   > convirtió el catálogo de La Fija al de Don Zarco. En una base nueva no hace
   > falta —`seed.sql` ya trae la carta correcta— pero aplicarla es inocuo
   > (es idempotente) y deja el historial de migraciones alineado con el repo.
   > Si la aplicas, hazlo al final.

3. Copia `Project URL` y `service_role key` a `.env.local`
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

4. **Da de alta al menos un usuario admin** (ver seccion siguiente). Sin esto
   nadie puede entrar al panel: no existen contrasenas compartidas de respaldo.

### Usuarios del acceso interno

El panel (`/dashboard`) y la cocina (`/cocina`) NO usan una contrasena
compartida por variable de entorno. Cada persona tiene su usuario en la tabla
`dashboard_users`, y el **rol guardado** decide donde aterriza al ingresar:

| Rol | Entra a | Puede ver |
|---|---|---|
| `admin` | `/dashboard` | el panel del encargado y tambien la cocina |
| `kitchen` | `/cocina` | solo el tablero de cocina |

La contrasena se guarda **hasheada con bcrypt**, nunca en claro. El alta es
manual, en dos pasos:

1. Genera el hash (con las dependencias del proyecto ya instaladas):

   ```bash
   node -e "require('bcryptjs').hash(process.argv[1], 12).then(console.log)" 'la-contrasena-elegida'
   ```

   > Usa **comillas simples** alrededor de la contrasena. Sin ellas, una shell
   > se come caracteres como `$1` y acabarias guardando el hash de otra cosa.

2. Inserta el usuario en el **SQL Editor** de Supabase:

   ```sql
   insert into dashboard_users (username, password_hash, role) values
     ('nombre.usuario', '<el hash del paso 1>', 'admin')
   on conflict (lower(username)) do nothing;
   ```

**Cambiar una contrasena** (genera un hash nuevo con el paso 1):

```sql
update dashboard_users set password_hash = '<hash nuevo>' where lower(username) = 'nombre.usuario';
```

**Dar de baja a alguien** sin borrar el historial de su alta:

```sql
update dashboard_users set is_active = false where lower(username) = 'nombre.usuario';
```

Un usuario con `is_active = false` no entra aunque su contrasena sea correcta.
Cerrar sesiones ya abiertas es distinto: la cookie dura 8 h y se firma con
`DASHBOARD_SESSION_SECRET`, asi que para invalidarlas todas de golpe hay que
rotar ese secreto.

### Notas del esquema

- **RLS habilitado** en las 12 tablas, **sin políticas públicas**. El backend usa
  `service_role` (omite RLS); el acceso anónimo queda cerrado por defecto.
- **Idempotencia**: `orders.source_message_id` y `webhook_events.event_id` son
  únicos → los reintentos no duplican pedidos.
- **`order_number`** se genera en la BD con una secuencia segura (`ORD-000001`).
- **Precios**: la fuente de verdad es `menu_items`. Nunca se confía en precios
  enviados desde el teléfono del cliente.
- **Snapshots**: `order_items` guarda `product_name_snapshot` y
  `unit_price_snapshot`; los productos usados no se borran (se desactivan con
  `is_active`).

## Próximos pasos

Ver [ARCHITECTURE.md](./ARCHITECTURE.md), [DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md)
y el orden de construcción en `IDEA.md` §15:

- ✅ **Fase 2 — Backend**: cliente Supabase, repositorio de menú, servicio de
  cálculo, `POST /api/flow/order-summary`, validaciones y pruebas.
- ✅ **Fase 3 — Webhook**: `POST /api/kapso/webhook`, secreto, idempotencia,
  `nfm_reply`, envío de `location_request_message`, `location`.
- ✅ **Fase 4.1 — Preparación para deploy**: auditoría de secretos, variables de
  producción documentadas, guía de deploy manual.
- ⏳ **Fase 4.2+ — Flow**: `flow.json`, Kapso Function, Data Endpoint, Workflow
  y configuración real del webhook (solo tras tener la URL final de Vercel).
- ⏳ **Fase 5 — Dashboard**: lista, detalle y cambio de estado (funcional).
- ⏳ **Fase 6 — Validación**: pickup, delivery, ubicación, cantidades inválidas,
  reintentos; publicar el Flow solo cuando todo pase.
