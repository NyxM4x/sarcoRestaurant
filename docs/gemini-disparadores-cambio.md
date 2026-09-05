# Prompt para Gemini — disparadores de "quiero modificar mi pedido"

> Este archivo **es** el prompt. Copialo entero (Ctrl+A, Ctrl+C) y pegalo en
> Gemini. No hace falta editar nada salvo la lista de productos del final, si
> la carta cambió.

---

## ROL

Sos analista de lenguaje coloquial de WhatsApp en **Santa Cruz de la Sierra,
Bolivia**. Tu trabajo es ampliar los **detectores determinísticos** (expresiones
regulares y listas de palabras) con los que un bot de pedidos de comida decide
qué quiso decir un cliente. No escribís código de aplicación ni diseñás prompts:
producís **frases reales y patrones**.

Escribí en español. Nada de relleno: cada frase que propongas tiene que ser algo
que una persona realmente tipearía en WhatsApp a la medianoche, con apuro, sin
tildes y con errores.

---

## EL NEGOCIO

Un local de trancapechos y hamburguesas que atiende **de noche, por WhatsApp**.
El cliente recibe un botón, abre un menú web, arma su pedido, manda su
ubicación, recibe su total y un QR, paga y manda la foto del comprobante. Un bot
lo atiende de punta a punta: **que un humano tenga que entrar al chat se
considera un fracaso del producto**, no una solución.

Quien escribe es gente apurada tecleando en el celular: sin tildes, con el
producto partido en dos ("tranca pecho"), pegado ("2com todo"), con números en
dígito o en letra, y muchas veces mandando tres mensajes cortos seguidos en vez
de uno solo.

---

## EL PROBLEMA QUE VAS A RESOLVER

Después de que el cliente ya armó su pedido y tiene su total delante, lo que
escribe puede ser una de estas tres cosas. Distinguirlas es todo el juego:

| # | Qué es | Ejemplos | Qué hace el sistema |
|---|---|---|---|
| **A** | **Preferencia de cocina** — no cambia ni una línea ni un centavo | "sin cebolla", "con harta mayonesa", "que no lleve locoto" | se anota en la comanda y se le contesta que sí |
| **B** | **Cambio de líneas** — cambia el total, el QR y lo que se cocina | "mandame 2 sodas mas", "que sean 3", "no puse la gaseosa" | se le manda el botón **"Cambiar mi pedido"**, que reabre SU pedido con el carrito ya cargado |
| **C** | **Anuncio de cambio** — pide cambiar pero todavía no dice qué | "puedo aumentar", "me olvide de algo", "quiero corregir" | el mismo botón que B |

**La asimetría de los errores es la regla más importante de todo el sistema:**

- Una **preferencia** tratada como cambio → el cliente recibe un botón que no
  necesitaba. Molesto, recuperable, cuesta cero.
- Un **cambio** tratado como preferencia → "que sean 3" queda escrito en las
  notas de la comanda, el total sigue siendo el de 2, y o cobramos de menos o el
  cliente recibe menos de lo que pagó. **Cuesta dinero y un cliente.**
- Un **cambio no detectado** → el bot le contesta cualquier otra cosa (casi
  siempre "mandanos tu comprobante"), el cliente insiste, se frustra y termina
  armando un SEGUNDO pedido. El negocio se encuentra con dos comandas del mismo
  cliente. **Es el peor desenlace de los tres.**

En la duda, **nunca es una preferencia**.

---

## CÓMO DECIDE EL SISTEMA HOY (esto es literal, no un resumen)

### 1. Normalización previa

Todo mensaje se normaliza ANTES de evaluar cualquier patrón:

```
normalize('NFD')  →  se eliminan tildes y diacríticos
toLowerCase()
se reemplazan   ¿ ? ¡ ! . , ; : " ' ( )   por espacios
se colapsan los espacios múltiples
```

Es decir: `¿Que sean 3, porfa?` llega a los patrones como `que sean 3 porfa`.
**Todas tus regex tienen que escribirse sobre ese texto ya normalizado: sin
tildes, todo en minúsculas, sin puntuación.**

### 2. El catálogo se inyecta, no se escribe

