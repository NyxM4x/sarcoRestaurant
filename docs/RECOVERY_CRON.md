# RECOVERY CRON — quién despierta a los workers de recuperación

Estado: **implementado y probado en local. NADA desplegado.** El plan de
despliegue está al final y todavía no se ha ejecutado.

## Por qué existe

El webhook acepta el evento de Kapso, lo escribe en el inbox durable y hace el
trabajo dentro de un `after()`. Eso es rapidez, no durabilidad: si la función se
congela o muere a mitad, la fila queda reclamada con un lease que vence y nadie
vuelve a por ella.

Ese fallo no da error en ninguna parte. El pedido simplemente no se confirma, o
el comprobante no se captura, y nadie se entera hasta que reclama el cliente. Es
el fallo más caro justamente porque es silencioso, y se vuelve más probable
cuanta más carga hay — o sea, en hora punta.

Los dos workers de recuperación existen para eso. Pero solo corren si alguien
los llama, y de eso va este documento.

## Los dos caminos, y cuál es el oficial

| | Cloudflare Workers | `GET /api/internal/cron/tick` |
| --- | --- | --- |
| Rol | **despertador principal** | **fallback** |
| Invocaciones | dos, una por worker | una que mueve los dos |
| Presupuesto | 55 s **cada uno** | 60 s **para los dos** |
| Observabilidad | separada por worker | un solo log |
| Depende de | Cloudflare | el cron de Vercel |

**El camino oficial son los dos Cloudflare Workers.** Son dos despliegues
independientes a propósito: un evento del inbox puede llevar un turno completo
del agente —11–12 s medidos en Production—, así que encadenar los dos recoveries
en una sola invocación significa que uno le come el presupuesto al otro, y que
si la invocación se pasa de tiempo fallan **los dos** ese minuto. La durabilidad
de los mensajes de clientes no debe depender de la salud del worker de
notificaciones.

`GET /api/internal/cron/tick` **se conserva como segunda cuerda**: cubre el caso
de que Cloudflare esté caído o los Workers todavía no estén desplegados. No es
el despertador principal, y no debe activarse a la vez que los Workers salvo
deliberadamente — dos latidos solapados no rompen nada (los claims atómicos y
los leases lo resuelven), pero duplican el consumo sin añadir cobertura.

> El plan de Vercel actual no admite crons (ver commit `a3bd210`), así que hoy
> ese fallback no está programado. La ruta sigue existiendo y sigue protegida.

## Estado HTTP del fallback

`GET /api/internal/cron/tick` ejecuta los dos workers con `Promise.allSettled`
—independientes: que uno caiga no impide que el otro corra— y después resume:

| Situación | Estado |
| --- | --- |
| Los dos workers responden 2xx | **200** |
| Alguno lanza | **503** |
| Alguno responde 401/4xx/5xx | **503** |
| Un worker responde 200 con eventos fallidos dentro | **200** |

La última fila es la que importa entender. Un evento que falló **dentro** de un
worker ya quedó reprogramado con su `next_attempt_at` y vuelve solo: eso es el
sistema funcionando, no una avería de infraestructura. Si tiñera el latido de
rojo, la alarma sonaría casi a diario y dejaría de mirarse — y entonces no
sonaría el día que el latido de verdad se para.

Lo que sí es una avería es que un worker no llegara a responder o respondiera
no-2xx: ese minuto no se recuperó nada.

No hay reintento interno. Un retry dentro de la misma invocación alargaría el
tick hacia el minuto siguiente y podría solaparse con el próximo; el reintento
es el próximo Cron, con el trabajo intacto en la base.

El cuerpo lleva los dos estados por separado (`inbox`, `notifications`) para no
tener que abrir los logs solo para saber cuál cayó. Una promesa rechazada sale
como `'error'` y nada más: el mensaje de una excepción puede llevar SQL, una URL
con token o un teléfono, y esto se devuelve por HTTP.

## Tenencia: por qué los Workers llevan prefijo `sarco-`

Los dos paquetes de `cloudflare/` nacieron copiados de otro despliegue del mismo
operador y llegaron hasta `a3bd210` con dos problemas de los que no avisa nadie:

1. **`WORKER_TICK_URL` apuntaba a `https://la-fija-orders.vercel.app/...`** — un
   proyecto **real y vivo** en la misma cuenta de Vercel. Un `wrangler deploy`
   no habría fallado: habría publicado un Cron que cada minuto llama al endpoint
   interno de otro restaurante con el Bearer de este, y en los logs se habría
   visto como un tick sano.
2. **Los nombres desplegables eran genéricos** (`notification-recovery-cron`,
   `webhook-events-recovery-cron`). `name` es la identidad del Worker *dentro de
   la cuenta de Cloudflare*: dos proyectos con el mismo `name` son el mismo
   Worker, y el segundo deploy sobrescribe al primero sin avisar.

Ahora:

| | Antes | Ahora |
| --- | --- | --- |
| Worker del inbox | `webhook-events-recovery-cron` | `sarco-webhook-events-recovery-cron` |
| Worker de notificaciones | `notification-recovery-cron` | `sarco-notification-recovery-cron` |
| Destino | `la-fija-orders.vercel.app` | `sarco-restaurant.vercel.app` |

