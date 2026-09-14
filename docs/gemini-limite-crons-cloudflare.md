# Prompt para Gemini — cuatro despertadores y cinco lugares

> Este archivo **es** el prompt. Copialo entero (Ctrl+A, Ctrl+C) y pegalo en
> Gemini. No hace falta editar nada.

---

## ROL

Sos arquitecto de sistemas backend. Te van a describir un sistema en producción,
un fallo confirmado con datos, un límite de plataforma con el que chocamos al
arreglarlo, y dos opciones para salir. Tu trabajo es **elegir una y defenderla**,
o proponer otra mejor.

No escribas código. Lo que hace falta es el criterio: qué opción sobrevive mejor
con una sola persona técnica, varios restaurantes y cero presupuesto para
infraestructura, en un sistema donde cada pieza que se cae lo hace **sin avisar**.

Respondé en español.

---

## EL NEGOCIO

Un local de trancapechos y hamburguesas en Santa Cruz de la Sierra, Bolivia.
Atiende **de 18:00 a 04:00** por **WhatsApp**, con un bot que atiende de punta a
punta. El cliente arma su pedido en un menú web, manda su ubicación, recibe su
total y paga por QR (manda foto del comprobante) o en efectivo.

**Volumen:** decenas de pedidos por noche.

**Equipo:** una persona técnica, que además vende este mismo sistema a otros
restaurantes. Ya hay un segundo restaurante (La Fija) con su propia copia del
sistema.

---

## LA PILA

| Pieza | Dónde |
|---|---|
| App (Next.js 16) | Vercel, **plan sin crons** |
| Base de datos | Supabase (Postgres) |
| WhatsApp | Kapso (API HTTP) |
| Despertadores | Cloudflare Workers con Cron Trigger `* * * * *`, **plan Free** |

La app hace el trabajo en un `after()` de Vercel: rápido, pero no durable. Si la
función muere a mitad, la fila queda en la base con un *lease* vencido y **alguien
tiene que volver a despertarla**. Para eso existen cuatro endpoints internos, y un
Cloudflare Worker por endpoint que cada minuto hace **un solo `POST {}`** con un
Bearer. Los Workers no conocen la base ni la lógica: solo tocan el timbre.

```
sarco-webhook-events-recovery-cron  →  POST /api/internal/webhook-events/worker/tick
sarco-notification-recovery-cron    →  POST /api/internal/order-notifications/worker/tick
sarco-telegram-alerts-cron          →  POST /api/internal/telegram-alerts/worker/tick
sarco-order-expiry-cron             →  POST /api/internal/orders/expiry/worker/tick
```

| Endpoint | Qué recupera | Si no corre |
|---|---|---|
| webhook-events | Mensajes de WhatsApp que se cortaron a mitad (texto, ubicación, **foto del comprobante**) | El mensaje se pierde en silencio |
| order-notifications | Avisos al cliente que no salieron ("recibimos tu pedido", etc.) + alertas técnicas | El cliente no recibe su aviso |
| telegram-alerts | Avisos al grupo de repartidores que fallaron | El repartidor no se entera del pedido |
| orders/expiry | Cancela pedidos vencidos (efectivo sin confirmar, carrito sin ubicación, QR sin pagar) | Pedidos fantasma abiertos días |

Cada endpoint tiene `maxDuration = 60 s` en Vercel. El Worker corta a los 55 s.
El de webhook-events procesa como mucho 3 eventos por tick, porque un evento
puede llevar un turno completo del modelo de lenguaje (11–12 s medidos).

El repo documenta que son **cuatro despliegues independientes a propósito**:
encadenar las recuperaciones una detrás de otra en la misma invocación haría que
una le coma el tiempo a la otra y que un timeout tumbe a todas el mismo minuto.

Los cuatro endpoints son idempotentes: dos despertadores solapados no duplican
nada (claims atómicos y leases en la base).

---

## LO QUE PASÓ

El 13-09-2026 una clienta pagó Bs 72 por QR y mandó la foto del comprobante a las
20:00. La función de Vercel empezó a procesar la foto y murió a mitad. La fila
quedó en `processing` con su lease vencido a las 20:02, y **nadie la retomó**. Sin
comprobante registrado, el pedido nunca apareció en la cocina, el bot le siguió
pidiendo la foto y a las 2 horas el pedido se canceló solo. La clienta pagó y no
recibió nada.

