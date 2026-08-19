# Agent Core — configuración y garantías

Documento **trackeado** de las variables de entorno del agente. `.env.example`
está cubierto por el patrón `.env*` de `.gitignore` y no se versiona, así que la
referencia canónica es esta.

## Variables

Todas son **opcionales** y **server-only** (nunca `NEXT_PUBLIC_`). Si falta
cualquiera de ellas el agente no llama a OpenAI y el sistema se comporta
exactamente como antes de la Fase 6D.2F.3.

| Variable | Efecto | Valor en producción hoy |
|---|---|---|
| `AI_ENABLED` | Interruptor general. **Solo la cadena exacta `true` enciende el agente.** Ausente, vacía, `TRUE`, `1` o cualquier otra cosa lo dejan apagado. | `true` (solo para `AI_TEST_PHONE`) |
| `AI_TEST_PHONES` | Teléfonos atendidos, separados por coma, por **coincidencia exacta** de dígitos normalizados. Sin prefijos ni comodines. Se recortan espacios y se ignoran entradas vacías. | `59162139119,59172654203` |
| `AI_TEST_PHONE` | Forma anterior: un solo teléfono. **Respaldo** — solo se usa si `AI_TEST_PHONES` no está definida. | `59162139119` |
| `OPENAI_API_KEY` | Credencial del modelo. Sin ella, el agente queda apagado (`not_configured`) y **no se hace ninguna llamada externa**. | configurada |
| `OPENAI_MODEL` | Modelo a usar. Por defecto `gpt-4o-mini`. | `gpt-4.1-mini` |
| `HUMAN_TAKEOVER_PAUSE_MINUTES` | Minutos que dura la pausa por takeover humano. Rango **1..1440**; ausente o inválida ⇒ **30**. No lanza nunca. | sin definir (⇒ 30) |

El valor por defecto se deja en `gpt-4o-mini` a propósito: si `OPENAI_MODEL`
desapareciera del entorno, el `agent_runs.model` lo delataría en vez de fingir
que el despliegue sigue con el modelo previsto.

No existe `OPENAI_BASE_URL`. El host de OpenAI es una **constante** del
adaptador (`https://api.openai.com/v1/responses`): hacerlo configurable
permitiría que una variable mal puesta enviara el `Bearer` de la clave a un host
arbitrario, y no hay ningún requisito de proxy que lo justifique. En pruebas se
inyecta `fetch`, no se reapunta la URL.

## Tamaño de la respuesta

WhatsApp premia lo breve, así que el techo se pone en tres sitios que se
refuerzan entre sí:

| Control | Valor | Dónde |
|---|---|---|
| `max_output_tokens` | `300` | `DON_ZARCO_MAX_OUTPUT_TOKENS`, con el mismo valor por defecto en el adaptador |
| `text.verbosity` | `low` | adaptador |
| `reasoning.effort` | `none` | adaptador |
| Prompt | "una o dos frases" | Business Adapter |

`effort: 'none'` no es solo latencia: los tokens de razonamiento **se descuentan
del mismo `max_output_tokens`**, así que sin él un modelo de razonamiento podría
agotar los 300 pensando y devolver `status: incomplete` — que esta fase descarta
sin enviar nada.

`reasoning` y `text` solo se envían a los modelos que los admiten
(`supportsResponseTuning`, hoy la familia `gpt-5.x`). Cambiar `OPENAI_MODEL` a
cualquier otro nombre no rompe el envío: los campos simplemente no se mandan.
`gpt-5` a secas queda fuera porque no acepta `effort: 'none'`.

**Hoy en producción no se envían**: el modelo es `gpt-4.1-mini`, que no
pertenece a esa familia. Los frenos activos son `max_output_tokens` y el
prompt. Funcionó como se diseñó — el primer turno real salió `completed` sin
que nadie tuviera que acordarse de quitar los campos.

## Qué puede afirmar el agente

Las reglas grounded viven en `src/lib/agent/business/prompt.ts`, no aquí:

> COMPRENDER = flexible · AFIRMAR = con respaldo · ACTUAR = solo el sistema

El agente entiende faltas de ortografía, abreviaciones y referencias
conversacionales, pero no afirma nada sobre productos, precios, ingredientes,
disponibilidad ni recomendaciones sin una fuente que lo respalde. Los claims de
**seguridad alimentaria** (gluten, celiaquía, alérgenos) son categoría aparte:
no se afirman ni siquiera teniendo la lista de ingredientes, porque el contacto
cruzado en cocina no está en ninguna lista.

El historial sirve para entender el contexto, **no** como fuente de hechos: una
afirmación previa del propio agente no se convierte en dato por estar escrita.
Lo único que se reafirma en cada turno es el system prompt.

El comportamiento semántico se mide con `docs/agent-eval-grounded.md` contra el
modelo real. **No se ejecuta desde `npm test`**: un modelo falso no puede
demostrar que el real no inventa.

## Acciones (Fases 6D.2F.5B y 6D.2F.5B.1)