Los nombres de los productos activos se leen de la base en tiempo de ejecución.
Cada nombre se parte en palabras de **4 letras o más**: `Gaseosa 2 L` aporta el
término `gaseosa`; `Trancapecho` aporta `trancapecho`. La comparación es por
**palabra completa** (más el plural en `-s` / `-es`), nunca por subcadena.

### 3. Las tres preguntas, en código real

**A — ¿Es una preferencia de cocina?**
Exige TODO esto a la vez: coincidir con una marca de preferencia, **no** tener
ningún dígito, **no** tener cantidad en letra, y **no** nombrar ningún producto
del catálogo ni ningún genérico.

```
MARCAS_DE_PREFERENCIA =
/(^|\s)(sin|con|extra|aparte|bien|poca|poco|poquito|harta|harto|mucha|mucho|nada de|aumenta|aumentame|aumenteme|agrega|agregame|agregue|agregeme|aumente|anade|anadime|ponle|pongale|ponme|pongame|coloca|colocale|coloque|colocar|echale|echele|(que|q|ke) (no )?(lleve|tenga|venga|sea|vaya))(\s|$)/

CANTIDADES_EN_LETRA =
/(^|\s)(un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|media|medio|otra|otro|otras|otros|mas)(\s|$)/

GENERICOS_DE_PRODUCTO = combo, combos, promo, promos, promocion, bebida,
bebidas, gaseosa, gaseosas, refresco, refrescos, jugo, jugos, plato, platos,
porcion, porciones, racion, unidad, unidades
```

**B — ¿Pide cambiar las líneas del pedido?**
Exige DOS piezas: que nombre algo que se venda (catálogo o genérico) **Y**
además una marca de cambio o una cantidad pegada a una palabra.

```
MARCAS_DE_CAMBIO =
/(^|\s)(sin|quita|quitame|quiteme|saca|sacame|saque|elimina|cambia|cambiame|cambieme|agrega|agregame|agregue|aumenta|aumentame|aumenteme|anade|anadime|sumale|mandame|mandeme|manda|envia|enviame|falta|falto|faltaba|olvide|olvidaste|no puse|me equivoque|quiero tambien|tambien quiero)(\s|$)/

CANTIDAD_CON_COSA =
/(^|\s)(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|otra|otro)\s+[a-z]{3,}/
```

**C — ¿Anuncia un cambio sin decir todavía qué?**
No usa el catálogo: lo que lo define es la **ausencia** de producto. El verbo
tiene que **cerrar** la frase (antes se recortan las colas vacías). Si el
mensaje habla de algo que no es el contenido del pedido, se descarta.

```
ANUNCIO_DE_CAMBIO =
/(^|\s)(aumentar|agregar|anadir|sumar|incrementar|cambiar|corregir|modificar|rehacer|rearmar|armar|empezar|comenzar|quitar|sacar|eliminar|poner)(me|le|lo|la|los|las|selo|sela)?$/

ANUNCIO_DE_ERROR =
/(^|\s)(me equivoque|me equivoco|equivoque|equivocado|me falto|me falta|me olvide|se me olvido|olvide|no puse|puse mal|esta mal mi pedido|mi pedido esta mal)(\s|$)/

COLA_SIN_CONTENIDO (se recorta del final antes de mirar) =
algo, alguna cosa, una cosa, otra cosa, otras cosas, cosas, mas, un poco,
la cantidad, cantidad, mi pedido, el pedido, mi orden, la orden, pedido,
mi compra, de nuevo, denuevo, otra vez, nuevamente, todo, porfa, porfis,
porfavor, por favor, please, ahora, ahorita

FUERA_DEL_PEDIDO (si aparece, NO es anuncio de cambio) =
/(^|\s)(pagar|pago|pagos|pague|pagando|comprobante|qr|transferencia|deposito|recibo|efectivo|factura|envio|delivery|reparto|direccion|ubicacion|domicilio|numero|telefono|nombre|hora|demora|tiempo)(\s|$)/
```

### 4. El orden en que se pregunta (importa tanto como los patrones)

Para un cliente con un pedido abierto se evalúa en este orden, y **gana el
primero que dice que sí**:

```
1. ¿Pasa él a recogerlo?          → cambia a recojo
2. ¿Es preferencia de cocina?     → se ANOTA en la comanda    ← ojo con este
3. ¿Ya mandó comprobante?         → "ya lo tenemos, lo revisamos"
4. ¿Pide cambiar / lo anuncia?    → botón "Cambiar mi pedido"
5. ¿Falta su comprobante?         → "mandanos la foto"
6. cualquier otra cosa            → botón del menú
```

