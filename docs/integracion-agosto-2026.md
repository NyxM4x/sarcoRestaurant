# Don Zarco — Qué cambió mientras tanto

> **Para Yoan.** Trabajamos en paralelo sin saberlo: tu `fix: harden payment
> proof privacy and recovery cron` entró a `main` mientras la rama `auxiliar`
> tenía 3.500 líneas sin subir. Ya está todo integrado y en verde, pero hay un
> cruce entre tu puerta de comprobantes y un analizador nuevo que conviene que
> mires, y una decisión que deberíais tomar juntos.

## Por qué existe este documento

Adalid encargó por separado dos cosas que sonaban a lo mismo y no lo eran:

- A ti: **un filtro de comprobantes**.
- En esta rama: **detectar comprobantes photoshopeados**.

Tú resolviste *«¿esto es un comprobante?»* sin IA y, de paso, cerraste un
agujero real por el que la imagen se iba a OpenAI. Aquí se resolvió *«este
comprobante, ¿es auténtico?»*, que **no se puede responder sin mirar la
imagen**. Son preguntas distintas y ninguna reemplaza a la otra — pero ambas
tocan los mismos bytes, y por eso hace falta esta nota.

---

## 1. Qué había en `auxiliar` que tú no viste

Dos commits, y el segundo es grande.

### `db3c9a5` — Una campana para el ticket que nadie estaba mirando

Sonido en el KDS cuando entra un pedido nuevo. La detección es aritmética de
conjuntos sobre lo que ya trae el polling (`src/lib/kitchen/arrivals.ts`), sin
endpoint ni evento del servidor. Solo suena por un ticket en etapa `new` que no
estaba en el ciclo anterior.

### `9c089d9` — «guardando cambios» (54 archivos)

Un commit sin mensaje que en realidad son cinco trabajos:

| Qué | Dónde | Por qué |
|---|---|---|
| **El total del KDS espera al pago** | `src/lib/kitchen/summary.ts`, `ticket-view.ts` | El planchero cocinaba contra un total que incluía pedidos con el pago sin confirmar. Ahora solo suman los confirmados — salvo los ya iniciados, que cuentan igual porque están en la plancha |
| **Análisis del comprobante** | `src/lib/payment-proof/analysis*.ts`, migración `0025` | Lee la imagen con visión y contrasta el destino del dinero —cuenta, titular y banco— más el nº de transacción. El monto se lee y se muestra, pero no acusa: no se sabe de antemano cuánto transfiere alguien por WhatsApp. **Es lo que se cruza con tu puerta** |
| **Jornada de servicio** | `src/lib/orders/business-day.ts` | Ver §4: arreglaba un bug diario |
| **Numeración diaria** | `src/lib/orders/order-number.ts`, migración `0026` | El dueño pidió que los pedidos empiecen en 1 cada noche. Se guarda `ORD-260828-007`, se muestra `#7` |
| **Horario y menú** | `facts.ts`, `menu-intent.ts`, `api/internal/menu/config-check` | El horario decía 21:00 en cuatro sitios y el local abre a las 18:00 — incluido el mensaje que recibe cada cliente nuevo |

---

## 2. Cómo se integró tu trabajo (`4f863e3`)

Un solo conflicto, en `src/lib/payment-proof/intake-service.ts`, y de líneas
contiguas: tu `proofClassification` en el `return`, y la llamada al analizador
justo antes. **Se conservaron los dos.**

Tu `agent-gate.ts`, el recovery cron y `payment-proof-retention.md` quedaron
intactos. También tu doctrina: la autorización positiva, el fail-closed y el
razonamiento de por qué la clasificación no puede preguntarle al modelo.

---

## 3. El cruce que tienes que mirar

Tu documento dice, y con razón:

> «Para preguntarlo hay que mandarle la imagen, y mandársela es el daño que se
> quería evitar. Lo mismo vale para un OCR de terceros o cualquier clasificador
> remoto.»

Eso es cierto **para tu pregunta**. Para la de autenticidad no hay alternativa:
no se puede ver que una cuenta destino está retocada sin leer la cuenta destino.

**Resultado: hoy hay dos caminos hacia OpenAI, y son independientes.**

| | Tu puerta | El analizador |
|---|---|---|
| Qué decide | Si los bytes entran al **turno del agente** | Si se leen **a propósito** para detectar fraude |
| Cuándo sale la imagen | Nunca (esa es la función) | Solo con `PAYMENT_PROOF_ANALYSIS_ENABLED=true` |
| Estado hoy | Integrada | **Apagado**, y sin cuenta configurada |