Tres, y ninguna recibe argumentos. No es una simplificación temporal: sin
parámetros no hay `force`, no hay `reason`, no hay filtros inventados y
no queda nada que validar más allá de "vino vacío".

| Acción | Qué hace | Autoridad |
|---|---|---|
| `send_menu` | envía el CTA del menú | delega en `dispatchMenu`; el `reason` lo pone el backend |
| `get_menu_items` | nombre, precio y categoría de los productos activos | lee `menu_items`, la misma fuente que el resto del sistema |
| `answer_directly` | **nada** — declara que el turno no necesita ninguna acción de negocio | no ejecuta, no tiene `execute` |

El modelo elige **exactamente una** por turno. El catálogo lo provee el Business
Adapter (`createAgentActions()` en `service.ts`); el core solo sabe que hay una
lista y qué declara cada elemento.

### Cuál se usa para qué

El criterio es **cuántos productos tendría que nombrar la respuesta**:

| La respuesta nombraría… | Herramienta |
|---|---|
| varios productos, una categoría entera, "lo que hay" | `send_menu` |
| uno o dos productos concretos | `get_menu_items` |

Reescribir el catálogo entero en un chat es peor experiencia que el CTA, que ya
existe y se ve mucho mejor — y encima gasta tokens en repetir algo que el
cliente puede abrir de un toque. Las dos juntas en el mismo turno son ruido:
CTA **o** dato, no ambos, salvo que el cliente pidiera las dos cosas.

La regla es **semántica y vive en el prompt y en las descripciones de las
tools**, no en una lista de frases. Nada de esto toca `menu-intent.ts` ni añade
keywords.

**Por qué se formula contando productos.** La primera versión separaba
"explorar" de "preguntar un dato", y `"q hamburguesas tienen?"` cae honestamente
en los dos lados: es una pregunta, y su respuesta es una lista. En el smoke de
producción el modelo la leyó como dato y enumeró las cuatro hamburguesas.
Contribuyó un error propio: la descripción de `get_menu_items` traía **"qué
extras hay"** como ejemplo de pregunta concreta — una categoría disfrazada de
dato puntual—, y generalizar de ahí a "qué hamburguesas hay" es exactamente lo
que un modelo debe hacer. Contar productos no tiene ese doble filo: la respuesta
es una y el propio modelo puede comprobarla sobre su borrador.

Se refuerza con una regla que el modelo puede autoaplicar: *si te descubres
enumerando productos, la respuesta correcta era mandar el menú*.

Y una prohibición nacida del caso real: después del CTA, **no volver a ofrecer
los precios**. La respuesta de producción terminó en *"¿Querés que te cuente
precios o algo más?"*, que deshace justo lo que el CTA acaba de resolver.

El grounding no se afloja: si el agente afirma un precio o un producto, tiene
que haberlo consultado. Recomendaciones subjetivas, ingredientes, dieta y
alérgenos siguen exactamente igual de prohibidos.

Lo que el modelo ve de cada producto es **más pobre** que la fila de base: sin
`id`, sin `code`, sin `is_active`, sin `sort_order`, sin timestamps. Y el
resultado incluye una nota explícita de que **no hay ingredientes ni alérgenos**
— porque una ausencia implícita el modelo la rellena deduciendo del nombre.

La `description` es el **copy de vitrina** que el cliente ya lee en `/menu`
(`PRODUCT_DESCRIPTIONS`), no una ficha técnica. Puede repetirse tal cual; de
ella **no** se concluye vegetariano, vegano, sin carne, sin gluten, libre de
alérgenos ni seguro para una alergia. La regla dura de alérgenos no la afloja
nada de esto.

`send_menu` devuelve solo `{sent, status}`: ni URL, ni token, ni WAMID, ni id de
la entrega. El enlace vive en el botón del CTA, no en la conversación con
OpenAI.

El **motivo** del envío lo decide el backend leyendo el entrante real del turno:
si el cliente nombró el menú va como `explicit_request` y si no, como
`agent_suggestion`. Es **observabilidad**: desde que se quitó el cooldown de
quince minutos, los dos motivos envían igual y ningún camino del código se
ramifica por ese valor. Y significa solo lo que dice — `agent_suggestion` es
"el entrante no nombró el menú", no "al agente se le ocurrió a él". El detalle está en `docs/menu-dispatch.md`; lo que
importa aquí es que el modelo no participa en esa decisión, ni siquiera
indirectamente: la tool no acepta argumentos y el texto que se clasifica no es
suyo.

**No hay ventana temporal que bloquee `send_menu`.** Un mensaje nuevo del
cliente puede producir un CTA nuevo; lo único que lo impide es el mismo WAMID.
Contener ráfagas es trabajo del buffering de Kapso y del Conversation Guard,
no de esta herramienta.

### Selección de acción (6D.2F.5B.1)

El bucle de herramientas se retiró. En su lugar hay **dos rondas con trabajos
distintos**, y el orden importa:

