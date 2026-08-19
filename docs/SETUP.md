# SETUP — La Fija Orders

Guía para levantar el proyecto en local y preparar Supabase. El backend
(`/api/flow/order-summary`, `/api/kapso/webhook` con `nfm_reply` y `location`)
ya está implementado y probado localmente contra Supabase real (Fases 1–3.3B).
Todavía faltan: Kapso Function, `flow.json`, Workflow y el webhook real de
Kapso — ver [ROADMAP](#próximos-pasos). Para desplegar en Vercel, ver
[DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md).

## Requisitos

- Node.js 18.18+ (probado con Node 24).
- npm.
- Una cuenta de Supabase (se creará un proyecto **exclusivo** para La Fija).

## 1. Instalar y correr en local

```bash
cd la-fija-orders
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
   | `VERCEL_INTERNAL_TOKEN` | ✅ Sí (para `/api/flow/order-summary`) | Bearer compartido que autentica las llamadas de la Kapso Function hacia Vercel. |
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

> ⚠️ En esta fase **no** se ejecutan migraciones desde el código ni se usan
> credenciales reales. Los siguientes pasos son manuales, para cuando exista el
> proyecto exclusivo de La Fija.

1. Crea un **proyecto nuevo y exclusivo** en Supabase (no reutilizar otros).
2. Aplica el esquema. Opciones:

   - **SQL Editor** (Dashboard de Supabase): pega y ejecuta, en orden:
     1. [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql)
     2. [`supabase/seed.sql`](../supabase/seed.sql)

   - **Supabase CLI** (si lo usas localmente):
     ```bash
     supabase db push          # aplica migraciones
     # luego ejecuta el seed manualmente (SQL Editor o psql)
     ```

3. Copia `Project URL` y `service_role key` a `.env.local`
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

### Notas del esquema

- **RLS habilitado** en las 4 tablas, **sin políticas públicas**. El backend usa
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
