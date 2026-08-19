# Shared Menu Dispatch

Documento **trackeado** de la única autoridad sobre el efecto *"mandarle el
menú a un cliente"* (Fase 6D.2F.5A).

## Por qué existe

Hasta 6D.2F.5A el CTA se enviaba directo desde el webhook. La única
idempotencia era que el mismo `source_message_id` producía el mismo token: un
reintento reenviaba el **mismo enlace**, pero lo reenviaba.

Con `send_menu()` a la vista, el envío pasa a tener dos puertas y ninguna puede
fiarse de la otra:

```
ruta determinística ─┐
                     ├→ dispatchMenu() → menu_send_deliveries → Kapso
send_menu() (agente) ┘
```

Desde 6D.2F.5B las dos puertas están conectadas y comparten dependencias:
`createMenuDispatchDeps()` se construye en un solo sitio y lo usan tanto el
webhook como la tool. Si cada una armara las suyas, "una sola autoridad sobre el
efecto" duraría hasta el primer despiste.

## La única protección

| | Qué protege | Mecanismo |
|---|---|---|
| **Idempotencia técnica** | el mismo WAMID entrante jamás produce dos CTAs | `UNIQUE (source_message_id)` |

Un WAMID **nuevo** sí puede producir un CTA nuevo, sin excepciones ni ventanas.

Hubo una segunda protección —un cooldown de quince minutos para
`agent_suggestion`— y se eliminó en 6D.2F.5B. La idea era "no spamear a quien no
lo pidió", pero lo que hacía en la práctica era negarle el menú a alguien que
acababa de escribir otra vez, que es justo cuando más interesa atenderle. Las
razones para volver a pedirlo son de lo más normal —el enlace no cargó, cerró la
ventana, cambió de idea— y un reloj no distingue ninguna de ellas.

**Contener ráfagas y bucles no es trabajo de este módulo.** El buffering nativo
de Kapso reduce varios mensajes seguidos a un turno lógico, y el Conversation
Guard se ocupará del flood real. Ese es el sitio donde esa preocupación tiene
el contexto para decidir bien; aquí solo tenía un reloj.

## Orden de las operaciones

```
1. sesión de menú       ← idempotente por source_message_id, sin efecto visible
2. CLAIM                ← inmediatamente antes del envío
3. Kapso                ← el único efecto irreversible
4. ledger → memoria
```

El claim va lo más **tarde** posible sin dejar de ir **antes** del envío. Así,
una fila en `pending` solo puede significar *"nos caímos durante la llamada a
Kapso"* — el caso ambiguo en el que no reenviar es exactamente lo correcto. Si
el claim fuera antes de crear la sesión, un fallo transitorio de base dejaría
ese mensaje del cliente sin menú para siempre.

## Estados

| Estado | Significado |
|---|---|
| `pending` | reclamado; pudo haber salido |
| `sent` | consta que salió: hay WAMID del proveedor |
| `failed` | consta que **no** salió (rechazo determinístico, 4xx) |
| `send_unknown` | pudo salir (timeout, red, 5xx, 2xx ilegible) |
| `blocked_recent` | **LEGACY**: lo escribía el cooldown. Ninguna ejecución lo produce ya |

El criterio `failed` vs `send_unknown` es el mismo que usa Agent Core y vive en
un solo sitio: `@/lib/kapso/send-outcome`.

## Motivos

| `reason` | Origen |
|---|---|
| `explicit_request` | el cliente lo pidió: `isMenuIntent` (ruta determinística) o `isExplicitMenuRequest` (ruta del agente) |
| `explicit_resend` | "no me llegó", "mandámelo otra vez" |
| `agent_suggestion` | nadie lo pidió; al agente le pareció útil |
| `qa_trigger` | `TESTMENU9842` |

**El motivo lo decide el backend**, a partir de qué detector disparó. La tool
`send_menu()` no lleva `force` ni `reason`: no acepta **ningún** argumento, y el
motivo se fija dentro de la propia tool.

Desde que se quitó el cooldown, `reason` es **observabilidad pura**: ningún
camino del código se ramifica por él y los cuatro motivos envían igual.

### Qué significa `agent_suggestion` — y qué no

| Valor | Significa exactamente |
|---|---|
| `explicit_request` | el entrante contiene una referencia clara al menú o a la carta |
| `agent_suggestion` | no la contiene. **Nada más.** |

**No significa "el agente actuó por iniciativa propia".** `"¿Qué hamburguesas
tienen?"` es una petición clarísima de ver productos y queda como
`agent_suggestion`, simplemente porque no dice "menú" ni "carta". De hecho es
justo lo que pasó en el smoke de producción del 16-08-2026.

