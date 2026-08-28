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
| **Análisis del comprobante** | `src/lib/payment-proof/analysis*.ts`, migración `0025` | Lee la imagen con visión y contrasta cuenta, titular, monto y nº de transacción. **Es lo que se cruza con tu puerta** |
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

### Lo que más te puede afectar

**Una cuarta acción en el catálogo del agente.** `request_human` se suma a
`send_menu` / `get_menu_items` / `answer_directly`. Sigue tu contrato:
`NO_ARGUMENTS`, y `producesUserVisibleEffect: true` + `effectCompletesTurn: true`
— manda ella misma un texto fijo y cierra el turno.

> Se intentó primero dejar que el modelo redactara el «te paso con una persona».
> **No funciona**: la acción pausa la conversación y la barrera pre-send la
> encontraría activa, así que el turno moriría en `skipped_paused` y el cliente
> se quedaría sin nada — callado por el mismo mecanismo que pidió ayuda para él.

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

## 6. Estado

**2.977 tests en verde**, lint limpio, build correcto.

`main` local tiene **4 commits sin pushear** (`c21c2da`, `1379ac8`, `b5497f2`,
`d162cc7`). `a972738` y anteriores ya están en `origin/main`.

### Pendiente

- **Migraciones sin aplicar**: `0025` (análisis) y `0026` (numeración diaria).
  Sin la `0026` los pedidos siguen en `ORD-000021`.
- **Sin correr**: `npm run eval:selection`. Añadir una cuarta acción es lo más
  arriesgado de todo esto y solo el eval contra el modelo real dice si degradó
  la elección de `send_menu`. Cuesta tokens de verdad, por eso no se lanzó.
- **Tu recovery cron sigue sin desplegar** (lo dice tu propio doc). Mientras
  tanto, `WEBHOOK_ASYNC_ACK` no debería encenderse: sin despertador, un evento
  que se caiga a mitad queda huérfano.
- **Variables nuevas**: `AI_VISION_MODEL`, `TELEGRAM_HANDOFF_CHAT_ID`,
  `PAYMENT_PROOF_ANALYSIS_*`. Todas opcionales y apagadas por defecto.
- **Falta el dato del negocio**: la cuenta bancaria real (número, titular, cómo
  la escribe cada banco) para poder encender el analizador.

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