```
DECIDIR    qué capacidad necesita ESTE turno.
           tool_choice=required · parallel_tool_calls=false · sin producir texto.
             ↓ exactamente UNA acción
EJECUTAR   la acción, si tiene algo que ejecutar. Barrera de pausa antes del efecto.
             ↓ si el efecto ES la respuesta → el turno CIERRA aquí
REDACTAR   qué decir. Sin herramientas (tool_choice=none).
```

**Por qué.** Antes, "no llamar a ninguna herramienta" era el camino *por
omisión*: no había que elegirlo, se llegaba a él por defecto. Eso dejaba una
respuesta libre disponible siempre, incluso cuando la respuesta correcta era una
acción — y una omisión no deja rastro. El 16-08-2026, ante `"Que opciones tiene
?"`, el turno acabó con `tool_rounds = 0`, cero deliveries y esta frase:

> *"Te paso el menú para que veas todas las opciones y precios, tocá Ver menú
> para elegir."*

Un CTA falso. En la base no había forma de distinguir *"decidió contestar
hablando"* de *"se olvidó de decidir"*: las dos se ven igual, silencio.

**Exactamente una, y fail closed.** Si la decisión no se puede honrar, el run
cierra en `failed` y **no se manda ningún texto** — dejar hablar al modelo
cuando su decisión no se pudo interpretar es exactamente el camino del fallo.

| `error_code` | Qué pasó |
|---|---|
| `selection.no_action` | no eligió ninguna, aunque se le exigió elegir |
| `selection.multiple_actions` | eligió varias; no se ejecuta ninguna |
| `selection.unknown_action` | se inventó un nombre que no está en el catálogo |
| `selection.invalid_arguments` | mandó argumentos a una acción que no los tiene |

`agent_runs.tool_rounds` vale **1** en todo turno que llegó a decidir, incluso
si la decisión fue inválida: la ronda existió y se pagó. Vale 0 solo si el
modelo nunca respondió. **`tool_rounds = 0` + texto libre ya no es
representable**, y ese era la firma del fallo.

Sin acciones cableadas (`deps.actions` ausente) el turno es una sola llamada,
solo texto, exactamente como antes de que existieran las herramientas. Sigue
siendo el interruptor de apagado.

### El efecto ES la respuesta

Cuando una acción declara `effectCompletesTurn` y su efecto sale **confirmado**,
el turno cierra sin pedirle texto al modelo. `send_menu` lo declara: el CTA ya
lleva imagen, copy y botón "Ver menú" — es la respuesta entera, y una frase
añadida solo podría repetirlo… o inventarlo.

Por esa vía, la frase que afirma el envío no puede existir sin el envío: cuando
el envío ocurre no se escribe ninguna frase. Y si el despacho **no** se confirma,
esto no se activa y el modelo redacta con el fallo delante — que es justo cuando
sí hace falta que hable.

Efecto colateral que importa: el artefacto imitable deja de fabricarse. Los
cuatro históricos se conservan (son historia real del canal), pero no se crean
más.

### Qué garantiza esto y qué no

Conviene ser exacto, porque la diferencia decide qué hay que medir.

**Garantizado por construcción** — son propiedades del código, no del modelo:

- No existe fallthrough implícito: todo turno con acciones cableadas pasa por
  una decisión estructurada, o cierra en `failed` sin decir nada.
- `tool_rounds = 0` **+ texto libre** no es representable.
- Un `send_menu` **confirmado** no produce ninguna frase de IA posterior.
- Una decisión que no se puede honrar no manda texto.

**NO garantizado** — sigue habiendo un LLM eligiendo:

- El modelo puede **seleccionar mal**. Nada impide que responda
  `answer_directly` a una intención que semánticamente pedía `send_menu`, y en
  esa ronda de redacción puede escribir prosa que suene a un menú que nadie
  mandó. La arquitectura eliminó el camino *silencioso* hacia ese texto; no
  eliminó el *equivocado*.
- El antecedente conservado en la ventana de decisión (ver más abajo) puede ser,
  hoy, uno de los cuatro CTA históricos.

Eso es exactamente lo que mide `npm run eval:selection` contra el modelo real.
**No hay determinismo semántico aquí**, y afirmarlo en esta página sería
sustituir una medición por una promesa.

**Medición del 16-08-2026** (`gpt-4.1-mini`, 24 casos × 3 = 72 ejecuciones):
**hard gate 54/54**, total **71/72**. El desvío fue `general-05` —*"Cómo puedo
pedir?"*— con una de tres ejecuciones eligiendo `send_menu` en vez de
`answer_directly`: un error **hacia** una acción con respaldo, no hacia una
respuesta de memoria. Detalle y criterio en `evals/README.md`.

### Callarse después de mandar algo

El prompt autoriza mandar el CTA y no decir nada más. Pero para el core un texto
final vacío siempre había significado `model.empty_response` → `failed`: sin
herramientas, un modelo que no escribe es un modelo que falló. Con `send_menu`
eso dejó de ser cierto — el cliente ya tiene el menú en su WhatsApp.

