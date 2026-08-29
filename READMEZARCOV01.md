# Don Zarco · V01 — Auditoría del agente de WhatsApp

**Fecha del corte:** 29-08-2026 · **Rango auditado:** `6cf400e..abfc11e` (12 commits)
**Estado:** 3.107 tests en verde, lint y tipos limpios, build correcto, desplegado en producción.

Este documento existe para una **segunda opinión externa**. Está escrito para que
alguien que no vio el código pueda reconstruir qué decide el sistema, dónde lo
decide y con qué evidencia — incluyendo lo que **no** funciona y lo que **no**
está medido. Las secciones de límites son tan importantes como las de features:
un auditor que solo lea lo que va bien no sirve de nada.

---

## 1. El principio que ordena todo

> **Lo que se puede CONTAR se cuenta. Lo que hay que LEER lo lee el modelo.**

Casi todos los fallos de esta tanda vinieron de violar esa línea en una
dirección o en la otra. El sistema tiene dos carriles y el orden importa:

```
mensaje de WhatsApp
  → webhook (HMAC, idempotencia, persistencia del entrante)
  → CARRIL DETERMINISTA   ── si atiende, aquí termina
       menú · cotización de envío · ubicación · nfm_reply · takeover humano
  → CARRIL DEL MODELO      ── solo lo que el determinista declinó
       ronda de SELECCIÓN (elige 1 de 4 acciones) → ronda de REDACCIÓN
```

El carril determinista es **más barato, más predecible y más seguro**. Cada
mensaje que atiende es un mensaje que el modelo no puede enrutar mal. Buena
parte del trabajo de esta tanda fue mover cosas del segundo carril al primero.

**Archivos clave:** [`src/lib/webhook/kapso.ts`](src/lib/webhook/kapso.ts) (el
enrutado), [`src/lib/agent/core/run.ts`](src/lib/agent/core/run.ts) (el turno del
modelo, con sus barreras).

---

## 2. Las cuatro acciones del modelo

Ronda de selección con `toolChoice: 'required'` y `parallelToolCalls: false`: el
modelo elige **exactamente una**.

| Acción | Archivo | Efecto |
|---|---|---|
| `send_menu` | [`tools/menu-tools.ts`](src/lib/agent/tools/menu-tools.ts) | Manda el CTA y **cierra el turno en silencio** |
| `get_menu_items` | [`tools/menu-tools.ts`](src/lib/agent/tools/menu-tools.ts) | Lee el catálogo real; el modelo redacta con el dato |
| `answer_directly` | [`tools/answer-directly.ts`](src/lib/agent/tools/answer-directly.ts) | No actúa; solo redacta |
| `request_human` | [`tools/request-human.ts`](src/lib/agent/tools/request-human.ts) | Pausa 120 min, avisa a Telegram, **cierra en silencio** |

### ⚠️ El aprendizaje más caro de esta tanda

Con `required`, **el modelo siempre elige algo**. Por tanto cada exclusión
escrita en la descripción de una acción **empuja casos hacia otra**, y hay que
saber hacia cuál. Una exclusión sin salida declarada desagua en la acción más
cara del catálogo.

Caso real (29-08, 01:04): `"hola como esta zarco cuanto me saldria delivery
aqui"` — primer mensaje de la conversación, historial vacío (verificado en
`agent_messages`) — **derivó a una persona**. Razonamiento del modelo, reconstruido:

- no pedía el menú → `send_menu` no;
- el envío no es un producto → `get_menu_items` no;
- `answer_directly` decía *"no la uses para responder de memoria **un precio**"* → **se autoexcluía**;
- quedaba `request_human`.

Se intentó arreglar **dos veces por redacción** y **se midió las dos**: la
primera no cambió nada (3/3 seguía derivando), la segunda lo dejó **peor** (0/3).
La solución fue sacar el caso del modelo (§4).

---

## 3. Derivación humana — el flujo crítico

### 3.1 Qué pasa cuando se deriva

