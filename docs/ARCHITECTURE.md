# ARCHITECTURE — Don Zarco Orders

Resumen de la arquitectura y del estado actual (**Fase 1 — Base**). La
especificación completa está en `IDEA.md` (raíz del repo `DeliveryWa`).

## Visión general

```text
Cliente en WhatsApp
      ↓
Kapso (WhatsApp Cloud API) envía un WhatsApp Flow
      ↓
Cliente selecciona productos
      ↓
Kapso Data Endpoint → Kapso Function
      ↓
Next.js API en Vercel  ←→  Supabase (Postgres)
      ↓
Dashboard interno
```

Un solo restaurante, una sucursal, un número de WhatsApp. Sin multitenant,
pagos, repartidores ni IA (fuera de alcance del MVP).

## Estructura del proyecto

```text
la-fija-orders/
  src/
    app/
      api/                 # placeholders de Route Handlers (ver api/README.md)
      dashboard/           # dashboard interno (placeholder Fase 1)
      layout.tsx, page.tsx # landing
    components/            # UI (vacío por ahora)
    lib/
      env/env.ts           # validación lazy de env (Zod), server-only
      supabase/server.ts   # cliente admin server-only (getSupabaseAdmin)
      menu/index.ts        # contrato del repositorio de menú (Fase 2)
      orders/index.ts      # contrato del servicio de pedidos (Fase 2/3)
    types/                 # tipos del modelo de datos
  supabase/
    migrations/0001_init.sql
    seed.sql
  docs/                    # SETUP.md, ARCHITECTURE.md
  .env.example
```

## Principios

- La lógica de negocio vive en `src/lib/*` (server-only), **nunca** en
  componentes visuales ni en el frontend.
- Precios y menú provienen de Supabase; el teléfono del cliente no es fuente de
  verdad de precios ni totales.
- Secretos solo en el backend (`service_role`, tokens Kapso); nunca en el
  navegador ni en logs.
- Cambios pequeños y verificables; no sobrearquitecturar.

## Estado por capa (Fase 1)

| Capa | Estado |
|---|---|
| Scaffolding Next.js (App Router, TS, Tailwind v4, ESLint) | ✅ hecho |
| Tipos del modelo de datos (`src/types`) | ✅ hecho |
| Env lazy + cliente Supabase server-only | ✅ hecho (no se conecta aún) |
| Esquema SQL + seed | ✅ hecho (no ejecutado) |
| Repositorio de menú + servicio de pedidos (cálculo/upsert draft) | ✅ Fase 2 |
| `POST /api/flow/order-summary` | ✅ Fase 2 |
| `POST /api/kapso/webhook` | ⏳ Fase 3 (placeholder) |
| `GET /api/orders`, `PATCH /api/orders/[id]` | ⏳ Fase 5 (placeholder) |
| Dashboard real (lista/detalle/estado) | ⏳ Fase 5 (placeholder) |
| WhatsApp Flow JSON + Kapso Function | ⏳ Fase 4 |

## Modelo de datos

Cuatro tablas (`supabase/migrations/0001_init.sql`):

- **`menu_items`** — catálogo. `code` único, `category` ∈ {plato, bebida,
  extra}, `price >= 0`, `is_active`, `sort_order`.
- **`orders`** — pedidos. `order_number` único (`ORD-000001`, secuencia en BD),
  8 estados (`draft`…`cancelled`), montos `>= 0`, `source_message_id` único
  (idempotencia), `location_request_message_id` único (correlación de
  ubicación), datos GPS, `confirmed_at`.
- **`order_items`** — detalle con **snapshots** de nombre y precio; `quantity`
  entre 1 y 10; FK a `orders` (cascade) y a `menu_items` (restrict).
- **`webhook_events`** — idempotencia de webhooks; `event_id` único, `payload`
  jsonb, `status`, `processed_at`.

RLS habilitado en las 4 tablas sin políticas públicas (el backend usa
`service_role`).

## Seguridad e idempotencia (resumen)

- Validar secreto del webhook de Kapso y `signature_valid` del Data Endpoint
  (Fases 3/2).
- Bearer token para Kapso Function → Vercel; comparación timing-safe.
- `source_message_id` y `event_id` únicos → reintentos no duplican pedidos.
- `order_number` secuencial (no aleatorio).