La regla: **un texto vacío cierra el run en `completed` solo si alguna
herramienta de ese turno confirmó un efecto que el cliente ve.** Entonces no se
envía nada, no se fabrica texto y **no se persiste un `agent_messages` de IA
vacío**; la evidencia visible es el mensaje `actor=automation` del CTA. El turno
devuelve `completed_silent`.

La señal viaja en el contrato de las tools, no en el nombre de ninguna:

```ts
AgentToolOutcome = { result: unknown; userVisibleEffectConfirmed?: boolean }
```

El core nunca pregunta *"¿era `send_menu`?"* — un `if` por nombre de herramienta
dentro del core lo ataría a este negocio. La decide la tool desde el resultado
**real** de su dependencia, y `executeToolCall` la normaliza a booleano.

| Resultado de `dispatchMenu` | ¿Efecto visible? |
|---|---|
| `sent` | **sí** |
| `duplicate` | **sí** — el menú está en el chat |
| `failed` · `send_unknown` | no |
| `get_menu_items` (cualquier caso) | no — el cliente no ve una consulta |
| `unknown_tool` · `invalid_arguments` · `tool_failed` | no — no se ejecutó nada |

`send_unknown` es el que importa: ahí el proveedor no dio certeza, y cerrarlo
como éxito silencioso dejaría al cliente sin nada y sin rastro de que faltó
algo. La duda la sigue custodiando el ledger del menú.

El modelo no participa: la tool no acepta argumentos, la señal no viaja en el
`function_call_output` y nunca se deduce de su prosa. La decisión vive en el
core y no en el adaptador a propósito — para el transporte, una respuesta sin
texto y sin herramientas sigue siendo una anomalía; si es aceptable depende de
lo que pasó antes en el turno.

Observabilidad: `agent_runs.tool_rounds` guarda el contador. **Qué** acción fue
no cabe en la tabla, así que va al log estructurado — nunca argumentos ni
resultados. Añadir una columna sería una migración, y esta fase no la necesita.

| Evento del log | Cuándo | Campos |
|---|---|---|
| `agent_action_selected` | la decisión, siempre que es válida | `runId`, `action`, `round` |
| `agent_tool_call` | la ejecución, si la acción ejecuta algo | `runId`, `tool`, `ok`, `round` |
| `agent_action_selection_invalid` | la decisión no se pudo honrar | `runId`, `error` |

`agent_tools_used` **se retiró**: con exactamente una acción por turno, el
agregado era la propia selección. Un `answer_directly` no emite
`agent_tool_call` porque no ejecuta nada — su rastro es
`agent_action_selected`.

Ninguno lleva texto del cliente, WAMID, teléfono, prompt ni salida de la acción.
El log no es la fuente de autoridad: la base sigue siendo la verdad durable.

## Historial ≠ contexto

La base guarda el historial completo; el modelo recibe una ventana. Y esa
ventana no es una copia: **lo que alguien dijo viaja con su texto; lo que el
sistema hizo, no**.

| Actor | Rol para el modelo | Contenido |
|---|---|---|
| `customer` | `user` | su texto real |
| `ai` | `assistant` | su texto real |
| `human` | `assistant` | su texto real — así el agente no repite lo que ya contestó una persona |
| `automation` (acción conocida) | **`system`** | una **línea de evento**, nunca el contenido de la fila |
| `automation` (acción desconocida) | — | **se omite** del contexto |

La línea, literal y completa:

> Evento del canal: el sistema envió un menú interactivo al cliente.

Es **factual y nada más**. No dice "no hace falta repetirlo" ni "ya fue
atendido": eso sería el cooldown otra vez, escrito en prosa, justo después de
haberlo quitado. Un mensaje nuevo del cliente puede necesitar el menú otra vez,
y eso lo decide el turno actual.

`ContextMessage` no lleva metadata: el repositorio lee `metadata.action` y lo
reduce en el sitio a una **lista blanca** (`toAutomationAction`, hoy solo
`send_menu`). Lo que sale hacia el core es un valor de un conjunto cerrado, y es
**fail-closed**: una acción que no esté en la lista **no llega al modelo**.
Describir en genérico algo que no sabemos interpretar sería inventar, y un
automatismo futuro no debería aparecer en la conversación hasta que alguien
decida cómo se cuenta. La fila sigue en la base.

El recorte de `maxMessages` se aplica **después** de proyectar: una fila
descartada no le roba sitio a un mensaje real.

**Por qué.** El 16-08-2026, ante `"Que opciones tienen?"`, el turno terminó sin
llamar a `send_menu` y con un texto que reproducía el mensaje del menú: mismo
copy, mismo emoji, sin botón. El copy estaba a mano porque la memoria del
automatismo guarda el cuerpo real del CTA —correcto para la base— y el contexto
lo proyectaba como si fuera una frase del asistente. Con el hecho, el agente no
vuelve a ofrecer un menú ya enviado; sin el copy, no lo puede imitar.