Está documentado en `intake-service.ts:294-310`, en el punto exacto donde se
cruzan: *apagar una no apaga la otra*. Quien quiera que ninguna imagen salga del
perímetro tiene que dejar esa variable sin poner.

**Dato que no esperábamos**: tu puerta además *ahorra*. Con el agente encendido y
sin ella, cada comprobante se iba al turno con `gpt-4o-mini` —~48.000 tokens de
imagen, ~$0,0072— sin que nadie ganara nada. El analizador cuesta ~$0,001 con
`gpt-5-mini`. Las dos encendidas salen **más baratas** que el estado anterior.

**Lo que hay que decidir juntos**: si se acepta ese segundo camino. Si no, la
única alternativa real es OCR local — recortar o tapar antes de mandarla no
sirve, porque lo que hay que leer *es* el dato sensible.

---

## 4. Un bug que apareció por el camino

`dateBounds('today')` cortaba por **medianoche UTC = 20:00 en Bolivia**. Con
apertura a las 18:00, eso significa que **cada noche, a las 20:00 en punto, el
KDS borraba las comandas de las dos primeras horas del servicio** — pedidos
vivos, con la comida sin salir.

Lo arregla `src/lib/orders/business-day.ts`: la jornada va de mediodía a
mediodía, así que el servicio entero (18:00→04:00) cae dentro. Lo usan el KDS y
los filtros del panel.

---

## 5. Lo que se hizo después del merge

| Commit | Qué |
|---|---|
| `a972738` | **Modelo por turno.** `gpt-4o-mini` es el más barato en texto y el más caro en imagen (multiplicador ~33×). Ahora el turno con foto usa `AI_VISION_MODEL` |
| `c21c2da` | **El CTA habla según el motivo** + **el agente calla tras decidir un comprobante** |
| `1379ac8` | **`request_human`**: cuarta acción del agente |
| `b5497f2` | **Prompt**: encuadre del cambio, flujo de Recojo, frustración |
| `d162cc7` | **Detector de cliente atascado**, sin tokens |
| (esta entrega) | **La derivación calla en vez de anunciarse**, y deja de dispararse con un saludo |

### Lo que más te puede afectar

**Una cuarta acción en el catálogo del agente.** `request_human` se suma a
`send_menu` / `get_menu_items` / `answer_directly`. Sigue tu contrato:
`NO_ARGUMENTS`, y `producesUserVisibleEffect: true` + `effectCompletesTurn: true`
— pausa, avisa al equipo y cierra el turno **sin enviarle nada al cliente**.

> El efecto que declara no es un mensaje: es SILENCIAR al agente. Por eso sigue
> necesitando la barrera 2A —para no derivar una conversación que ya atiende una
> persona— y sigue cerrando el turno: si siguiera a redactar, la barrera
> pre-send encontraría la pausa recién puesta y el run moriría en
> `skipped_paused` habiendo pagado una llamada más al modelo.

**La primera pausa que pone el sistema y no una persona.**
`src/lib/agent/control/handoff-pause.ts` es el llamador que le faltaba a
`pauseConversation`. Con vencimiento, no indefinida: hoy el panel no tiene
pantalla para reanudar, y una pausa que nadie levante deja al cliente sin agente
para siempre. `resolveExpiredPause` la limpia sola.

Tres motivos canónicos nuevos en `core/types.ts`: `handoff_requested`,
`handoff_menu_loop`, `payment_reviewed`.

**Se engancha en `decide-attempt.ts`** con el mismo molde que tu
`notifyDeliveryGroup`: dependencia opcional, best-effort, que nunca altera la
decisión.

---

## 5b. La derivación, corregida tras la primera prueba real

Se probó en WhatsApp y falló en dos sitios distintos, los dos arreglados aquí.

**1 · Le anunciaba la derivación al cliente.** `request_human` enviaba «Esto lo
tiene que ver una persona del equipo 🙌» y acto seguido enmudecía dos horas. Ese
acuse es una promesa de atención que puede no cumplirse esa noche. Ahora derivar
es exactamente lo que ya hacía el detector de menús: **pausar y avisar a
Telegram, sin decirle nada al cliente**. Fuera `HANDOFF_ACK_TEXT`, fuera el
import de Kapso y fuera `phoneNumberId` del puerto.