Por eso **esta señal no sirve como entrada directa de un Conversation Guard**:
contar `agent_suggestion` no cuenta menús no solicitados, cuenta menús pedidos
con otras palabras. Quien quiera medir iniciativa del agente necesitará otra
señal, no esta.

### Cómo se decide en la ruta del agente

El backend clasifica el **entrante real del turno** —no la salida del modelo—
con `isExplicitMenuRequest` (`src/lib/agent/business/menu-request.ts`):

| El cliente… | `reason` |
|---|---|
| nombra el menú o la carta | `explicit_request` |
| pregunta cualquier otra cosa | `agent_suggestion` |

No es `menu-intent.ts` y no debe convertirse en él. `isMenuIntent` **dispara**
el pipeline determinístico y por eso reconoce frases enteras; esto solo se
evalúa cuando el modelo ya decidió enviar, así que le basta con dos sustantivos.
Entender "mandme la carta" sigue siendo trabajo del modelo — de hecho
`isMenuIntent` no la reconoce, y por eso el mensaje llega al agente.

La tolerancia a typos se limita a dos transformaciones que no pueden convertir
otra palabra en estas: **letras repetidas** (`mennu`, `carrta`) y
**transposición contigua** (`mneu`, `acrta`), más el plural. Se descarta la
distancia de edición 1, que con palabras de cuatro y cinco letras se traga
`menos`, `corta`, `carga` y `cara`. Equivocarse ya no cambia lo que recibe el
cliente, solo la etiqueta — pero una etiqueta en la que no se puede confiar no
sirve para medir nada.

## Memoria del automatismo

Un envío confirmado se persiste en `agent_messages` como
`direction=outbound · role=assistant · actor=automation · content_type=interactive`,
con `metadata = {action: 'send_menu', resource_type: 'menu'}`.

Se guarda el **texto real del CTA**, no un marcador interno: el principio 4 de
0014 dice que `agent_messages` contiene solo mensajes reales del canal. Como el
contenido no es nulo, la ventana de contexto lo incluye, y el agente pasa a ver:

```
customer → automation (menú enviado) → customer
```

Sin esto veía dos mensajes del cliente seguidos, como si en medio no hubiera
pasado nada, y podía ofrecer el menú que se acababa de enviar.

### El copy no viaja al modelo

La fila guarda el texto real; el **contexto del modelo, no**. `agent_messages`
es la evidencia de lo que el cliente vio y no se toca, pero
`buildWorkingContext` proyecta los `actor='automation'` como un **evento del
sistema** (`role: 'system'`) construido a partir de una acción de lista blanca,
nunca copiando el contenido de la fila.

El motivo es un fallo real del 16-08-2026: ante `"Que opciones tienen?"` el
turno terminó **sin llamar a `send_menu`** y con un texto que reproducía el
mensaje del menú — mismo copy, mismo emoji, sin botón. El modelo tenía el copy
delante porque el contexto se lo pasaba como si fuera una frase del asistente.

La línea es **factual**: *"Evento del canal: el sistema envió un menú
interactivo al cliente."* Y nada más — sin "no hace falta repetirlo", que sería
reintroducir el cooldown en prosa. Si el cliente vuelve a pedirlo, se vuelve a
mandar. Detalle en `docs/agent-core.md`.

## Token y URL

No aparecen en `menu_send_deliveries`, ni en `agent_messages.metadata`, ni en
logs, ni en errores, ni en ningún documento de observabilidad. El enlace vive
en el botón del CTA y en `menu_sessions` (hasheado). La fila del ledger dice
**qué** pasó, nunca **cómo** entrar al menú de nadie.

## Pendientes conocidos

- **Reenvío ambiguo**: "mandámelo otra vez", "no me llegó" y "no abre" sin un
  referente claro. Hoy quedan etiquetados como `agent_suggestion` — envían
  igual, así que ya no es un problema de producto, solo de precisión del dato.
- Reconciliar un `send_unknown` que sí salió: llegará su
  `whatsapp.message.sent` con `origin=cloud_api`.
- Una fila `sent` cuya memoria conversacional falló queda sin mensaje en
  `agent_messages`. El ledger conserva la verdad; reconciliarlo es trabajo
  futuro.
- `blocked_recent` sigue en el CHECK de 0015 y en el tipo `MenuDeliveryStatus`,
  porque una fila vieja puede traerlo al leerse. Quitarlo del esquema exigiría
  una migración que no compensa. Lo que ya no existe es un camino que lo
  escriba, y el índice parcial `ix_menu_send_deliveries_recent` —creado para la
  consulta del cooldown— queda como vestigio útil para cualquier consulta por
  teléfono y recencia.
- El **buffering nativo de Kapso** y el **Conversation Guard** son los que
  tienen que contener ráfagas, bucles y flood. No pertenecen a `send_menu` ni a
  este módulo: aquí no hay contexto para distinguir un cliente insistente de un
  bucle.
