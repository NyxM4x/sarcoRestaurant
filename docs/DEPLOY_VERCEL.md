# DEPLOY_VERCEL — Primer deploy manual de La Fija Orders

Guía paso a paso para el **primer deploy manual** en Vercel. Este documento no
ejecuta ninguna acción por sí mismo: cada paso lo realizas tú, manualmente, en
tu momento.

> ⚠️ Todavía **no** configures Kapso (webhook, Flow, Function ni Workflow).
> Eso se hace después de tener la URL final de Vercel (paso 11).

## 0. Antes de empezar

- El repositorio aún no tiene un commit "real": solo existe el commit inicial
  automático de `create-next-app`. Revisa el reporte de Git de esta fase para
  decidir cómo empezar tu historial.
- Ningún paso de esta guía hace push, deploy ni commit por ti.

## 1. Revisar `git status`

```bash
cd la-fija-orders
git status
```

Confirma que:
- `.env.local` **no** aparece listado (debe estar ignorado por `.gitignore`).
- No hay archivos temporales, scripts sueltos (`tmp-*`, servidores falsos, logs)
  ni nada que no reconozcas.

## 2. Crear un commit limpio

Revisa el diff antes de comitear (`git diff`, `git status`). Cuando estés
conforme:

```bash
git add .
git commit -m "tu mensaje"
```

Ver la sección "Git" del reporte de esta fase para una propuesta de mensaje.

## 3. Subir el repositorio a GitHub

1. Crea un repositorio nuevo en GitHub (privado, recomendado mientras el
   proyecto no esté listo para producción).
2. Conéctalo y sube tu rama:

   ```bash
   git remote add origin <URL-de-tu-repo>
   git branch -M main
   git push -u origin main
   ```

## 4. Importar el proyecto en Vercel

1. En el dashboard de Vercel: **Add New… → Project**.
2. Selecciona el repositorio de GitHub que acabas de crear.

## 5. Verificar el Root Directory

Si el repositorio de GitHub tiene `IDEA.md` en la raíz y el proyecto Next.js
vive en `la-fija-orders/`, en la pantalla de configuración de Vercel:

- **Root Directory** → `la-fija-orders`.

Si el repositorio que subiste ya tiene `la-fija-orders/` como raíz, deja
`Root Directory` vacío (`.`). Verifica que Vercel detecte automáticamente
**Next.js** como framework antes de continuar.

## 6. Agregar las variables de entorno

En **Project Settings → Environment Variables**, agrega (ver también
[`.env.example`](../.env.example) y la tabla de [`SETUP.md`](./SETUP.md)):

| Variable | Obligatoria | Notas |
|---|---|---|
| `SUPABASE_URL` | ✅ | Del proyecto Supabase exclusivo de La Fija. |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | **Secreto.** Nunca la pegues en un chat, issue o log. |
| `VERCEL_INTERNAL_TOKEN` | ✅ | Genera un valor aleatorio largo tú mismo (no proviene de Kapso). |
| `KAPSO_API_KEY` | ✅ | Del panel de Kapso. |
| `KAPSO_WEBHOOK_SECRET` | ⏳ | **Todavía no la tienes** — se copia recién en el paso 11, después de crear el webhook. Por ahora puedes dejarla vacía o con un valor temporal; sin ella, el webhook rechaza todo con 401 (comportamiento seguro por defecto). |
| `KAPSO_PHONE_NUMBER_ID` | ✅ | Del panel de Kapso. |
| `KAPSO_API_BASE_URL` | ⬜ | **Omítela.** Sin esta variable, el cliente usa la URL oficial de Kapso por defecto. |
| `APP_BASE_URL` | ✅ | Déjala provisional (p. ej. `https://placeholder.vercel.app`) — la actualizas en el paso 10 con el dominio real. |

Marca todas para los entornos que uses (mínimo **Production**).

## 7. Hacer el primer deploy

Con las variables cargadas, dispara el deploy desde la UI de Vercel (o con un
push a la rama configurada). Espera a que el build termine en verde.

## 8. Comprobar `/` y `/api/health`

- Abre `https://<tu-deployment>.vercel.app/` — debe cargar la landing.
- Abre `https://<tu-deployment>.vercel.app/api/health` — debe responder:

  ```json
  { "ok": true, "service": "la-fija-orders" }
  ```

## 9. Comprobar que `/api/kapso/webhook` rechaza requests sin firma

```bash
curl -i -X POST https://<tu-deployment>.vercel.app/api/kapso/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Event: whatsapp.message.received" \
  -H "X-Webhook-Payload-Version: v2" \
  -H "X-Idempotency-Key: smoke-test-001" \
  -d '{}'
```

Debe responder **401** (`invalid_signature`). Si responde otra cosa, revisa que
`KAPSO_WEBHOOK_SECRET` esté configurada (aunque sea con un valor temporal) y que
el deploy haya tomado las variables de entorno correctamente.

## 10. Actualizar `APP_BASE_URL` con el dominio final

Una vez que confirmes el dominio definitivo del deployment (el de Vercel o uno
custom), actualiza `APP_BASE_URL` en **Project Settings → Environment
Variables** y vuelve a desplegar (redeploy) para que tome el nuevo valor.

## 11. Todavía NO crees el webhook de Kapso

Espera a tener la URL final y estable de producción antes de:

- crear el webhook en el panel de Kapso apuntando a
  `https://<tu-dominio>/api/kapso/webhook`;
- copiar el `KAPSO_WEBHOOK_SECRET` real que Kapso genere y actualizarlo en
  Vercel;
- crear el Flow, la Kapso Function y el Workflow.

Eso corresponde a una fase posterior (4.2+), fuera del alcance de esta guía.

---

## Secretos: nunca al navegador, nunca a Git

- `SUPABASE_SERVICE_ROLE_KEY`, `KAPSO_API_KEY`, `KAPSO_WEBHOOK_SECRET`,
  `VERCEL_INTERNAL_TOKEN` — **jamás** en código, componentes cliente, commits,
  issues, logs ni capturas de pantalla.
- Ninguna variable de este proyecto usa el prefijo `NEXT_PUBLIC_`: todas son
  server-only por diseño (ver `src/lib/env/env.ts`). No agregues una variante
  `NEXT_PUBLIC_` de ninguna de ellas.
- `.env.local` está en `.gitignore` (`.env*`) — nunca fuerces su commit con
  `git add -f`.
- Si accidentalmente subes un secreto a GitHub: rótalo inmediatamente en
  Supabase/Kapso (no basta con borrarlo del historial).