**2 · Se disparaba con un «hola».** Dos causas, y las dos hacían falta:

- La descripción de la herramienta pedía juzgar al «cliente que lleva varios
  mensajes trabado sin poder pedir». Ese juicio se le quitó: el atasco se
  **cuenta** en `handoff/menu-loop.ts` (tres menús en 45 min sin pedido) y el
  modelo se queda solo con lo que hay que **leer** — queja, enojo, pedir a una
  persona. La viñeta del prompt que decía «Necesita a una persona» se sustituyó
  en el mismo sentido.
- La ronda de decisión veía doce mensajes de 24 h **sin saber cuánto tiempo pasó
  entre ellos**, así que un saludo nuevo se leía como la continuación del atasco
  de ayer. `buildSelectionContext` inserta ahora una línea de hecho —«Evento del
  canal: pasaron 4 horas sin mensajes.»— a partir de `SESSION_GAP_MINUTES = 45`,
  los mismos 45 del detector de menús porque contestan la misma pregunta. Los
  marcadores se insertan DESPUÉS del recorte y por eso no gastan cupo: `max`
  cuenta mensajes. El contexto de redacción no los lleva.

El eval pasa a cablear las **cuatro** acciones —antes medía un catálogo que ya no
existía— y gana dos categorías: `derivacion` y `no-derivacion`. Esta última es
hard gate y su criterio no es «acertó la acción» sino «no eligió
`request_human`»: si ante «otra vez yo» manda el menú, el cliente sigue
atendido; derivar de más lo deja dos horas sin nadie.

---

## 5c. Cotizar el envío antes de que exista un pedido (0027)

**El agujero**, encontrado probando el 29-08-2026: un cliente preguntó por el
delivery, mandó su ubicación con el botón normal de WhatsApp y **no recibió
nada**. No era una pausa —`agent_conversations` decía `active`—, era el diseño:

- `parseLocationMessage` exige `context.id` para poder correlacionar con
  `orders.location_request_message_id`. Un pin que no responde a nuestra
  petición no lo trae, así que salía `invalid_shape`.
- El clasificador del webhook da por atendido todo lo que no declina
  explícitamente, así que el mensaje **nunca llegaba al agente**.

Nadie contestaba, y nadie tenía previsto contestar.

**Lo que se añade.** Un pin suelto ahora se cotiza y se responde, por el camino
determinista. No pasa por el modelo porque no hay nada que interpretar: la
tarifa es `feeForMeters` (una tabla de metros a bolivianos) y la distancia la
mide Mapbox. Se atiende también el pin que responde a un botón viejo cuyo pedido
ya no existe (`attach → not_found`). Lo que **no** cambia es el camino de
siempre: mientras haya pedido detrás, el GPS se adjunta como hasta ahora.

**El cupo: 2 pines sueltos por teléfono cada 12 h.** Cada medición es una llamada
de pago. La cotización del **checkout no cuenta nunca** y corre siempre: es la de
un pedido real, y bloquearla sería castigar al cliente por haber preguntado
antes. Así, el viaje completo —pregunta, se anima, arma el pedido— gasta **una**
unidad de cupo, no dos.

**Y una llamada en vez de dos.** Si el cliente confirma su pedido con el mismo
pin que ya cotizó, `quoteDynamicOrder` reutiliza la distancia guardada en vez de
volver a preguntar. La tolerancia es de 10 m —el temblor del GPS al reenviar
"ubicación actual" desde el mismo sitio—, muy por debajo del tramo más estrecho
del tarifario, que mide un kilómetro. El puerto es opcional y best-effort: si
falla, se mide.

Ningún desenlace es mudo. Cotizado, fuera de cobertura, cupo agotado y Mapbox
caído tienen cada uno su texto — reproducir el silencio en las ramas de error
sería absurdo en un flujo que existe para eliminarlo.

Archivos: `supabase/migrations/0027_delivery_quote_requests.sql`,
`src/lib/delivery/quote-request.ts` (puro), `quote-request-service.ts` (wiring),
`parseStandaloneLocation` en `src/lib/flow/location-message.ts`, y el enganche en
`src/lib/webhook/kapso.ts`.

---

## 5d. "¿Cuánto sale el envío?" no es una decisión del modelo

Probando la cotización del 5c apareció el fallo peor de todos: **"hola como esta
zarco cuanto me saldria delivery aqui" derivó la conversación a una persona en su
PRIMER mensaje.** Sin queja, sin enojo y con el historial vacío — comprobado en
`agent_messages`: esa frase es la primera fila.