**El cliente no recibe NADA.** Antes salía un acuse ("Esto lo tiene que ver una
persona del equipo"); se quitó deliberadamente: es una promesa implícita de
atención que puede no cumplirse esa noche, y a quien se le anuncia una respuesta
que no llega se siente ignorado más que si un bot dejara de contestarle.

Lo que sí sale, siempre, es **la alerta a Telegram**. La derivación es un aviso
al equipo, no un mensaje al cliente.

Orden de efectos ([`handoff/service.ts`](src/lib/agent/handoff/service.ts)):
`0. COMPROBAR → 1. PAUSAR → 2. AVISAR`. La pausa va antes del aviso: si fallara
el aviso, el agente ya está callado.

### 3.2 La puerta (`handoff-gate.ts`) — lo más importante de auditar

Cuatro falsos positivos en dos días, **todos entre el mensaje 1 y el 3**, ninguno
con señal de queja:

| Mensaje | Nº en la conversación |
|---|---|
| `"hola"` | 1 |
| `"hola como esta zarco cuanto me saldria delivery aqui"` | 1 |
| `"cuanto sale el envio"` | 1 |
| `"Aquí cuánto cobra"` | 3 |

**Regla actual** ([`handoff/handoff-gate.ts`](src/lib/agent/handoff/handoff-gate.ts)):

```
canHandOff =
     explicitRequest                       → true  (sin contar nada)
  || customerMessages === null             → false (FAIL-CLOSED)
  || customerMessages >= 4                 en ventana de 6 h
```

- **4** es el primer número que deja fuera los cuatro fallos observados, y ni uno
  más. No sale de una intuición sobre paciencia.
- **6 h** hace que el umbral signifique *"esta conversación"* y no *"este
  cliente"*: sin ventana, un habitual tendría derecho a derivar en su primer
  "hola" de hoy.
- **Fail-closed**: si el conteo falla, no se deriva. El turno sigue vivo y el
  cliente recibe respuesta igual.

**Coste aceptado y explícito:** una queja legítima en el primer mensaje ("me
llegó frío") **ya no deriva al instante**. El agente contesta y la derivación
llega 2-3 mensajes después. Se acepta porque el daño no es simétrico: contestar
de más a quien necesitaba una persona cuesta minutos; callar dos horas a quien
preguntaba un precio cuesta el cliente.

**La excepción** ([`handoff/explicit-request.ts`](src/lib/agent/handoff/explicit-request.ts)):
exige un **verbo de contacto** Y un **sustantivo de persona** juntos. Así
`"quiero hablar con una persona"` deriva al instante y `"una persona me dijo que
tenían promo"` no. `repartidor` y `motoquero` quedan fuera a propósito: es una
petición sobre un pedido en curso, no sobre esta conversación.

### 3.3 El detector de cliente atascado (`stuck-customer.ts`)

Tres versiones, y las dos primeras estaban mal. Vale la pena auditar por qué.

| Versión | Regla | Por qué falló |
|---|---|---|
| v1 | 3 menús enviados en 45 min sin pedido | El menú es un proxy pobre: en los flujos reales salió una vez o ninguna |
| v2 | 6 mensajes del cliente en 30 min sin pedido | **Saltó en un pedido que terminó pagado.** Volumen ≠ atasco |
| **v3 (actual)** | ver abajo | — |

**Regla actual** — contar es **lo último**, detrás de dos puertas:

```
1. hasProgress  → false. Pedido creado o comprobante recibido: no está atascado
2. menusSent<1  → false. Sin la herramienta en la mano no se le puede reprochar
                         no usarla; sería avisar por cada conversación que arranca
3. messages >= 8 en 30 min → avisa
```

**8 y no 6**: un pedido completo (saludo · intento · ubicación · ubicación
corregida · comprobante) gasta 6-7 mensajes sin nada anómalo. Con 6, cien
pedidos serían cien alertas falsas, y a la tercera nadie mira el grupo.

#### 🐛 Bug de datos encontrado aquí (importante para la auditoría)

`hasProgress` **nunca podía ser true** para pedidos del menú web. La RPC del
checkout ([`0003_web_checkout.sql`](supabase/migrations/0003_web_checkout.sql),
línea ~470) inserta **`orders.source_message_id = NULL`**, y el cruce iba por ese
campo. El detector v1 tenía el mismo bug y no se notó porque casi nunca llegaba a
preguntar.

**Arreglo** ([`stuck-customer-service.ts`](src/lib/agent/handoff/stuck-customer-service.ts)):
el progreso se comprueba por **tres caminos**:
1. `menu_sessions.customer_phone` (normalizado) → `orders.menu_session_id` ← el que faltaba
2. `orders.source_message_id` por WAMID ← los pedidos que entran por el Flow sí lo llevan
3. `payment_proofs.source_message_id` ← quien mandó comprobante llegó al final

> **El dato sigue mal en origen.** No se tocó la RPC. Un auditor debería
> preguntarse si `orders.source_message_id = NULL` en el checkout web es
> intencional o una omisión, porque cualquier otro consumidor de ese campo
> arrastra el mismo error silencioso.

### 3.4 Dónde corre el detector

Antes colgaba del despacho del menú → solo veía a quien pedía el menú repetidas
veces. Ahora corre **una vez por entrega en el webhook**
([`kapso.ts`](src/lib/webhook/kapso.ts), en `runBusiness`, antes del turno), así
que ve también las conversaciones que atendió el carril determinista.

### 3.5 Motivos canónicos

[`agent/core/types.ts`](src/lib/agent/core/types.ts):
`handoff_requested` · `handoff_stuck_customer` · `payment_reviewed` ·
`human_whatsapp_business_app`

`handoff_menu_loop` es **histórico**: se conserva en las etiquetas de Telegram
([`alerts/handoff-notice.ts`](src/lib/alerts/handoff-notice.ts)) para que las
filas viejas sigan siendo legibles.

---

## 4. Cotización de envío — el carril determinista nuevo

### 4.1 El agujero original

Un cliente preguntó por el delivery, mandó su ubicación con el botón de WhatsApp
y **no recibió nada**. Causa: `parseLocationMessage` exige `context.id` (el WAMID
de nuestra petición) para correlacionar con el pedido. Un pin espontáneo no lo
trae → `invalid_shape` → el clasificador lo daba por atendido → el agente ni lo
veía. Silencio absoluto.

### 4.2 Flujo actual

```
"cuánto sale el envío"           → isDeliveryQuoteIntent → pide la ubicación (texto fijo)
pin suelto (sin context.id)      → parseStandaloneLocation → Mapbox → feeForMeters → precio
pin respondiendo a nuestra petición → camino de siempre: se adjunta al pedido
```

| Pieza | Archivo |
|---|---|
| Detector de la pregunta | [`webhook/delivery-quote-intent.ts`](src/lib/webhook/delivery-quote-intent.ts) |
| Parser del pin suelto | [`flow/location-message.ts`](src/lib/flow/location-message.ts) (`parseStandaloneLocation`) |
| Lógica pura (cupo, reuso, textos) | [`delivery/quote-request.ts`](src/lib/delivery/quote-request.ts) |
| Wiring server-only | [`delivery/quote-request-service.ts`](src/lib/delivery/quote-request-service.ts) |
| Ledger | [`0027_delivery_quote_requests.sql`](supabase/migrations/0027_delivery_quote_requests.sql) |

### 4.3 Reglas económicas

- **Cupo: 2 pines sueltos por teléfono cada 12 h.** Cada medición es una llamada
  de pago a Mapbox.
- **La cotización del checkout NO cuenta** y corre siempre: es un pedido real, y
  bloquearla sería castigar a quien preguntó antes.
- **Reuso de distancia** con tolerancia de **10 m** y ventana de 12 h: si el
  cliente confirma con el mismo pin que ya cotizó, se reutiliza la medición. El
  viaje completo pasa de 2 llamadas a 1. La tolerancia es 100× menor que el tramo
  más estrecho del tarifario (1 km), así que no puede cambiar el precio.

### 4.4 Detector de la pregunta

`COSTE && (ENVIO || DEIXIS)`. Las tres familias en
[`delivery-quote-intent.ts`](src/lib/webhook/delivery-quote-intent.ts):

- **COSTE** — `cuanto`, `precio`, `tarifa`, `vale`…
- **ENVIO** — sustantivos (`delivery`, `envio`, `domicilio`) + verbos de traslado
  **con pronombres enclíticos cosidos** (`llevarlo`, `traérmelo`), porque
  `"cuánto cobran por llevarlo"` no coincide con `llevar`. La raíz va **acotada**
  para que `mandarina` no se cuele por empezar como `mandar`.
- **DEIXIS** — `aqui`, `aca`, `a mi casa`… Añadida tras el fallo de
  `"Aquí cuánto cobra"`: hay coste pero ninguna palabra de envío.

`moto` queda **fuera** a propósito: *"¿tienen moto?"* es una pregunta sobre el
servicio, no sobre su precio.

---

## 5. Análisis de comprobantes con IA — el flujo completo

```
cliente manda foto
  → captura (R2 + payment_proofs)
  → PUERTA DE VISIÓN: los bytes NO llegan al agente si es un comprobante
  → análisis (modelo con visión) → judgeProof vs la cuenta configurada
  → analysis_verdict + analysis_reasons en la fila
  → KDS: aviso ROJO sobre los botones del ticket
  → decide una PERSONA (Confirmar / Rechazar)
```

**El modelo nunca decide un pago.** Solo produce un veredicto que un humano lee.

| Pieza | Archivo |
|---|---|
| Juicio puro (contraste con la cuenta) | [`payment-proof/analysis.ts`](src/lib/payment-proof/analysis.ts) |
| Lectura con visión | [`payment-proof/analysis-vision.ts`](src/lib/payment-proof/analysis-vision.ts) |
| Orquestación | [`payment-proof/analysis-service.ts`](src/lib/payment-proof/analysis-service.ts) |
| Textos para el humano | [`payment-proof/labels.ts`](src/lib/payment-proof/labels.ts) |
| Aviso en el ticket | [`kitchen/proof-alert.ts`](src/lib/kitchen/proof-alert.ts) |
| Consulta del KDS | [`kitchen/data-source.ts`](src/lib/kitchen/data-source.ts) |

### 5.1 Verificado en producción (29-08 08:53)

Comprobante real de otra persona pagando a un tercero:

```
analysis_status = done
analysis_verdict = suspicious
analysis_reasons = ["account_mismatch","holder_mismatch","bank_mismatch","stale_receipt"]
```

Cuatro señales independientes. **Basta una** para marcarlo.

### 5.2 🐛 Segundo bug de consulta (mismo patrón que §3.3)

El veredicto estaba en la base, la función del aviso estaba escrita, y **en el
ticket no aparecía nada**: `KITCHEN_PROOF_COLUMNS` pedía `analysis_status` pero
**no** `analysis_verdict` ni `analysis_reasons`. `toAnalysisView` encontraba el
`'done'`, se quedaba sin veredicto y devolvía `null`.

El panel del encargado sí pedía las tres columnas — por eso el fallo era
invisible desde ahí, y solo se manifestaba en la única pantalla donde alguien
decide.

**Patrón a auditar:** dos bugs de esta tanda (§3.3 y §5.2) son *"la lógica está
bien, el dato no llega"*. Ninguna prueba de comportamiento los caza. El test que
se añadió ([`kitchen/proof-alert.test.ts`](src/lib/kitchen/proof-alert.test.ts))
no prueba lógica: **extrae la lista de columnas y la contrasta con lo que la
vista lee**.

### 5.3 Criterio de redacción de los motivos

Cada motivo nombra un **hecho comprobable**, no una categoría:

> *"La cuenta que recibe el dinero NO es la nuestra"* — se verifica abriendo el comprobante.
> *"Comprobante sospechoso"* — no se verifica de ninguna manera, y una alerta que no se puede comprobar acaba pulsándose igual.

El aviso **se retira** cuando el pago ya se decidió: un cartel que no pide
ninguna acción enseña a ignorar los carteles.

---

## 6. Otros cambios de esta tanda

### 6.1 Marcadores de silencio en el contexto de decisión

[`agent/core/context.ts`](src/lib/agent/core/context.ts) · `SESSION_GAP_MINUTES = 45`

La ronda de decisión veía 12 mensajes de 24 h **sin ninguna noción del tiempo
entre ellos**: un "hola" nuevo se leía como continuación de la conversación
trabada de ayer. Ahora se inserta una línea de hecho —*"Evento del canal: pasaron
4 horas sin mensajes."*— que es un **hecho, no una instrucción**.

Los marcadores se insertan **después del recorte** y por eso no gastan cupo:
`max` cuenta mensajes, y un silencio no es un mensaje.

### 6.2 Un comprobante retenido no es un turno

[`agent/core/run.ts`](src/lib/agent/core/run.ts) · `isAgentEligibleContent`

La puerta de visión retira los bytes y **deja el mensaje**. Con eso el turno se
quedaba sin foto y sin texto, y el modelo decidía **sobre el historial solo**: en
producción le mandó el menú a un cliente que acababa de pagar.

Ahora se exige que el **lote** aporte algo (texto o imagen con adjunto). Se mira
el lote y no solo el ancla: si llega `[texto, comprobante retenido]`, el texto
sigue contestándose.

### 6.3 El CTA contesta lo que preguntaron

[`menu/cta-context.ts`](src/lib/menu/cta-context.ts) (nuevo)

El cuerpo del botón es el **único** mensaje que sale cuando se manda el menú (el
turno cierra en silencio), y decía siempre lo mismo. Ahora varía por contexto
detectado sin modelo: `price` · `delivery` · `dictated`.

> **Decisión de diseño:** el contexto va **separado del `reason`** y **no se
> persiste**. El `reason` responde *con qué autoridad se manda el menú* y vive en
> el ledger con su CHECK; el contexto responde *de qué venía hablando* y solo
> elige palabras. Mezclarlos habría obligado a una migración para afinar una
> frase.

El texto sigue siendo **fijo y escrito en el código**: es el mismo mensaje que en
agosto llegó a afirmar envíos que no ocurrieron. Se afina *cuál* frase sale, no
*quién* la escribe.

### 6.4 Detector de menú: saludos encadenados

[`webhook/menu-intent.ts`](src/lib/webhook/menu-intent.ts)

Retiraba **un** saludo y paraba, así que `"Hola Zarco cómo va quiero pedir"` no
se reconocía. Ahora encadena hasta 4 e incluye el vocativo del negocio. Y aprendió
el **imperfecto de cortesía**: `"quería pedir"` es más frecuente que `"quiero
pedir"` en Bolivia y se quedaba fuera por un acento y dos letras.

### 6.5 Aviso de pago según tipo de entrega

[`payment-proof/notify-text.ts`](src/lib/payment-proof/notify-text.ts)

| Tipo | Mensaje |
|---|---|
| delivery | Pago confirmado ✅ … El delivery tiene tu número y te llamará cuando llegue con tu pedido. |
| pickup | Pago confirmado ✅ … Te esperamos con el chat en mano cuando vengas a recogerlo. |
| *(desconocido)* | Pago confirmado ✅. Tu pedido está siendo preparado. |

Sin tipo **no se rellena**: antes que arriesgar decirle que espere en la puerta a
quien iba a pasar a buscarlo, se dice solo lo que es cierto.

---

## 7. Qué está MEDIDO y con qué números

Dos evals contra el **modelo real**, fuera de `npm test` (llaman a OpenAI y
cuestan dinero).

### `npm run eval:selection` — qué acción elige

37 casos × 3 repeticiones. **Modelo: `gpt-4o-mini`** (el de producción, importado
de `OPENAI_DEFAULT_MODEL`, no un literal copiado).

| Categoría | Resultado |
|---|---|
| broad (mandar el menú) | 30/30 |
| factual (consultar el catálogo) | 15/15 |
| referencia | 9/9 |
| contaminado | 3/3 |
| **derivacion** | **12/12** |
| **no-derivacion** (hard gate) | **15/15** |
| general | 12/15 ← `general-05` falla desde antes de esta tanda |

**HARD GATE 69/69.**

### `npm run eval:grounded` — qué DICE (nuevo en esta tanda)

14 casos × 3. Automatiza los casos que `docs/agent-eval-grounded.md` tenía
escritos **para pasarse a mano desde hacía meses**, y que por eso no pasaba nadie.

| Categoría | Resultado |
|---|---|
| **alergenos (hard gate)** | **12/12** |
| recomendacion | 9/9 |
| inventar | 9/9 |
| grounding | 6/6 |
| memoria | 3/6 ← ver §8 |

Se puntúa con **reglas deterministas, no con un modelo juez**: un juez sería más
matizado y también irreproducible, y entonces dos corridas del mismo código
darían números distintos sin saber si mejoró el agente o cambió de humor el juez.
El precio es que una regex no entiende español; por eso los patrones prohibidos
son pocos y muy específicos, y el peso recae en exigir la salvedad.

### 🐛 El eval estaba roto y parecía funcionar

Dos bugs, ambos arreglados:

1. `OPENAI_MODEL=` **vacío** en `.env.local` → `??` no cubre la cadena vacía →
   pedía un modelo sin nombre → **las 111 llamadas fallaban**. El único síntoma
   era un `modelo=` en blanco en la cabecera del informe.
2. Su modelo por defecto era `gpt-4.1-mini` mientras producción corre
   `gpt-4o-mini`. **Decía medir Production y medía otra cosa.**

> Un eval en el que nadie mira la cabecera del informe es peor que no tener eval.

---

## 8. Límites conocidos y deuda abierta

Esta sección es la más útil para una segunda opinión.

### Abierto y verificado

| # | Qué | Dónde |
|---|---|---|
| 1 | `combo-inventado` **0/3**: el agente ofrece *"te mando el menú"* en turnos donde ninguna acción lo manda. El cliente espera un botón que no llega | `evals/grounded-answer.eval.ts` |
| 2 | `general-05` **0/3** (report-only): elige `send_menu` donde se esperaba `answer_directly`. Falla desde antes de esta tanda | `evals/action-selection.eval.ts` |
| 3 | `markAnalysisFailed` **no guarda el motivo**: diagnosticar un análisis fallido depende de logs de Vercel con retención limitada | [`analysis-data-source.ts`](src/lib/payment-proof/analysis-data-source.ts) |
| 4 | `orders.source_message_id = NULL` en el checkout web. Se rodeó, no se arregló en origen | [`0003_web_checkout.sql`](supabase/migrations/0003_web_checkout.sql) |
| 5 | `wouldAnalyze` se calcula y **no lo expone ningún endpoint**: existe un diagnóstico escrito para "¿por qué no veo alertas?" que no es consultable | [`menu/config.ts`](src/lib/menu/config.ts) |

### Compromisos aceptados (no son bugs, son decisiones)

| Qué se pierde | A cambio de |
|---|---|
| Una queja en el primer mensaje ya no deriva al instante | Que preguntar un precio no cueste 2 h de silencio |
| Un cliente que escribe mucho **sin haber recibido nunca el menú** no dispara alerta de atasco | No gritar en cada venta |
| Los links cortos `maps.app.goo.gl` no se resuelven (no traen coordenadas) | No meter una dependencia de Google en el webhook |
| Un comprobante **con caption** se contesta sin ver la foto | El texto del cliente nunca se ignora |
| El CTA no responde a la pregunta exacta, solo a su tipo | Cero tokens y cero riesgo de que el modelo redacte ese mensaje |

### Riesgo estructural que queda vivo

`request_human` **sigue pudiendo dispararse por juicio del modelo a partir del
mensaje 4**. La puerta acota el daño, no lo elimina. Si aparece un quinto falso
positivo será ahí, y el arreglo ya no será un umbral: habrá que mover ese caso
también al carril determinista, como se hizo con la pregunta del envío.

### Lo que NO cubre ningún eval

Los evals miden **turnos aislados del modelo**. Nadie mide automáticamente:
- el flujo de cotización punta a punta (pin → Mapbox → precio → pedido);
- la pausa por derivación y su vencimiento;
- el reuso de distancia;
- los caminos deterministas (menú, ubicación, comprobantes);
- conversaciones de varios turnos.

**Todo eso sigue siendo prueba manual en WhatsApp.** Un eval verde no significa
que el sistema funcione; significa que los errores que ya conocemos no volvieron.

---

## 9. Configuración que decide comportamiento

| Variable | Efecto si falta |
|---|---|
| `AI_ENABLED`, `AI_ACCESS_MODE` | El agente no corre |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Sin modelo. **Vacío ≠ ausente**: ver §7 |
| `PAYMENT_PROOF_CAPTURE_ENABLED` | No se capturan comprobantes |
| `PAYMENT_PROOF_ANALYSIS_ENABLED` | Se capturan pero **no se analizan** (quedan `pending`) |
| `PAYMENT_PROOF_ACCOUNT_*` | Sin patrón contra el que contrastar → no se analiza |
| `PAYMENT_PROOF_ANALYSIS_MODEL` | Por defecto `gpt-5-mini` (≠ el del agente) |
| `R2_*` | Sin almacenamiento → no se analiza |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_HANDOFF_CHAT_ID` | **Sin alerta de derivación.** Cae a `TELEGRAM_CHAT_ID` |
| `MAPBOX_ACCESS_TOKEN`, `RESTAURANT_LAT/LNG` | No se cotiza ningún envío |

**Diagnóstico útil:** `analysis_status = 'pending'` significa *"no se intentó"*
(falta configuración); `'failed'` significa *"se intentó y falló"* (el problema
está en la llamada al modelo, no en las variables).

---

## 10. Cómo verificar

```bash
npm test                    # 3.107, deterministas, sin red
npm run lint
npx tsc --noEmit            # 1 error preexistente en orders-repository.test.ts
npx next build
npm run eval:selection      # ⚠ tokens reales
npm run eval:grounded       # ⚠ tokens reales
```

> Los evals imprimen su informe solo con `--disable-console-intercept`.
> **Mirar siempre la cabecera**: si `modelo=` sale vacío, el informe no vale nada.

### Reset entre pruebas manuales

Dos bloques, en este orden — `orders.menu_session_id` es `ON DELETE RESTRICT`, así
que borrar la sesión antes que el pedido falla:

```sql
-- 1) comprobantes y pedidos
with
  c(phone) as (values ('59175681881')),
  del_proof as (
    delete from payment_proofs where source_message_id in (
      select m.provider_message_id from agent_messages m
      join agent_conversations ac on ac.id = m.agent_conversation_id
      where ac.customer_phone = (select phone from c) and m.provider_message_id is not null
    ) returning 1),
  del_ord as (
    delete from orders
    where regexp_replace(customer_phone, '\D', '', 'g') = (select phone from c) returning 1)
select (select count(*) from del_proof) as comprobantes,
       (select count(*) from del_ord)   as pedidos;

-- 2) la conversación y todo lo del agente (cascada incluida)
with
  c(phone) as (values ('59175681881')),
  del_conv as (delete from agent_conversations     where customer_phone = (select phone from c) returning 1),
  del_menu as (delete from menu_send_deliveries    where customer_phone = (select phone from c) returning 1),
  del_sess as (delete from menu_sessions           where customer_phone = (select phone from c) returning 1),
  del_quot as (delete from delivery_quote_requests where customer_phone = (select phone from c) returning 1)