La causa: **dos de los cuatro Workers nunca se habían desplegado**
(`webhook-events` y `notification-recovery`). Estaban escritos y probados en el
repo, pero no existían en Cloudflare. Nadie lo notó, porque un despertador que no
existe no produce ningún error.

En 3 días quedaron 3 mensajes trabados (de ~15 000 eventos en 30 días). Es raro,
pero cada caso es un cliente perdido sin que nadie se entere.

### Lo que ya se hizo

1. Se neutralizaron en la base los 3 mensajes trabados, un aviso al cliente del
   07-09 y 26 alertas técnicas viejas, para que al encender los Workers no les
   lleguen mensajes de hace días a los clientes ni 26 alertas al grupo de
   repartidores.
2. Se subieron los dos Workers faltantes con su secreto.
3. **Cloudflare rechazó sus Cron Triggers:**

```
This account has reached the Workers Free limit of 5 cron triggers per account.
Upgrade to Workers Paid to increase this limit to 1,000.
```

### Por qué no hay lugar

La cuenta de Cloudflare es una sola para los dos restaurantes:

| Worker | Restaurante | Cron activo |
|---|---|---|
| `notification-recovery-cron` | La Fija | sí |
| `telegram-alerts-cron` | La Fija | sí |
| `order-expiry-cron` | La Fija | sí |
| `sarco-telegram-alerts-cron` | Sarco | sí |
| `sarco-order-expiry-cron` | Sarco | sí |
| `sarco-webhook-events-recovery-cron` | Sarco | **no (sin lugar)** |
| `sarco-notification-recovery-cron` | Sarco | **no (sin lugar)** |

5 de 5 ocupados. Sarco necesita 2 más. La Fija, con el diseño actual, también
necesitaría llegar a 4. Y cada restaurante nuevo, otros 4.

---

## LOS LÍMITES QUE IMPORTAN

Según la documentación de Cloudflare (Workers Free vs Paid):

| Límite | Free | Paid (5 USD/mes) |
|---|---|---|
| Cron Triggers por **cuenta** | 5 | 250 (el mensaje de error dice 1000) |
| CPU por invocación de Cron | **10 ms** | 30 s |
| Duración de reloj de una invocación de Cron | 15 min | 15 min |
| Subpeticiones por invocación | 50 | 10 000 |
| Conexiones simultáneas por invocación | 6 | 6 |
| Peticiones por día | 100 000 | sin límite |
| Propagación al cambiar un Cron Trigger | hasta 15 min | hasta 15 min |

Varias expresiones cron dentro de un mismo Worker **cuentan igual** contra el
límite: la única forma de ahorrar lugares es que un solo cron despierte varias
cosas.

El tiempo esperando una respuesta de red **no cuenta como CPU**; los 10 ms son
cómputo real (armar la petición, leer el JSON, escribir el log).

---

## LO QUE HAY QUE DECIDIR

Cómo hacer que **cada restaurante tenga sus cuatro recuperaciones corriendo cada
minuto** sin pagar, de una forma que siga funcionando cuando haya tres, cuatro o
cinco restaurantes, y sin que el próximo despliegue vuelva a chocar con el límite
en silencio.

Hay una tercera opción que dejamos solo como referencia: **pagar Workers Paid
(5 USD/mes)**. No requiere cambiar código y sube el límite a cientos de crons.
La descartamos por ahora porque el objetivo es cero costo fijo, pero si creés que
es claramente lo correcto, decilo.

---

## OPCIÓN A — Un solo despertador por restaurante

### Cómo sería

Reemplazar los cuatro Workers de Sarco por **uno solo**
(`sarco-recovery-cron`), con **un** Cron Trigger `* * * * *`. En cada minuto
dispara los cuatro `POST` **en paralelo**, no uno detrás de otro:

```
scheduled()  cada minuto
  └─ Promise.allSettled([
       POST webhook-events       (su propio AbortController, 55 s)
       POST order-notifications  (su propio AbortController, 55 s)
       POST telegram-alerts      (su propio AbortController, 55 s)
       POST orders/expiry        (su propio AbortController, 55 s)
     ])
  └─ un log por endpoint: cron_completed / cron_timeout / cron_unauthorized …
```