Esto corrige la **imitación** del copy del automatismo. Pero no la cerró del
todo, y el 16-08 lo demostró otra vez: un `actor='ai'` sigue viajando con su
texto real —y debe hacerlo, es lo que evita que el agente repita lo que ya
contestó—, así que el objetivo de la imitación simplemente **se mudó**, del copy
del automatismo a la propia frase de la IA. El turno que funcionó fabricó el
material del turno que falló.

### Dos ventanas: decidir y redactar (6D.2F.5B.1)

La conclusión no fue "pasar menos historial", sino que **decidir y redactar
necesitan cosas distintas**. Una lectura de la base, dos proyecciones.

| | Redacción (`buildWorkingContext`) | Decisión (`buildSelectionContext`) |
|---|---|---|
| `customer` | su texto real | su texto real |
| `ai` / `human` — **el último** | su texto real | **su texto real** |
| `ai` / `human` — anteriores | su texto real | **evento**: *el asistente / una persona respondió al cliente* |
| `automation` | evento neutralizado | evento neutralizado |
| entrante actual | el del historial | **siempre presente y siempre último** |
| tope | 24 | **12** |

Para redactar, cómo se dijo antes es valioso: da continuidad y tono. Para decidir
qué capacidad hace falta **ahora**, la prosa *acumulada* no aporta nada — y sí
ofrece una respuesta lista para copiar que ya salió bien una vez.

**Por qué el último saliente sí conserva su texto.** Porque sin él hay mensajes
que no significan nada por su cuenta:

| Antecedente | Cliente | Acción correcta |
|---|---|---|
| *"¿Querés que te pase el menú?"* | "Sí" | `send_menu` |
| *"¿Te explico cómo pagar?"* | "Sí" | `answer_directly` |
| *"Tenemos la Doble o Nada."* | "¿y esa cuánto cuesta?" | `get_menu_items` |

Los dos "Sí" son idénticos. Neutralizar el antecedente los volvía
indistinguibles. **Uno, y no los últimos tres**: es la regla más pequeña que
resuelve la elipsis, y es **posicional** — no hay ninguna búsqueda de frases
decidiendo qué texto es "relevante". Los anteriores siguen entrando como evento,
así que la estructura de la conversación (quién habló, en qué orden, qué hizo el
sistema) se conserva entera.

**Lo que esto no arregla.** Si el último saliente resulta ser una frase que
anunciaba el menú, vuelve a estar delante del modelo. Hoy quedan cuatro así en
producción. Deja de crecer —un `send_menu` confirmado ya no escribe ninguna
frase— pero las que existen siguen ahí. Es un límite real y se **mide** con el
eval, no se argumenta.

**Lo que se pierde más atrás.** Tras dos o tres turnos, un *"y el otro?"* puede
quedar sin antecedente en la decisión. Suele dar igual —sea cual sea el
producto, la capacidad que hace falta es la misma— y la ronda de redacción sí
recibe el contexto normal completo.

**El entrante actual es obligatorio.** Normalmente ya viene en el historial y
no añade nada, pero la decisión no puede depender de eso: si el recorte lo dejó
fuera o la persistencia llegó tarde, el modelo estaría eligiendo sobre el
mensaje equivocado. Y equivocarse aquí no es un matiz de redacción: es mandar o
no mandar el menú.

Nada de esto cambia `agent_messages` ni el contexto de redacción, y **nada busca
frases**: no hay listas de `"te paso"` ni `"ver menú"` en ningún sitio.

## Fail-closed

Ninguna combinación parcial amplía el alcance:

| Configuración | Resultado |
|---|---|
| `AI_ENABLED` ausente | `disabled` — sin modelo, sin run |
| `AI_ENABLED=false` | `disabled` |
| `AI_ENABLED=true`, sin `OPENAI_API_KEY` | `not_configured` — sin llamada externa |
| `AI_ENABLED=true`, sin `AI_TEST_PHONES` ni `AI_TEST_PHONE` | `phone_not_allowed` — no se atiende a nadie |
| `AI_ENABLED=true`, teléfono fuera de la lista | `phone_not_allowed` |

Un `no` **no crea `agent_runs`**: la tabla mide ejecuciones del agente, y
anotar cada mensaje de cada cliente mientras el despliegue está limitado a un
teléfono la dejaría sin significado.

## Garantías del pipeline

- El agente solo actúa donde el pipeline determinístico **declinó** el mensaje.
  `TESTMENU9842`, la intención de menú, las ubicaciones y los `nfm_reply` no
  pueden ser interceptados por construcción.
- **Solo texto.** Imagen, audio, vídeo, documento, sticker, `unknown`,
  `location` e `interactive` nunca llegan al modelo: esta fase no es multimodal
  y responder sin haber entendido el mensaje sería adivinar.