Dos consecuencias que ya mordieron:

- El paso **2 va antes que el 4**: una frase que dispare *preferencia* nunca
  llega a la puerta del cambio, aunque además fuese un cambio.
- El paso **3 va antes que el 4** a propósito: en cuanto hay un comprobante en
  revisión hay dinero contra un total concreto, y rearmar el pedido por debajo
  dejaría al cliente pagando una cosa y recibiendo otra. **Ese orden no se
  discute; el mensaje que recibe ese cliente sí.**

---

## EL CASO REAL QUE MOTIVA ESTE TRABAJO

Transcripción de una conversación de anoche (horas reales):

```
23:50  cliente  Quiero trancapecho
23:50  cliente  Me puede enviar a domicilio 2
23:51  bot      [botón del menú]
23:52  bot      Recibimos tu pedido #20. Ahora necesitamos tu ubicación.
23:53  cliente  [ubicación GPS]
23:53  bot      Pedido #20 · Comida Bs 36 · Delivery Bs 13 · Total Bs 49
                Escanea el QR y paga SOLO la comida: Bs 36
23:54  cliente  [FOTO del comprobante]      ← pagó el importe de TRES, no de dos
23:54  cliente  Que sean 3 tranca pecho
23:54  cliente  2com todo
                1sin Locoto
23:54  bot      Tu pedido #20 está guardado por Bs 49. Falta que nos mandes
                la foto del comprobante.
23:55  bot      Ya tenemos tu comprobante del pedido #20. Lo estamos revisando.
23:56  cliente  Pague de 3
23:56  bot      Ya tenemos tu comprobante del pedido #20. Lo estamos revisando.
23:57  cliente  ?
23:57  bot      Ya tenemos tu comprobante del pedido #20. Lo estamos revisando.
23:57  cliente  Listo
23:59  humano   entendimos, la proxima para que no se nos pierda algo tan
                importante puedes escribir quiero modificar mi pedido
```

**Qué pasó:** el cliente armó 2 en el menú, pagó el importe de 3 y avisó después
por chat. La cocina recibió una comanda de 2 con un pago de 3. Tuvo que entrar
una persona a resolverlo.

**Por qué ninguno de los tres detectores se activó** (verificado ejecutando el
código real, no supuesto):

| Mensaje | cambio | anuncio | preferencia | Por qué falló |
|---|---|---|---|---|
| `Que sean 3 tranca pecho` | no | no | no | el catálogo dice `trancapecho` (una palabra) y el cliente escribió `tranca pecho` (dos). La comparación es por palabra completa, así que **no nombra ningún producto**, y la puerta del cambio exige nombrarlo |
| `Que sean 3 trancapechos` | **SÍ** | no | no | escrito junto sí funciona: la diferencia entre detectar y no detectar es **un espacio** |
| `2com todo` / `1sin Locoto` | no | no | no | dígito pegado a la palabra; `locoto` no está en la carta como producto |
| `Pague de 3` | no | no | no | `pague` está en FUERA_DEL_PEDIDO, que lo descarta como anuncio; y no nombra producto |
| `?` | no | no | no | correcto: ahí no hay nada que leer |

Y un caso que el dueño escribió a mano probando el flujo, **peor que no detectar
nada**:

| Mensaje | cambio | anuncio | preferencia | Consecuencia |
|---|---|---|---|---|
| `me olvide agregame esto` | no | SÍ | **SÍ** | la preferencia se evalúa ANTES (paso 2): la frase se escribe tal cual en la comanda y se le contesta "listo, ya lo anotamos". El total no cambia. El cliente cree que su cambio quedó hecho. |

Otras frases que hoy no detecta nadie, todas de la misma familia —**corregir la
cantidad sin volver a nombrar el producto**—:

```
que sean 3          son 3 no 2          en realidad quiero 3
agregame 1 mas      aumentame uno       pague 54 pero puse 2
```

---

## TU TAREA

### 1. Frases reales

Producí **al menos 60 frases** que un cliente cruceño realmente escribiría en
este momento de la conversación (con el total y el QR ya delante), clasificadas
en A (preferencia), B (cambio de líneas) o C (anuncio). Cubrí explícitamente:

- corrección de cantidad **sin nombrar el producto**: "que sean 3", "son 2 no 1"
- el producto **partido, pegado o mal escrito**: "tranca pecho", "trankapecho",
  "hamburgesa", "gaseoza"
- el aviso **después de haber pagado de más o de menos**: "pague de 3",
  "deposite de mas", "transferi 54"
- el olvido: "me olvide", "se me paso", "no le puse", "falto algo"
- la ráfaga de mensajes cortos que en realidad son uno solo
- frases que **parecen** cambio y no lo son ("cuanto sale el trancapecho",
  "puedo pagar en efectivo", "me falta pagar", "cambio de direccion"), para que
  sirvan de casos negativos

### 2. Patrones nuevos

Proponé las **modificaciones concretas** a las regex y listas de arriba. Para
cada propuesta decí:

- qué patrón tocás y cómo queda escrito, completo y listo para pegar;
- qué frases nuevas captura;
- **qué frases que hoy funcionan bien podría romper** (obligatorio: una
  propuesta sin su lista de falsos positivos no sirve);
- en qué lado de la asimetría cae el error si te equivocás.

Prestá atención especial a tres huecos:

- **El producto escrito separado.** ¿Cómo se reconoce `tranca pecho` desde un
  catálogo que dice `trancapecho`, sin convertir la comparación en una búsqueda
  de subcadena (que rompería cosas como `solomillo` matcheando `lomito`)?
  Proponé una regla general, no un caso especial para este producto.
- **La cantidad sin producto.** "que sean 3" no nombra nada, pero es
  inequívocamente un cambio de líneas cuando el cliente ya tiene un pedido
  armado. ¿Qué forma tiene esa familia y cómo se separa de "son 3 cuadras" o
  "en 3 minutos"?
- **La colisión preferencia/cambio.** "me olvide agregame esto" dispara las dos.
  ¿Qué señal debería ganar, y cómo se escribe esa señal?

### 3. El caso del pago que no cuadra

"Pague de 3" llega cuando ya hay un comprobante en revisión, y por diseño ese
cliente **no** puede rearmar su pedido: hay dinero contra un total concreto.
Pero contestarle tres veces "ya tenemos tu comprobante" es lo que provocó el "?"
y la intervención humana.

Proponé **el texto exacto** que debería recibir: alguien que avisa que pagó por
algo distinto de lo que armó y cuyo pedido no se puede tocar automáticamente.
Una sola respuesta, en el tono del negocio (directo, cálido, sin emojis de más,
sin prometer nada que dependa de un humano), y que **cierre el turno** en vez de
invitar a insistir.

---

## RESTRICCIONES DURAS

1. **Todo es determinístico.** No hay ningún modelo de lenguaje leyendo estos
   mensajes: son regex y listas de palabras. No propongas "que el LLM decida".
2. **Sobre texto normalizado**: sin tildes, minúsculas, sin puntuación. Escribí
   `anadime`, no `añádeme`.
3. **El catálogo no se escribe a mano.** No propongas listas con los nombres de
   los productos: se leen de la base. Podés proponer reglas *sobre* el catálogo.
4. **Palabra completa, no subcadena.** Cualquier regla que matchee dentro de
   otra palabra produce falsos positivos y hay que justificarla.
5. **La duda nunca es una preferencia.** Ante una frase ambigua, el destino
   seguro es el botón de cambio.
6. **Nada de emojis** dentro de las regex.

---

## FORMATO DE SALIDA

```
## 1. Frases
| frase | clase (A/B/C) | por qué | ¿la detecta el sistema hoy? |

## 2. Patrones propuestos
### <nombre del patrón>
- regex completa:
- captura:
- riesgo (falsos positivos):
- lado del error:

## 3. Los tres huecos
(una sección por hueco, con la regla propuesta)

## 4. Copy para el pago que no cuadra
(el texto exacto, y una línea de por qué)
```

Empezá directamente por la sección 1. No repitas el enunciado ni resumas el
contexto.

---

## APÉNDICE — productos activos hoy

Actualizá esta lista si la carta cambió. Gemini la usa solo para escribir frases
realistas, no para proponer patrones con nombres dentro.

```
Trancapecho · Trancaburguer · Salchipapa · Hamburguesa · Papas fritas
Gaseosa 2 L · gaseosas personales
```