Los cuatro endpoints siguen siendo cuatro invocaciones separadas **en Vercel**, con
sus propios 60 s. Lo único que se comparte es quién toca el timbre. Como van en
paralelo, uno lento no le quita tiempo a otro: cada uno espera su propia
respuesta con su propio límite.

Un secreto (`WORKER_INTERNAL_TOKEN`) y cuatro URLs como variables. El mismo
paquete sirve para cualquier restaurante cambiando el nombre, las URLs y el
secreto.

### Cómo se migra

1. Programar el Worker unificado con tests (mismo contrato de logs que los
   actuales, sin datos personales).
2. Quitar el cron de `sarco-telegram-alerts-cron` para liberar un lugar (4 de 5).
3. Desplegar `sarco-recovery-cron` con su cron (5 de 5) y verificar con
   `wrangler tail` que los cuatro endpoints responden `200`.
4. Quitar el cron de `sarco-order-expiry-cron` (4 de 5) y borrar los cuatro
   Workers viejos de Sarco.

Entre el paso 2 y el 3 (más la propagación de hasta 15 min) las alertas de
reparto de Sarco no tienen quien las reintente. No se pierde nada, porque todo
queda en la base y se recoge al volver, pero conviene hacerlo con el local cerrado.

Resultado: **Sarco usa 1 lugar**. La cuenta queda en 4 de 5 (3 de La Fija + 1 de
Sarco). Si después se unifica La Fija igual, quedan 2 de 5, y **caben 5
restaurantes en una cuenta gratis**.

### A favor

- **Gratis y en la misma cuenta.** No hay que crear nada ni iniciar sesión en otro
  lado.
- **Escala:** 1 lugar por restaurante en vez de 4.
- **Menos piezas que desplegar por cliente:** 1 Worker y 1 secreto, en vez de 4 y
  4. Lo que acaba de pasar —dos de cuatro despliegues olvidados— se vuelve mucho
  más difícil: o está el despertador o no está.
- **Los tiempos siguen separados** donde importa (Vercel) porque los disparos van
  en paralelo, no encadenados.
- Menos invocaciones de Cloudflare por día (1 440 por restaurante en vez de
  5 760).

### En contra

- **Contradice el diseño documentado** del repo (un Worker por endpoint), y hay
  que actualizar la documentación y las pruebas de tenencia que recorren
  `cloudflare/`.
- **Un solo punto de fallo:** si ese Worker queda mal configurado (secreto
  equivocado, URL mal escrita, cron que no propagó), se caen **las cuatro**
  recuperaciones a la vez, no una.
- **Límite de CPU de 10 ms en Free:** hoy cada Worker hace un `fetch` y un log.
  Uno solo haría cuatro `fetch`, cuatro lecturas de JSON y cuatro logs. Debería
  seguir muy por debajo, porque esperar la red no cuenta, pero **hay que medirlo**
  en producción: si se pasa, Cloudflare corta la invocación entera.
- **Logs mezclados** en un solo Worker: se distinguen por el nombre del endpoint
  en cada línea, pero ya no hay un panel por recuperación.
- **Trabajo de programación**, pruebas y una ventana de migración.
- La Fija vive en otro repo (no está en esta PC); unificarla es un trabajo aparte.

---

## OPCIÓN C — Una cuenta de Cloudflare por restaurante

### Cómo sería

Crear una cuenta de Cloudflare nueva **solo para Sarco**, idealmente con un correo
del negocio. Mover ahí sus cuatro Workers **sin cambiar el código**: el mismo
diseño de un Worker por endpoint, con sus cuatro crons. La cuenta actual queda
solo para La Fija.

```
Cuenta actual (La Fija)       Cuenta nueva (Sarco)
  3 de 5 lugares                4 de 5 lugares
```

### Cómo se migra

1. Crear la cuenta nueva y verificar el correo (paso humano).
2. En esta PC, iniciar sesión con wrangler en la cuenta nueva. Wrangler maneja
   **una sesión a la vez**: para trabajar con las dos cuentas hay que cerrar e
   iniciar sesión cada vez, o usar un API token por cuenta
   (`CLOUDFLARE_API_TOKEN` / `account_id` en cada `wrangler.jsonc`).