- El `agent_run` se **reclama antes** de gastar un token, con el UNIQUE de
  `source_message_id`. Una reentrega encuentra el run y no vuelve a llamar.
- Conversación pausada **y con la pausa vigente** ⇒ `skipped_paused` en la
  barrera `pre_openai`, sin modelo y sin saliente de IA. Una pausa cuyo plazo ya
  venció no retiene a nadie.
- Nunca se envía texto vacío ni truncado, y nunca se inventa una respuesta que
  el modelo no dio.

## Lotes: N mensajes, un turno (6D.2F.5C.2)

Con el buffering activado, Kapso agrupa varios `whatsapp.message.received` en
una entrega. **Un lote no es un mensaje grande: son N mensajes que llegaron
juntos**, y de ellos sale como máximo un turno.

`webhook/envelopes.ts` normaliza las dos formas de entrega a una sola lista de
sobres. Una entrega individual es un lote de uno y recorre exactamente el mismo
código: que el camino individual no tenga implementación propia es lo que impide
que las dos formas se separen con el tiempo.

| | |
|---|---|
| 1 entrega HTTP | **1** `webhook_events`, nunca N |
| cada elemento | se persiste solo, con su WAMID, su timestamp y su orden |
| rutas determinísticas | por elemento: ubicación, `nfm_reply` y `TESTMENU9842` conservan la suya |
| turno del agente | **como máximo uno**, anclado en un mensaje REAL |

**El orden es la posición en `data[]`, nunca el timestamp.** El instante de
WhatsApp viene en *segundos* y el buffering existe para agrupar ráfagas: tres
mensajes seguidos comparten segundo con mucha frecuencia. Ordenar por reloj
dejaría indeterminado justo el caso para el que se activa el lote, y un empate
resuelto al azar ancla el turno en «hola» en vez de en la pregunta. Kapso
garantiza el orden dentro de `data[]`; ese orden es el dato.

**El ancla es el último elegible por posición, prefiriendo el que es trabajo
nuevo.** Es el mensaje que cierra la ráfaga y el que el cliente espera que se
conteste. De ahí sale `agent_runs.source_message_id` y, si el turno manda el
menú, `menu_send_deliveries.source_message_id`: un CTA por ráfaga.

La preferencia tiene tres niveles, y el orden entre ellos es el argumento:

1. último elegible **y nuevo** — `claimRun` para al encontrar el run ya
   reclamado, así que anclar en un WAMID consumido no da error: no da nada. El
   mensaje nuevo del lote quedaría persistido y sin contestar, en silencio.
2. último elegible — conserva la **reparación**: un mensaje ya persistido cuyo
   turno nunca llegó a reclamarse tiene que poder anclar.
3. último candidato — mantiene el camino individual intacto.

La novedad nunca sustituye a la clasificación, solo desempata dentro de ella:
una ubicación recién llegada es lo más nuevo del lote y aun así no puede anclar,
porque ya la atendió su ruta. Persistirse no es ser accionable.

No se concatena nada ni se fabrica un mensaje nuevo. Los N ya están persistidos
antes de llamar al modelo, así que la ventana de contexto —por conversación y 24
h— ve la ráfaga completa y en orden sin necesitar ningún vínculo explícito.

**Un lote que no entendemos no se degrada a individual**: se rechaza con 422
para que la entrega falle a la vista en Kapso.

## Reacciones: eventos de canal, no turnos (6D.2F.5C.4)

Una reacción (`message.type='reaction'`) es algo que **pasó** en la
conversación, no algo que alguien **dijo**. Se persiste entera y no produce
nada más: ni run, ni llamada a OpenAI, ni herramienta, ni respuesta.

| | |
|---|---|
| `provider_message_id` | WAMID propio del evento → deduplica por la vía normal |
| `content` | **NULL** |
| `content_type` | `unknown` — sin migración |
| `metadata` | `{ channel_event: 'reaction', reaction: { operation, emoji?, target_message_id } }` |

Agregar y quitar son **dos eventos con dos WAMID distintos**, y los dos se
guardan. No se deduplica por `target_message_id`: poner, quitar y volver a poner
es algo que una persona hace.

La operación sale de la **estructura** —`reaction.emoji` presente = `add`,
ausente = `remove`—, nunca de leer `kapso.content`. Esa frase la redacta el
proveedor y puede cambiar, traducirse o localizarse sin avisar.

**Dos barreras, y hacen falta las dos:**

1. **No llega al Agent Core.** Una reacción queda fuera de los candidatos a
   ancla, incluso siendo el único elemento de la entrega. Antes anclaba y moría
   en el gate de contenido del turno: el desenlace era correcto, pero por
   rebote. La excepción es solo la reacción — una foto o un audio sueltos siguen
   llegando al turno, porque en 5C.5 empezarán a leerse.
2. **No contamina el contexto.** `kapso.content` trae
   `"Reacted with ❤️ to message <wamid>"`, y `content_type='unknown'` lo aceptaba
   como cuerpo textual. Habría entrado al contexto del turno SIGUIENTE como
   palabras del cliente.