El modelo no se equivocó por capricho. Eligió la única casilla libre: no pedía el
menú, el envío no es un producto que `get_menu_items` pueda buscar, y
`answer_directly` se autoexcluía con *"no la uses para responder de memoria un
precio"*. Quedaba `request_human`.

**Se intentó arreglar con palabras. Dos veces. Las dos se midieron:**

| Ronda | Qué se cambió | Resultado medido |
|---|---|---|
| 1 | `answer_directly` abre la puerta al envío; `request_human` lo prohíbe | derivó **3/3** |
| 2 | fuera del prompt "eso tendría que confirmártelo una persona"; el delivery se describe como capacidad | **peor**: 0/3 en los cuatro casos |

La conclusión no es "afinar la redacción". Es que con `toolChoice: 'required'` el
modelo elige SIEMPRE algo, y "no tengo este dato" se parece más a "esto lo ve una
persona" que a "contesto yo". Ninguna palabra cambia eso.

**Lo que sí lo cambia:** la respuesta a esa pregunta es siempre la misma —pedir la
ubicación—, y una respuesta fija no necesita un modelo que la elija.
`webhook/delivery-quote-intent.ts` la reconoce con el mismo rigor que
`isMenuIntent`: exige una palabra de COSTE **y** una de ENVÍO juntas, así que
"cuánto cuesta el trancapecho" (coste sin envío) y "hacen delivery?" (envío sin
coste) no la activan. Va después del detector de menú, de modo que no cambia
ningún enrutado existente: solo recoge lo que hoy cae en el modelo.

**La regla general, que vale más que este caso:** cada exclusión escrita en la
descripción de una acción empuja casos hacia otra, y hay que saber hacia cuál.
Una exclusión sin salida declarada acaba desaguando en la acción más cara del
catálogo — aquí, dos horas de silencio.

### El eval, que es lo que permitió saber todo esto

Tenía dos bugs que lo hacían inútil, los dos arreglados:

- `OPENAI_MODEL=` vacío en `.env.local` → `??` no cubre la cadena vacía → pedía
  un modelo sin nombre y **las 111 llamadas fallaban**. El único síntoma era un
  `modelo=` en blanco en la cabecera del informe.
- Su modelo por defecto era `gpt-4.1-mini` mientras producción corre
  `gpt-4o-mini`. Decía medir Production y medía otra cosa. Ahora importa
  `OPENAI_DEFAULT_MODEL` del adaptador en vez de copiar el literal.

Además el informe distingue ya el status HTTP (`model.http_429` en vez de
`model.http_error`) y la concurrencia bajó a 2: con 4 salían entre 5 y 9 respuestas
429 por tirada que ensuciaban la lectura sin falsear el resultado.

**Estado medido el 29-08-2026 con `gpt-4o-mini`:** hard gate 69/69. `broad` 30/30,
`factual` 15/15, `no-derivacion` 15/15, `contaminado` 3/3. El único fallo
semántico que queda es `general-05` (report-only), que fallaba idéntico antes de
tocar nada.

---

## 5e. Que derivar cueste más que contestar

Cuarto falso positivo en dos días, y el que dejó ver el patrón entero. Tres
flujos de prueba a las 02:39:

```
Hola Zarco cómo va quiero pedir   ← el detector de MENÚ no lo reconocía
<link de Google Maps>
Aquí cuánto cobra                 ← el detector de ENVÍO no lo reconocía
                                  → el modelo deriva. Dos horas de silencio.
```

Los cuatro fallos comparten forma: una pregunta que el agente debía contestar,
entre el mensaje 1 y el 3, sin una sola señal de queja. Y el detector de atasco
no habría cazado ninguno: contaba **menús enviados**, y en estos flujos el menú
salió una vez o ninguna.

**Tres cambios, y ninguno es una instrucción al modelo** — ya se intentó dos
veces por redacción y se midió que no funciona:

1. **Una puerta antes de derivar** (`handoff/handoff-gate.ts`). El modelo no
   puede derivar hasta que la conversación lleve **4 mensajes del cliente** en
   6 h. Cuatro es el primer número que deja fuera los cuatro fallos observados,
   y no uno más. Fail-closed: si no se puede contar, no se deriva. La mecánica
   de rechazo ya existía — `handed: false` deja el turno vivo y el cliente
   recibe respuesta normal.

   **Excepción**: quien pide una persona con todas las letras cruza sin contar
   nada (`handoff/explicit-request.ts`, verbo de contacto + sustantivo de
   persona, mismo rigor que los otros detectores). No tiene que ganarse el
   derecho intercambiando tres mensajes con un bot que ya le dijo que no.