3. Desplegar los cuatro Workers de Sarco en la cuenta nueva, cada uno con su
   secreto, y verificar con `wrangler tail` que los cuatro responden `200`.
4. Borrar los cuatro Workers `sarco-*` de la cuenta vieja.

Durante un rato conviven los despertadores viejos y los nuevos. Es inofensivo:
los endpoints son idempotentes.

### A favor

- **Cero cambios de código.** Se respeta el diseño documentado: cada recuperación
  con su propio Worker, su propio presupuesto y sus propios logs.
- **Separación real entre clientes.** Un error en la cuenta de un restaurante no
  toca al otro. Ya pasó lo contrario: en este mismo mes, un `wrangler secret put`
  lanzado desde la copia de La Fija pisó el token de un Worker de Sarco, y hubo
  que restaurarlo a mano.
- **Se puede entregar al cliente:** la cuenta (y su facturación, si algún día la
  hay) queda a nombre del negocio, no de la persona técnica.
- Un fallo de un Worker afecta a una sola recuperación, no a las cuatro.

### En contra

- **Queda casi lleno otra vez:** 4 de 5. Cualquier despertador nuevo (por ejemplo,
  un vigilante que avise cuando algo deja de correr) ocupa el último lugar, y el
  siguiente vuelve a chocar con el límite.
- **Cada restaurante nuevo = una cuenta nueva**, con correo, verificación, 4
  despliegues y 4 secretos. Cuatro piezas por cliente que se pueden olvidar, que
  es exactamente cómo empezó este incidente.
- **Varias cuentas que administrar** desde una sola PC, con sesiones o tokens
  distintos; más fácil desplegar en la cuenta equivocada.
- Pasos humanos (crear cuenta, verificar, iniciar sesión) que no se pueden
  automatizar.
- Conviene revisar los términos de Cloudflare sobre tener varias cuentas gratis
  administradas por la misma persona. Una cuenta por negocio es un uso normal,
  pero no lo verificamos.

---

## COMPARACIÓN

| | A — Un despertador por restaurante | C — Una cuenta por restaurante |
|---|---|---|
| Costo | 0 | 0 |
| Cambios de código | Sí (Worker nuevo + pruebas + docs) | No |
| Lugares que usa Sarco | 1 de 5 | 4 de 5 (en su cuenta) |
| Restaurantes por cuenta gratis | hasta 5 | 1 |
| Piezas a desplegar por cliente | 1 Worker, 1 secreto | 4 Workers, 4 secretos, 1 cuenta |
| Si falla el despertador | Caen las 4 recuperaciones | Cae 1 |
| Aislamiento entre clientes | Misma cuenta | Total |
| Riesgo a medir | CPU de 10 ms por invocación | Quedarse sin lugar al agregar algo |
| Pasos humanos | Ninguno fuera de la PC | Crear cuenta, verificar, iniciar sesión |
| Ventana de migración | Minutos sin reintento de alertas de Sarco | Ninguna (conviven) |

---

## LO QUE TE PEDIMOS

1. **Elegí A o C y defendela**, con este equipo (una persona) y este plan de
   negocio (vender el sistema a más restaurantes).

2. **Decinos qué es lo que más nos va a doler de tu elección dentro de seis
   meses.**

3. **Sobre A:** ¿es un riesgo real el límite de 10 ms de CPU con cuatro `fetch` en
   paralelo en una sola invocación de Cron? ¿Y el punto único de fallo pesa más
   que la ventaja de desplegar una sola pieza?

4. **Sobre C:** ¿es sostenible una cuenta de Cloudflare por restaurante para una
   sola persona, o termina siendo el mismo problema (piezas olvidadas) multiplicado?

5. **El problema de fondo:** con cualquiera de las dos, un despertador puede dejar
   de correr sin que nadie se entere, como pasó durante días. ¿Cómo se detecta sin
   montar un stack de monitoreo que nadie va a mirar, y sin gastar el último lugar
   de cron en vigilar a los demás?

6. **Si ves una opción mejor** (combinar A y C, usar el cron de Supabase,
   otra plataforma gratis), decila.