### El guardián

Tres pruebas arquitectónicas impiden la reincidencia:

- `src/lib/security/worker-tenancy.test.ts` — **corre con `npm test`**, que es
  el gate que se ejecuta siempre. Descubre los Workers recorriendo
  `cloudflare/`, así que cubre también el tercero que alguien añada mañana.
- `cloudflare/*/test/no-cross-tenant.test.ts` — uno por Worker, para que el
  guardián viaje con el desplegable.

Cubren toda la **configuración ejecutable** (lo que `wrangler` lee o empaqueta):
`wrangler.jsonc`, `src/**`, `package.json` y `.dev.vars.example`. El README
queda fuera a propósito: documenta, no se ejecuta, y un guardián que falla por
un ejemplo en prosa acaba desactivado.

## Contrato de cada Worker

Sin cambios respecto a lo que ya había, y se conserva entero:

- dos Workers **independientes**, un Cron Trigger por Worker;
- frecuencia `* * * * *` (UTC);
- **un solo `POST`** por ejecución, cuerpo exactamente `{}`;
- timeout **55 s** (por debajo del `maxDuration = 60` del endpoint y por encima
  de su presupuesto interno de reloj de 42 s);
- **cero retry** dentro del mismo tick — la recuperación es el minuto siguiente;
- logs saneados: nunca token, `Authorization`, URL, payload, teléfono, WAMID ni
  claves de idempotencia;
- claims, leases e idempotencia siguen viviendo en la base, no en el Worker;
- el secreto vive **únicamente** como Cloudflare Secret.

El caller no elige nada: ni `order_id`, ni teléfono, ni WAMID, ni límite, ni
fila. El cuerpo es `{}` y la base decide qué se recupera con
`FOR UPDATE SKIP LOCKED`.

## Seguridad

- **Bearer fuerte, comparación en tiempo constante.** `safeCompare` compara
  hashes SHA-256 de longitud fija, así que no filtra ni el contenido ni la
  longitud por el tiempo de ejecución.
- **Cero secreto en URL, repo, logs o respuesta.** `WORKER_TICK_URL` es una var
  pública; el token va en la cabecera `Authorization` y solo existe como
  Cloudflare Secret. Las pruebas de cada Worker lo verifican sobre el
  `wrangler.jsonc` crudo.
- **Sin restricción por IP.** Cloudflare no garantiza un rango estable para las
  invocaciones de Workers, y una allowlist que caduque sola convierte la red de
  seguridad en un 403 silencioso. El Bearer es la única puerta.

### Pendiente de autorización: rate limit

Un rate limit en `/api/internal/*/worker/tick` es razonable, pero **no se ha
implementado**: no se puede añadir sin demostrar antes que no rompe ticks
solapados, y hoy los ticks *pueden* solaparse por diseño — un tick que tarda 55 s
convive con el que dispara el minuto siguiente.

Cualquier propuesta tendría que cumplir tres cosas a la vez:

1. permitir **al menos 2 ticks concurrentes por endpoint** (el que se alarga y
   el nuevo), con margen para un tercero;
2. contar por **credencial**, no por IP (ver arriba);
3. devolver **429** y no 5xx, para que el Worker lo registre como
   `cron_rate_limited` y no como avería del endpoint.

Una ventana de ~10 peticiones/minuto por endpoint cumpliría las tres con holgura
frente al caudal real (1/min). **No implementar sin una prueba que ejercite el
solape.**

### Hardening posterior: `RECOVERY_CRON_TOKEN` dedicado

**No se ha hecho en esta pasada, y es deliberado: no se tocan secretos.**

Hoy los dos Workers usan `INTERNAL_API_TOKEN`, el mismo valor que protege *todas*
las rutas `/api/internal/*` y `/api/flow/*`. Eso significa que un token filtrado
desde un Worker abre mucho más que el recovery, y que rotarlo obliga a tocar a la
vez Vercel y los dos Workers — una rotación con ventana de caída.

Propuesta para una fase aparte:

1. Añadir `RECOVERY_CRON_TOKEN` a la validación de entorno, **opcional**.
2. En los dos endpoints `worker/tick`, aceptar `RECOVERY_CRON_TOKEN` **o**
   `INTERNAL_API_TOKEN` mientras dure la transición. Aceptar los dos es lo que
   permite rotar sin ventana de caída.
3. Cargar el valor nuevo en los dos Workers (`wrangler secret put`).
4. Verificar con `wrangler tail` que se ven `cron_completed` y ningún
   `cron_unauthorized`.
5. **Solo entonces** retirar `INTERNAL_API_TOKEN` del camino del recovery.

El orden importa: invertir los pasos 3 y 5 deja el recovery caído hasta que
alguien se dé cuenta, y el recovery caído es invisible por definición.

## Plan de despliegue (NO EJECUTADO)

Requisitos previos, en este orden:

1. Migración `0016` aplicada en Supabase (claims del inbox).
2. `/api/internal/webhook-events/worker/tick` y
   `/api/internal/order-notifications/worker/tick` desplegados en
   `https://sarco-restaurant.vercel.app` — **ya verificado**: los dos responden
   401 sin Bearer, luego existen y exigen autenticación.
3. `INTERNAL_API_TOKEN` configurado en Vercel.

> **El 401 solo demuestra que las rutas existen y están protegidas.** No
> demuestra qué commit está desplegado, ni que la migración `0016` esté aplicada,
> ni que `WEBHOOK_ASYNC_ACK` valga `true`, ni que el `INTERNAL_API_TOKEN` de
> Vercel coincida con el `WORKER_INTERNAL_TOKEN` del Worker. Las cuatro cosas
> hay que verificarlas por separado, con acceso al proyecto.

> **BLOQUEO DE DEPLOYMENT.** La cuenta de Vercel autenticada
> (`rochayoan40-5104`) **no controla el proyecto Sarco**: `vercel project ls`
> lista 16 proyectos y ninguno lo es, aunque el alias responde y sirve la app.
> Hasta obtener acceso al proyecto real, este plan no puede ejecutarse.
>
> **No se debe crear ni importar un proyecto Vercel duplicado** para sortearlo:
> un segundo proyecto sobre el mismo repositorio produciría un despliegue
> paralelo con su propia base de datos y sus propios secretos, y los Workers
> despertarían al equivocado.

Después, **por Worker y de uno en uno**:

```bash
cd cloudflare/webhook-events-recovery-cron
npm install
npm test                       # incluye el guardián de tenencia
npx wrangler secret put WORKER_INTERNAL_TOKEN   # el valor NO se escribe aquí
npx wrangler deploy
npx wrangler tail sarco-webhook-events-recovery-cron --format json
```

Y lo mismo con `cloudflare/notification-recovery-cron` →
`sarco-notification-recovery-cron`.

### Validación con Wrangler (ya ejecutada, sin desplegar)

Los dos Workers se validaron con `wrangler deploy --dry-run --outdir <temporal>`
usando la versión declarada en cada paquete (4.118.0 y 4.127.0). Resultado:
**cero errores y cero advertencias** en ambos. El dry-run confirmó:

| Comprobación | Cómo se confirmó |
| --- | --- |
| Nombres exclusivos de Sarco | Wrangler valida el formato de `name` (rechaza mayúsculas y espacios) |
| Entrypoint correcto | bundle generado; un `main` inexistente aborta con error |
| `compatibility_date` válida | Wrangler exige ISO-8601 y rechaza cualquier otra cosa |
| URL de destino | la tabla de bindings muestra `env.WORKER_TICK_URL` → dominio de Sarco |
| Cero referencia ejecutable a La Fija | `grep` sobre los bundles compilados: ninguna |

Lo que el dry-run **no** valida: la sintaxis del cron (se comprueba en el
servidor), y la existencia del secreto. La cuenta de los crons y la expresión
`* * * * *` las cubren las pruebas del propio paquete.

#### Sobre `secrets.required`

Una auditoría anterior sospechó que esta propiedad no formaba parte del esquema
de Wrangler. **Es incorrecto, y se comprobó empíricamente:** al añadir una clave
inventada, Wrangler avisa —`Unexpected fields found in top-level field:
"clave_totalmente_inventada"`— y al meter una subclave inventada dentro de
`secrets` avisa igual —`Unexpected fields found in secrets field`—. Con la
configuración real **no emite ninguna advertencia**, luego `secrets.required` sí
está en el esquema reconocido. No se elimina.

Ahora bien, que Wrangler **reconozca** el campo no es lo mismo que Wrangler
**garantice** que el secreto exista en el momento del deploy: la tabla de
bindings del dry-run solo lista `WORKER_TICK_URL`, y no hay forma de comprobar la
presencia del secreto sin una sesión autenticada. Por tanto:

> `npx wrangler secret put WORKER_INTERNAL_TOKEN` es un **prerrequisito
> operativo** que hay que ejecutar y verificar a mano. Wrangler no lo impone.

La garantía real está en el runtime y sí está probada: sin
`WORKER_INTERNAL_TOKEN` el Worker registra `cron_contract_error` con
`reason: missing_token` y hace **cero POST**.

### Verificación tras desplegar

- `GET https://<worker>.workers.dev/` → `{"service":"sarco-...","status":"ok"}`.
  Es un health check **inerte**: no dispara el tick.
- En reposo, cada minuto: `cron_started` y luego `cron_completed` con
  `claimed: 0, processed: 0, failed: 0`. **Un tick sin trabajo es un no-op sano**,
  no un error: el camino normal es el `after()`, y esto solo recoge lo que aquel
  no llegó a ejecutar.
- Ningún log debe contener token, `Authorization`, URL ni datos de clientes.

### Cómo revertir

Quitar el Cron Trigger en el dashboard (Workers & Pages → el Worker → Triggers),
o dejar `"crons": []` en `wrangler.jsonc` y volver a desplegar.

Pausarlo **no pierde trabajo**: las filas vencidas siguen en la base y se recogen
al reactivarlo. Lo que se pierde mientras está pausado es la red de seguridad.