De ahí sale la política general, que vale igual para la media de 5C.5:

> **Texto generado por el proveedor en un tipo de mensaje no textual no se
> convierte automáticamente en palabras del usuario.**

Las dos ventanas —redacción y selección de acción— proyectan una fila del
CLIENTE solo si su `content_type` es `text`. Es fail-closed y por eso arregla
también el pasado: las reacciones ya persistidas en Production dejaron de
proyectarse sin tocar una fila. Los salientes (`ai`, `human`, `automation`) no
cambian: ese texto lo escribimos nosotros.

Se comprueban las tres señales de identidad por separado, porque fallan
distinto: `conversation.phone_number` decide **a quién** se responde,
`conversation.id` es la referencia del proveedor, y `phone_number_id` decide
**por qué número** sale la respuesta. Dos valores declarados distintos en
cualquiera de las tres ⇒ se rechaza el lote entero. Un campo **ausente** no es
una contradicción y no rechaza nada.

`batch_info` es diagnóstico. Si `size` no cuadra con `data.length` manda
`data.length` y se registra `webhook_batch_size_mismatch`: descartar mensajes
reales que tenemos delante por un contador que no cuadra sería el peor
intercambio posible.

## Las dos barreras de pausa (6D.2F.5C.1)

Desde el ACK durable, el turno puede ejecutarse segundos —o minutos, si entra
por el recovery— después de que el mensaje llegara. En ese hueco cabe que una
persona tome la conversación desde WhatsApp Business App. **Un trabajo aceptado
no otorga permiso permanente para hablar.**

| Barrera | Cuándo | Cierre |
|---|---|---|
| `pre_openai` | antes del modelo | `skipped_paused` |
| `pre_send` | antes de **cada efecto visible** | ver abajo |

La segunda no es "después del modelo": es antes de cada salida, y hoy hay dos —
el texto final y **`send_menu`**, que se ejecuta *entre* la decisión y la
redacción. Comprobar solo al final dejaría escapar el CTA.

El core no sabe cuál es cuál. Pregunta por la declaración estática
`producesUserVisibleEffect` de la herramienta, no por su nombre: un
`if (name === 'send_menu')` en el núcleo lo ataría a este negocio, y la
siguiente herramienta con efecto se olvidaría de la barrera sin que nada
avisara.

Cómo cierra el run:

| Al detectar la pausa | Cierre |
|---|---|
| nada visible aún | `skipped_paused` · `pre_send` |
| un efecto ya confirmado antes de la pausa | `completed`, en silencio |

El segundo caso reutiliza el *silent completion* de 5B y su señal
`userVisibleEffectConfirmed`. Decir `skipped` sería mentir cuando el cliente ya
tiene el menú en la mano. **No hay estados nuevos**: `pre_send` llevaba en el
CHECK de 0014 desde el principio sin que nadie lo escribiera.

Y la pausa detiene al **agente**, no al negocio: `location`, `nfm_reply` y
`TESTMENU9842` siguen funcionando con la conversación pausada. El GPS de un
cliente al que atiende una persona sigue haciendo falta. Por eso la barrera vive
en el camino de salida del agente y **no** en el webhook.

**Carrera residual, reconocida:** entre la comprobación y la llamada HTTP quedan
milisegundos en los que la pausa podría escribirse. No se cierra en esta fase.

### La pausa por takeover VENCE (6D.2F.5C.1)

Era indefinida y solo la levantaba un `POST /api/internal/agent/resume`. El coste
real de eso no es teórico: si nadie se acuerda de reanudar, la conversación se
queda muerta — el cliente escribe y no le contesta ni la persona ni el agente.

Ahora cada mensaje humano desde WhatsApp Business App fija
`pause_expires_at = messageTimestamp + HUMAN_TAKEOVER_PAUSE_MINUTES`.

| Evento | Efecto sobre el plazo |
|---|---|
| primer mensaje humano | pausa hasta `paused_at + N` |
| mensaje humano **nuevo** (otro WAMID) | **renueva**: `ese mensaje + N`. `paused_at` no se mueve |
| **reentrega** del mismo WAMID | **nada**. Ni pausa, ni renueva, ni duplica mensaje ni evento |
| mensaje humano nuevo pero **anterior** en el reloj | **nada**: el plazo solo avanza |
| mensaje del **cliente** | **nada**. El reloj mide actividad humana del negocio |
| vencimiento | el siguiente inbound elegible vuelve al agente, sin resume manual |

**Lo que separa una pausa de otra es el dato, no el origen.** `pause_expires_at`
poblado ⇒ temporal; `NULL` ⇒ indefinida. Por eso `isPauseActive` no tiene
ninguna rama por `pause_source`, y por eso un futuro "IA OFF" del panel —que
nacería sin vencimiento— nunca expiraría sin que haya que acordarse de nada.