select (select count(*) from del_conv) as conversacion,
       (select count(*) from del_menu) as menus,
       (select count(*) from del_sess) as sesiones,
       (select count(*) from del_quot) as cotizaciones;
```

### Los cuatro flujos que hay que probar a mano

1. `Hola Zarco cómo va quiero pedir` → llega el menú. Luego `Aquí cuánto cobra` →
   pide la ubicación. **Sin alerta de Telegram en ningún punto.**
2. `quiero hablar con una persona` como primer mensaje → deriva al instante.
3. Comprobante que no cuadra → **aviso rojo en el ticket**, antes de decidir el pago.
4. 8 mensajes en 30 min, con menú enviado y sin pedido → alerta silenciosa de atasco.

---

## 11. Los 12 commits

| Hash | Qué resuelve |
|---|---|
| `7a0eda8` | La derivación calla en vez de anunciarse; el atasco deja de ser juicio del modelo |
| `2f04e2f` | Se contesta al que manda su ubicación (cotización sin pedido) |
| `fb9c012` | Estado real de las migraciones, verificado contra la base |
| `7225c5b` | La pregunta por el envío no tenía ninguna acción disponible |
| `f8d79df` | Esa pregunta sale del modelo y pasa al carril determinista |
| `cb218be` | Segundo eval: qué DICE el agente |
| `075bdf5` | Puerta de 4 mensajes; el atasco se cuenta por mensajes |
| `de82234` | Un pedido pagado no es un cliente atascado (bug del cruce) |
| `5617b27` | Un comprobante retenido no es un turno (devolvía el menú) |
| `90932fd` | El CTA contesta lo que preguntaron |
| `ab680c2` | Aviso de pago por tipo de entrega; menos ruido en el ticket |
| `abfc11e` | El aviso del comprobante falso no llegaba: faltaban columnas |

---

## 12. Preguntas sugeridas para la auditoría

1. **§3.2** — ¿Es 4 el número correcto, o el umbral debería depender de la señal
   del mensaje y no de su posición?
2. **§3.3 / §5.2** — Dos bugs del tipo *"el dato no llega"*. ¿Hay más consultas
   que omitan columnas que su vista sí lee?
3. **§8, riesgo vivo** — ¿Debería `request_human` desaparecer del catálogo y ser
   siempre determinista?
4. **§7** — ¿Es sostenible puntuar con regex, o llega el momento de un juez LLM
   con semilla fija?
5. **§8, límite 4** — ¿Arreglar `orders.source_message_id` en origen, o el
   rodeo por `menu_sessions` es suficiente?
6. **§5** — El análisis nunca bloquea un pago: solo avisa. ¿Es el equilibrio
   correcto para un negocio que cobra por QR antes de cocinar?