2. **El atasco se cuenta por mensajes** (`handoff/stuck-customer.ts`, antes
   `menu-loop.ts`). 6 mensajes del cliente en 30 min sin pedido creado. El menú
   era un proxy del esfuerzo del cliente y uno pobre: alguien puede pelearse
   veinte mensajes sin volver a pedirlo. Contar mensajes SUBSUME el caso viejo,
   así que no se pierde cobertura. Y corre ahora **una vez por entrega en el
   webhook**, no colgado del despacho del menú, de modo que ve también a los
   clientes que atendió el pipeline determinista.

   El motivo pasa a `handoff_stuck_customer`; `handoff_menu_loop` se conserva en
   las etiquetas de Telegram para que las filas viejas sigan siendo legibles.

3. **Dos huecos de detección**, que es el arreglo más barato de todos: cada
   mensaje que contesta un camino determinista es un mensaje que el modelo no
   puede derivar por error.
   - `isMenuIntent` retiraba **un** saludo y paraba. Ahora encadena hasta cuatro
     y conoce el vocativo del negocio (`zarco`, `don zarco`, `como va`). Y
     aprendió el **imperfecto de cortesía**: "quería pedir" es más frecuente que
     "quiero pedir" en Bolivia y se quedaba fuera por un acento y dos letras.
   - `isDeliveryQuoteIntent` gana la familia **DEIXIS**: `COSTE && (ENVIO ||
     DEIXIS)`. "Aquí cuánto cobra" solo puede ser el envío; "cuánto cuesta el
     trancapecho" no lleva deixis y sigue sin activarlo.

Las seis frases literales de los tres flujos son tests ahora. Verificado tras el
cambio: los cuatro mensajes que fallaban se resuelven por el camino determinista,
sin llegar al modelo.

**Evals tras el cambio** — sin regresión: selección hard gate 69/69 (`derivacion`
12/12, `no-derivacion` 15/15), redacción hard gate 12/12.

---

## 5f. Volumen no es atasco: la alerta que saltó en un pedido pagado

El detector de 5e disparó sobre este flujo, que terminó **cobrado**:

```
Hola don Zarco quiero pedir · 2 lomitos quería · Si envíeme 2 lomitos
→ pedido #1 creado · ubicación · ubicación corregida · comprobante
→ 🙋 "No consigue hacer su pedido"
```

**Un bug de verdad, y viejo.** La RPC del checkout web
(`0003_web_checkout.sql`) inserta `orders.source_message_id` en **NULL**, y el
detector cruzaba justamente por ese campo para preguntar "¿pidió algo?". Ningún
pedido hecho desde el menú contaba jamás como progreso. El detector anterior
tenía el mismo cruce y no se notó porque exigía tres menús enviados; al bajar el
listón a mensajes, el fallo latente salió a la luz.

El cruce bueno es `menu_sessions`, cuyo `customer_phone` sí está normalizado y al
que el pedido apunta por `menu_session_id`. Se conservan además el cruce por
WAMID (los pedidos que entran por el Flow sí lo llevan) y se añade el
**comprobante de pago**: quien mandó uno llegó hasta el final.

**Y un error de diseño.** Aunque el cruce hubiera funcionado, contar mensajes a
secas es medir volumen, no atasco: un pedido normal —saludo, intento, ubicación,
comprobante— gasta seis o siete mensajes sin nada anómalo. Cien pedidos, cien
alertas falsas, y a la tercera nadie mira el grupo.

Contar pasa a ser lo ÚLTIMO que se hace, detrás de dos puertas:

1. **¿Hay progreso?** Pedido creado o comprobante recibido → no está atascado.
2. **¿Recibió el menú?** Sin la herramienta en la mano no se le puede reprochar
   no usarla; avisar aquí sería avisar por cada conversación que arranca.
3. **Solo entonces, el volumen**, y el umbral sube de 6 a **8**: margen
   deliberado por encima de lo que gasta un pedido completo.

---

## 5g. El pedido armado que se quedó esperando una ubicación ya enviada (0028)

**El agujero**, contado por el negocio con dos conversaciones reales al lado. El
5c arregló al cliente que **pregunta** por el envío. Faltaba el que **ya pidió**.