`renewPause` va guardado por `state='paused' AND pause_reason=… AND
pause_source=…`: un mensaje desde la app **no** puede convertir una pausa
indefinida ajena en una de treinta minutos.

**El vencimiento se calcula sobre `messageTimestamp`, no sobre el reloj local.**
Semánticamente el plazo cuenta desde que la persona escribió; y como `paused_at`
es ese mismo instante, el CHECK `pause_expires_at > paused_at` queda garantizado.
Con el reloj local, un timestamp del proveedor algo adelantado abortaría la
transacción entera — y perder una pausa es lo peor que puede pasar aquí.

**Expiración perezosa, sin cron.** Una pausa vencida no le hace nada a nadie
mientras nadie escriba. `resolveExpiredPause` corre justo antes del turno y, si
el plazo pasó, ejecuta el **mismo** `resumeAgentConversation` del endpoint
interno con otra atribución: `source='system'`, `reason='human_takeover_expired'`.
Un solo mecanismo para devolver el control, dos motivos distinguibles en
`agent_control_events`.

Se escribe además de leer porque si no la base mentiría: el panel mostraría una
conversación pausada que en realidad está siendo atendida por el agente. Pero un
fallo al normalizar **no** bloquea el turno — es contabilidad, y `isPauseActive`
ya trata la pausa caducada como inactiva.

**No hizo falta migración.** `pause_expires_at`, `agent_control_events.expires_at`
y los CHECK correspondientes existen desde 0014; lo único que pasaba es que el
código escribía `NULL` a mano.

### Un WAMID humano produce UN takeover (hardening 5C.1)

Que la pausa venza abrió un agujero que antes no existía, porque antes no había
forma de volver a `active` sin que una persona lo decidiera.

`webhook_events` deduplica por **clave de idempotencia**, no por WAMID, y Kapso
puede reentregar el mismo mensaje con otra clave: entonces el evento se procesa
de verdad y llega a `handleHumanTakeover`. Si para ese momento la pausa había
vencido —o alguien la había levantado a mano—, la conversación estaba `active`,
`pauseConversation` pasaba su guard y **volvía a pausar**. Un reintento de red
deshaciendo una decisión humana.

La regla ahora es dura: *un WAMID humano que ya completó su takeover no puede
producir otro nunca.* La marca durable es el **evento de control** de ese WAMID,
que es la última escritura de la secuencia y por tanto prueba que las anteriores
ocurrieron. Sin columnas nuevas y sin heurísticas de tiempo.

| Estado durable | Qué se hace |
|---|---|
| evento de pausa presente para ese WAMID | nada. `pause: 'already_applied'` |
| evento ausente, mensaje presente | ejecución PARCIAL: se completa la pausa y el evento |
| nada | primera entrega: secuencia completa |

**Por qué no basta con mirar el mensaje.** `insertMessage` es el *primer* paso, y
un `duplicate` suyo es exactamente lo que se ve cuando la ejecución anterior
murió justo después de insertarlo. Cortar ahí perdería la capacidad de reparar,
que es la mitad de por qué esto es reintentable.

**La renovación es monótona.** Dos mensajes humanos seguidos pueden llegarnos en
orden inverso, y el segundo en llegar traer un `timestamp` anterior. `renewPause`
lleva un cuarto guard —`pause_expires_at IS NULL OR pause_expires_at < nuevo`— en
el propio UPDATE, no en un leer-comparar-escribir. Una intervención humana puede
alargar el takeover o dejarlo como está; nunca acortarlo. `not_extended` lo
distingue de `not_renewable`.

## Estados de `agent_runs`

`processing` → `sending` → `completed` | `failed` | `skipped_paused` |
`send_unknown`.

`send_unknown` significa **"desde aquí no hay certeza del desenlace"**, y nunca
se reenvía a ciegas. Se usa en dos situaciones distintas, que se distinguen por
`error_code`:

- `send.*` — el envío a Kapso no dio evidencia concluyente (timeout, error de
  red, 5xx, o un 2xx ilegible).
- `persist.ai_message_failed` — Kapso **sí** aceptó el envío y devolvió el
  WAMID, pero la escritura local falló. Aquí la incertidumbre es sobre nuestra
  contabilidad, no sobre el envío.

## Pendientes conocidos

- Persistir los salientes determinísticos del backend como `actor=automation`.
- Reconciliar un `send_unknown` cuyo mensaje sí salió: llegará su
  `whatsapp.message.sent` con `origin=cloud_api`, hoy clasificado como
  `system_outbound` y no persistido. `agent_runs` no tiene columna para un WAMID
  saliente, así que esa reconciliación tendrá que venir del evento del proveedor.
- Recuperación de runs colgados en `processing` / `sending`.
- Multimodal: imágenes con caption, audio y transcripción.
- Los cuatro `agent_messages` de IA con el copy del CTA (16-08-2026) siguen en
  la base — son historia real del canal y no se tocan. Salen de la ventana solos
  cuando dejan de estar entre los mensajes recientes.
