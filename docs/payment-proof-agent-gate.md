# La puerta de comprobantes — por qué OpenAI no ve un comprobante

## Lo que pasaba

El flujo capturaba el comprobante y, acto seguido, dejaba **la misma imagen**
dentro del burst que se le pasa a `runAgentTurn`. El agente la descargaba, la
convertía en `input_image` y la mandaba a OpenAI.

Nadie lo había decidido. Era el efecto de que las dos rutas —captura de
comprobantes y turno del agente— recorren la misma lista de mensajes entrantes
y ninguna sabía de la otra:

```text
webhook → capturePaymentProofs(envelopes)   ← el comprobante se guarda
        → burst = todos los entrantes        ← …y la MISMA imagen sigue aquí
        → runAgentTurn(ancla, burst)
             → resolveImage()  → data URL    ← los bytes salen del perímetro
             → input_image     → OpenAI
```

La foto de un comprobante bancario lleva nombre, banco, número de cuenta y a
menudo el saldo. El agente no responde sobre pagos —de eso se encargan el panel y
una persona—, así que esos bytes salían del perímetro sin que nadie ganara nada.

## La decisión: determinística y antes de los bytes

La tentación evidente es preguntarle al modelo "¿esto es un comprobante?". Es
exactamente lo contrario de lo que hace falta: **para preguntarlo hay que
mandarle la imagen, y mandársela es el daño que se quería evitar.** Lo mismo vale
para un OCR de terceros o cualquier clasificador remoto.

La clasificación sale del **mismo motor de enrutado que ya decide a qué pedido va
un comprobante** (`decideAssociation`), que no mira ni un byte del archivo: mira
el estado de los **pedidos** de ese teléfono.

```text
webhook → capturePaymentProofs(envelopes) → { outcomes, allowlist }
                                              ↑ veredicto por WAMID
        → withholdAttachmentsFromBurst(...)  ← LA PUERTA
        → runAgentTurn(ancla filtrada, burst filtrado)
             → resolveImage()   NUNCA se llama para lo no autorizado
             → input_image      NUNCA se construye para lo no autorizado
```

Se corta aquí y no más abajo justamente para que no haya un "más abajo".

## La política: AUTORIZACIÓN POSITIVA

Un adjunto viaja al modelo **solo** si se cumplen las cuatro condiciones, todas
positivas y comprobables:

1. el mensaje tiene un **WAMID no vacío**;
2. el **motor de comprobantes se ejecutó**;
3. hay un **veredicto para exactamente ese WAMID**;
4. el veredicto es explícitamente **`not_payment_proof`**.

Cualquier otra cosa —duda, error, silencio, flag apagado, puerto ausente,
identidad ausente— retiene los bytes.

### Por qué no es una lista de prohibidos

La primera versión calculaba qué WAMIDs eran comprobantes y les quitaba los
bytes. Una auditoría encontró dos agujeros, y los dos eran **el mismo agujero
visto desde dos sitios**: la puerta solo podía retener lo que había conseguido
clasificar.

- Una imagen **sin WAMID** nunca llega al motor —no hay clave con la que
  reclamarla— así que no entraba en la lista de retenidos, y pasaba. Se demostró
  con una sonda: `resolveImage` llamado, `input_image` construido, base64 en la
  petición al modelo.
- Con la captura apagada o sin el puerto cableado, la lista salía **vacía** y
  pasaban todas.

En los dos casos la puerta autorizaba **por ausencia de información**, que es
exactamente al revés de como debe fallar un control de privacidad. Ahora lo que
no está autorizado no pasa, y no hay una lista de casos que alguien pueda dejar
incompleta.

### Y dentro de esa política, qué cuenta como pago

```ts
esComprobante = !(method === 'unresolved' && routingException === null)
```

| Enrutado | ¿Comprobante? | Por qué |
| --- | --- | --- |
| `single_open_qr_order` | **sí** | hay un pedido esperando cobro |
| `reply_to_qr` | **sí** | el cliente señaló el pedido |
| `ambiguous` | **sí** | hay **varios** pagos posibles, no ninguno |
| `duplicate` | **sí** | un reenvío sigue siendo el comprobante |
| `unresolved` + excepción | **sí** | sabemos a cuál iba; ese pedido ya no cobra |
| `unresolved` sin excepción | no | no hay ningún pedido al que esto pudiera ir |

### Por qué la excepción de enrutado también cuenta

Es el caso que rompe la regla ingenua. Si la puerta mirara solo `method`, este
escenario mandaría el comprobante a OpenAI:

> El operador acepta el pago. El cliente, por costumbre, reenvía el mismo
> comprobante. Ahora `hasAcceptedPayment` es `true`, ningún pedido admite pago,
> y `method` cae a `unresolved` — pero `routingException` dice
> `payment_already_accepted`: sabemos exactamente a qué pedido iba.

Lo mismo con `closed_order`, `expired_target` y `signal_conflict`.

### El falso positivo que se acepta a propósito

Un cliente con un pedido QR abierto que manda una foto de su comida —"¿es esto lo
que pedí?"— cae del lado de `payment_proof` y el agente no la verá.