El flujo previsto: el cliente arma el pedido en el menú, le llega el botón de
"enviar ubicación", lo toca, el pin vuelve con `context.id` y todo encaja. El
flujo real de bastante gente: arma el pedido y manda su ubicación con el clip de
WhatsApp de siempre, sin tocar el botón. Nadie le explicó que ese botón importa,
y desde su lado no hay diferencia.

Ese pin llega **sin `context.id`**, así que caía en el camino del 5c y se leía
como una consulta de tarifa. El resultado era peor que un error:

- recibía un precio de envío suelto y un *"armá tu pedido en el menú"* que
  acababa de hacer;
- su pedido seguía en `awaiting_location` **para siempre**: sin GPS, sin total
  con envío, sin QR y sin nadie preparándolo;
- y el webhook marcaba la entrega `processed`. Todo verde.

**Lo que se añade.** Antes de cotizar un pin como suelto se mira si hay un pedido
de ese teléfono esperando exactamente ese dato. Si lo hay, el pin es su
ubicación: se adjunta por el mismo camino que el botón —misma escritura atómica,
misma idempotencia, misma rama dinámica/legacy— y se cotiza, que es lo que junta
productos + envío en un total y dispara el QR.

El orden es todo el arreglo: **primero el pedido que espera, después la tarifa
suelta.** Quien no tiene pedido pendiente sigue recibiendo su cotización como en
el 5c, sin cambios.

Tres decisiones que sostienen esto:

- **Se busca por teléfono, no por wamid**, porque no hay wamid que buscar. La
  comparación se hace **normalizada y en memoria**: `orders.customer_phone`
  guarda lo que llegó del checkout (con `+`, espacios o guiones) y el webhook
  trae dígitos pelados. Un `.eq()` entre esos dos no encontraría nunca nada, y
  el fallo sería mudo — nadie vería un error, el cliente solo silencio.
- **Ventana de 6 horas.** No es un timeout técnico: es cuánto dura la intención.
  Un pin de mañana no es la respuesta al pedido de hoy, y adjuntarlo le cambiaría
  el destino a algo que ya nadie mira.
- **El claim del UPDATE no exige el wamid** (`contextId: null`): lo sostienen
  `status='awaiting_location'` y las coordenadas NULL, que son las mismas
  condiciones que ya impedían la doble escritura cuando sí había contexto.

**Y el recovery, que hacía lo mismo distinto (REC-03).** El worker del inbox
declaraba en su propio comentario *"EXACTAMENTE las mismas dependencias que el
webhook"* y le faltaban cuatro: `quoteStandaloneLocation`, `askLocationForQuote`,
`checkStuckCustomer` y el `attachLooseLocation` nuevo. El mismo mensaje salía
atendido o en silencio según quién lo procesara, y siempre con la fila
`processed`. Ahora se inyectan las cuatro, el objeto de deps va **anotado** (un
puerto mal escrito ya no compila) y un test compara el fuente de las dos rutas
puerto por puerto, porque el cableado es justo lo que no se puede probar
ejecutándolas: son opcionales, y olvidar uno compila, corre y pasa todo lo demás.

Archivos: `attachLooseLocation` en `src/lib/orders/attach-location.ts` (puro),
`findAwaitingLocationByPhone` + `attachLooseLocationForOrder` en
`src/lib/orders/service.ts`, el enganche en `src/lib/webhook/kapso.ts` y el
cableado de las dos rutas. Sin migraciones.

---

## 5h. La ubicación que llega como link de Google Maps (0029)

**El agujero**, traído por el negocio el 01-09-2026. El 5g arregló al cliente que
manda el pin sin usar el botón. Falta el que **no manda un pin en absoluto**:
abre Google Maps, busca su casa, le da a compartir y pega el link en el chat.

Llega como `type: 'text'`, así que no lo ve el parser de ubicación; y no lleva
palabra de coste, así que tampoco lo reconoce `isDeliveryQuoteIntent`. Termina en
el modelo, que contesta lo único que sabe: *"compartime tu ubicación"* — a
alguien que la acaba de compartir.

**El link corto no tiene coordenadas dentro.** `maps.app.goo.gl/5biYBaWPiPGPPcyB9`
es un identificador opaco. Hay que pedirle a Google la URL larga: un 302 con el
cuerpo vacío, del que solo se lee la cabecera `Location`.

**Y la URL larga trae TRES pares que no significan lo mismo.** Medido sobre un
link real del negocio:

| Dónde | Coordenadas | Qué es |
|---|---|---|
| `!3d!4d` (en `data=`) | -17.8429809, **-63.179145** | el lugar marcado |
| DMS del path | -17.8429722, -63.1791389 | el mismo lugar, ~1 m |
| `@` | -17.8429809, **-63.1817199** | el centro de la cámara |

**El `@` estaba 272 metros al oeste de los otros dos** — casi tres cuadras. No es
un redondeo: es la vista del mapa, y cambia según dónde tuviera el cliente la
pantalla al compartir. Es además el par más visible (sale en la barra del
navegador) y por eso el más fácil de agarrar con un regex apresurado, con el
repartidor dando vueltas por la cuadra equivocada.

De ahí la cascada, que es lo único que de verdad importa del extractor:
`?q=` → `!3d!4d` → DMS → `@` como último recurso. Hay un test que mide esos 272
metros, para que nadie lo "simplifique" a un solo regex de `@`.

**Un link de RUTA (`/dir/`) no se lee**: eso no es "aquí vivo", son dos puntos y
un trayecto, y adivinar cuál es la casa sería inventarse la dirección de alguien.

**La URL la escribe el cliente**, y eso decide el diseño de la única parte con
red. Las defensas, todas juntas y ninguna suficiente sola: allowlist **exacta** de
dominios (un `endsWith('google.com')` aceptaría `google.com.atacante.net`),
comprobada antes de la primera petición y **otra vez en cada salto**;
`redirect: 'manual'`; máximo dos saltos; timeout de 3 s porque esto corre con el
cliente esperando; y solo se lee la cabecera, nunca el cuerpo. Si algo falla
devuelve `null` y el mensaje sigue su camino de hoy — nunca lanza, porque una
excepción aquí tumbaría la entrega entera por un link.

**Las coordenadas escritas salen gratis.** "Lat: -17.842973, Long: -63.179229" es
leer dos números: sin red y sin depender del formato de nadie. Van primero. Se
exigen decimales en los dos, o "pedime 2, 3 hamburguesas" sería un par de
coordenadas perfectamente válido frente al ecuador y el cliente recibiría una
tarifa de envío en vez de su pedido.

**Un camino, tres puertas.** El pin, el link y las coordenadas escritas terminan
en la misma función: primero el pedido que espera (5g), y si no hay ninguno, la
tarifa suelta (5c). Tener un camino por puerta era justo lo que hacía que el
mismo cliente recibiera su QR o silencio según qué botón hubiera encontrado.

**El orden en el pipeline** es parte del arreglo: va después del menú —quien
escribe "quiero pedir" quiere pedir— y **antes** de "¿cuánto sale el envío?".
Sin eso, "cotízame aquí `<link>`" lleva palabra de coste y palabra de lugar, así
que el detector del 5d lo reconocería y le pediría la ubicación que acaba de
mandar.

### 5h.1 — El link que no trae la ubicación (corregido el mismo día)

El 5h se probó en producción y **falló con dos clientes reales**. Los dos
mandaron el mismo link, los dos recibieron *"compartí tu ubicación con el botón
de WhatsApp"* y los dos se quedaron sin cotización.

La primera sospecha fue el prompt del agente. **No era eso**: el modelo contestó
exactamente lo que le toca. El fallo estaba en que el determinista nunca llegó a
atender el link, y la causa aparece al expandirlo de verdad:

```
maps.app.goo.gl/EdpqyyUHJW2iQR8w6
  → maps.google.com?q=Av+Santos+Dumont,+Santa+Cruz&ftid=0x93f1ea1c…&entry=gps
```

**No hay coordenadas.** Hay un nombre de calle y un identificador de Google.

Hay **dos clases de link corto** y solo una sirve:

| Cómo lo compartió el cliente | A qué expande | ¿Sirve? |
|---|---|---|
| Buscó un LUGAR y lo compartió | `/maps/place/…/@lat,lng/data=…!3d…!4d…` | **Sí** |
| Compartió "tu ubicación" desde la app | `?q=<calle>&ftid=<hex>&entry=gps` | **No** |

Y el segundo es, con diferencia, el que más manda la gente — es el que sale al
tocar "compartir mi ubicación" en Google Maps.

Se comprobó que no hay nada que rascar: ni cambiando el User-Agent (móvil, PC,
ninguno) ni siguiendo el segundo salto aparecen coordenadas. Tampoco están en el
HTML.

**Y no se geocodifica ese texto para salir del paso.** Medido con el geocoder
que ya usamos: "Avenida Santos Dumont" devuelve el punto medio de una avenida de
varios kilómetros, a 3,7 km del local. El tramo del tarifario mide uno, así que
el error son dos o tres escalones de tarifa — cobrar mal es peor que no cobrar.
El mismo geocoder ofrecía como tercera opción una *Santa Cruz de la Sierra en
Cáceres, España*.

**Lo que se hace entonces:** se le dice qué pasó. Un texto determinista propio,
distinto del genérico:

> Ese link me llega con el nombre de la calle, pero sin el punto exacto 📍
> Mandámela como ubicación y te la cotizo al toque: tocá 📎 → Ubicación →
> Enviar tu ubicación actual.

Que sea **distinto** es el punto entero. Repetirle "compartí tu ubicación" a
alguien convencido de que acaba de hacerlo lo deja mandando el mismo link otra
vez, que es exactamente lo que se vio en las dos conversaciones.

Archivos: `src/lib/delivery/maps-link.ts` (puro: detección, cascada y
coordenadas escritas), `maps-link-service.ts` (la expansión, lo único con red),
`QUOTE_LINK_WITHOUT_COORDS_TEXT` en `quote-request.ts` y el enganche en
`src/lib/webhook/kapso.ts`. Sin migraciones.

---

## 6. Estado

**2.977 tests en verde**, lint limpio, build correcto.

`main` local tiene **4 commits sin pushear** (`c21c2da`, `1379ac8`, `b5497f2`,
`d162cc7`). `a972738` y anteriores ya están en `origin/main`.

### Pendiente

- **Migraciones: las tres aplicadas** (`0025` análisis, `0026` numeración diaria,
  `0027` cotizaciones sueltas). Verificado contra la base el 29-08-2026 con la
  query de objetos de más abajo, no de memoria: esta lista decía "sin aplicar"
  durante días después de que dejara de ser verdad, porque nadie la actualiza al
  correr una migración. Antes de creerte esta línea, vuelve a comprobarlo.

  ```sql
  select
    (select count(*) = 6 from information_schema.columns
       where table_schema = 'public' and table_name = 'payment_proofs'
         and column_name in ('analysis_verdict','analysis_reasons','analysis_amount',
                             'analysis_reference','analysis_model','analyzed_at'))
      as m0025_analisis,
    (to_regclass('public.order_daily_counters') is not null
       and to_regproc('public.next_order_number') is not null) as m0026_numeracion,
    (to_regclass('public.delivery_quote_requests') is not null) as m0027_cotizaciones;
  ```
- **Sin correr todavía**: `npm run eval:selection`. Se intentó y **las 69
  llamadas fallaron con HTTP 401**: la `OPENAI_API_KEY` de `.env.local` está
  revocada o es incorrecta. No se pudo medir nada, ni lo nuevo ni lo viejo.
  Hace falta una clave válida y volver a lanzarlo: es lo único que dice si la
  descripción nueva quita el falso positivo sin degradar `send_menu`.
- **Tu recovery cron sigue sin desplegar** (lo dice tu propio doc). Mientras
  tanto, `WEBHOOK_ASYNC_ACK` no debería encenderse: sin despertador, un evento
  que se caiga a mitad queda huérfano.
- **Variables nuevas**: `AI_VISION_MODEL`, `TELEGRAM_HANDOFF_CHAT_ID`,
  `PAYMENT_PROOF_ANALYSIS_*`, `PAYMENT_PROOF_ACCOUNT_*`. Todas opcionales y
  apagadas por defecto.
- **La cuenta del negocio ya está**: número, titular, banco y los alias de cada
  uno, calibrados contra cinco comprobantes reales (BNB, BCP, Mercantil, Yape,
  Banco Económico). Están transcritos como fixtures en
  `src/lib/payment-proof/analysis-real-receipts.test.ts`. Falta ponerlas en
  producción y aplicar la `0025`.

---

## Verificación

```bash
npm test                  # 2.977, verde
npx tsc --noEmit          # solo un error preexistente en orders-repository.test.ts
npx next build
npm run eval:selection    # ⚠ tokens reales — el que falta
```

Manual, en este orden: escribir `menu` (llega el saludo con el horario), dictar
un pedido (llega el CTA educativo), quejarse (derivación + pausa + Telegram), y
aceptar un comprobante desde el panel (el agente deja de responder).