Es deliberado. Mientras hay un cobro en curso, "el cliente mandó una imagen"
significa comprobante en la práctica totalidad de los casos, y equivocarse hacia
el otro lado manda datos bancarios a un tercero. Se prefiere un agente que
responde solo por el texto a un agente que ve de más.

Fuera de esa ventana —sin pedidos, o con pedidos que no son por QR— las imágenes
normales siguen llegando al agente exactamente como antes.

## Qué se retiene y qué no

Se retienen **los bytes**, no el mensaje.

| | Cambia |
| --- | --- |
| Captura y almacenamiento del comprobante | **no** |
| Flujo de pago y dashboard | **no** |
| Persistencia del entrante (`agent_messages`) | **no** |
| Cuerpo de la respuesta del webhook | **no** |
| Texto del cliente en el turno | **no** |
| `message.image` / `message.document` en la copia que va al agente | **sí → `null`** |

Un burst de `["ya te pagué", <comprobante>]` conserva los dos mensajes, su orden
y su texto; lo único que se cae es la imagen. Se limpian `image` y `document` a
la vez: hoy un PDF jamás llega a Vision, pero la puerta no depende de que eso
siga siendo cierto.

## Fail closed

| Situación | Veredicto | ¿Sale la imagen? |
| --- | --- | --- |
| El motor clasifica `not_payment_proof` | explícito | **sí** |
| El motor clasifica `payment_proof` | explícito | no |
| El mensaje **no tiene WAMID** | no hay | no |
| Veredicto de **otro** WAMID | no aplica | no |
| El motor lanza (base inalcanzable) | `unknown` | no |
| El puerto no devuelve clasificación | ausente | no |
| **`paymentProofIntake` no cableado** | no se ejecutó | no |
| **`PAYMENT_PROOF_CAPTURE_ENABLED` ≠ `'true'`** | `unknown` | no |
| `storage_not_configured` | el que salga del enrutado | según veredicto |

**No existe un camino sin puerta.** Existe una puerta que, sin información, no
autoriza a nadie. El coste de retener de más es un turno que responde solo por el
texto; el coste del otro error es irreversible.

### La degradación segura del interruptor

`PAYMENT_PROOF_CAPTURE_ENABLED` gobierna si **capturamos**, no si es seguro
enseñar la imagen a un tercero. Con el flag apagado:

- los comprobantes **siguen llegando** por WhatsApp — lo único que deja de pasar
  es que los guardemos;
- no hay motor, luego no hay veredicto, luego **ningún adjunto viaja al modelo**;
- **el texto sigue funcionando con normalidad**, y el agente responde por él;
- el cuerpo del webhook **no afirma** que se haya almacenado nada (`failed`,
  `capture_disabled`).

La versión anterior devolvía aquí `not_payment_proof` razonando que "sin captura
no hay nada que proteger". Era falso, y por eso ahora devuelve `unknown`. El
guardián `intake-classification.test.ts` llama al `intakePaymentProof` **real**
para impedir que vuelva.

`storage_not_configured` sí clasifica: la comprobación del bucket va **después**
del enrutado precisamente porque, con la captura encendida y el bucket roto,
salir sin veredicto dejaba pasar el comprobante al modelo.

## Idempotencia

La puerta se construye por **WAMID**, y el veredicto sale del estado de los
pedidos — no de si esta ejecución concreta ganó el claim. Por eso:

- un **reintento del webhook** produce la misma puerta;
- el **worker de recovery** recogiendo la fila produce la misma puerta;
- `already_captured`, `in_progress` y `lost_claim` retienen igual que `captured`.

Si la puerta dependiera de haber ganado el claim, el segundo envío del mismo
archivo se le colaría al modelo.

## Dónde está

| Archivo | Qué hace |
| --- | --- |
| `src/lib/payment-proof/agent-gate.ts` | módulo **puro**: la política y la lista de autorizados |
| `src/lib/payment-proof/intake-service.ts` | calcula el veredicto con los mismos candidatos que ya lee para enrutar |
| `src/lib/webhook/kapso.ts` | construye la lista de autorizados y la aplica al burst y al ancla |

## Pruebas

- `src/lib/payment-proof/agent-gate.test.ts` — la regla, con decisiones que salen
  de `decideAssociation` **de verdad**, no escritas a mano.
- `src/lib/webhook/proof-agent-gate.test.ts` — la cadena entera desde
  `processClaimedEvent` hasta el `runAgentTurn` **real** del core, con el
  resolutor de media y el modelo espiados. Ahí se afirma lo que importa:
  `resolveImage` no se llama, no se construye ninguna parte `input_image`, y el
  dump de lo que viajó al modelo no contiene `base64`.

Cubren los nueve escenarios pedidos: comprobante único, comprobante + texto, dos
comprobantes seguidos, duplicado, asociación ambigua, imagen normal sin pedido QR
abierto, PDF, reintento del webhook, y la evidencia explícita de cero
`input_image` y cero `resolveImage`.

`store: false` en el adaptador de OpenAI **se conserva sin cambios**.
