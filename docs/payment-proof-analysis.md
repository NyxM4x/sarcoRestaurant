# Análisis automático del comprobante (0025)

Filtro previo a la revisión humana. Lee la imagen del comprobante que manda el
cliente y contrasta **la cuenta destino, el titular, el monto, el número de
transacción y la hora** con lo que debería decir.

## Qué NO hace

Es lo primero porque es lo que define el diseño:

- **No acepta ni rechaza ningún pago.** Ni uno. La decisión sigue siendo de la
  persona que mira la pantalla.
- **No oculta el comprobante ni bloquea ningún botón.** El pedido llega a cocina
  exactamente igual que antes y el flujo continúa sin cambios.
- **No es visible como "una IA".** Lo único que aparece es un aviso corto junto
  a la nota de cocina cuando hay algo que mirar.

Un falso positivo cuesta que alguien mire dos veces un pago bueno. Un rechazo
automático equivocado insulta por WhatsApp y al instante a un cliente que sí
pagó. Por eso solo marca.

## Cómo funciona

Tres piezas, y la frontera entre ellas es deliberada:

| Pieza | Archivo | Qué hace |
|---|---|---|
| Lectura | `src/lib/payment-proof/analysis-vision.ts` | Convierte la imagen en hechos. Nada más. |
| Juicio | `src/lib/payment-proof/analysis.ts` | Decide si esos hechos cuadran. Puro y probado. |
| Escritura | `src/lib/payment-proof/analysis-data-source.ts` | Guarda el veredicto y sus motivos. |

**El modelo no emite el veredicto.** Leer "Bs 20" en una imagen es percepción;
decidir que Bs 20 para un pedido de Bs 48 es sospechoso es una regla del negocio,
y una regla del negocio tiene que poder leerse, discutirse y probarse sin gastar
un token. Si el veredicto viniera del modelo, dos comprobantes idénticos podrían
recibir respuestas distintas y nadie podría explicar por qué saltó una alerta.

**Al lector no se le dice lo que esperamos encontrar.** El prompt no menciona la
cuenta ni el monto del pedido. Un modelo al que se le enseña la respuesta
correcta tiende a verla: dile que la cuenta acaba en 4471 y leerá 4471 donde
pone 4477 — justo el dígito que cambia el retoque.

### Cuándo corre

Dentro de `intakePaymentProof`, **después** de que el comprobante esté guardado,
asociado a su intento y visible en cocina. Reutiliza los bytes que la captura ya
descargó. Cualquier fallo —modelo caído, respuesta ilegible, clave mal puesta—
deja el comprobante exactamente como estaba.

## Qué detecta

| Motivo | Qué significa |
|---|---|
| `account_mismatch` | La cuenta que recibe el dinero no es la nuestra |
| `holder_mismatch` | El titular que cobra no es el nuestro |
| `amount_short` | Pagó menos de lo que debía |
| `amount_over` | El monto no es el de este pedido |
| `reference_reused` | Ese número de transacción ya se usó en otro comprobante |
| `stale_receipt` | El comprobante es de otro momento (más de 6 h de desfase) |
| `not_a_receipt` | La imagen no es un comprobante |
| `unreadable` | No se pudo leer lo suficiente. **No es una acusación.** |

El número de transacción es el dato más valioso: el hash del contenido (0021)
reconoce el *mismo archivo* reenviado, pero no una captura nueva del mismo pago
—otro recorte, otro brillo, otro teléfono—, que es el reenvío que de verdad se
intenta. El número del banco sí.

## Encenderlo

1. Aplicar la migración `supabase/migrations/0025_payment_proof_analysis.sql`.
2. Rellenar en el entorno:

```
PAYMENT_PROOF_ANALYSIS_ENABLED=true
PAYMENT_PROOF_ACCOUNT_NUMBER=...
PAYMENT_PROOF_ACCOUNT_HOLDER=...
PAYMENT_PROOF_ACCOUNT_HOLDER_ALIASES=...|...
PAYMENT_PROOF_ACCOUNT_BANK=...
OPENAI_API_KEY=...          # ya existe si el agente está encendido
```

**Los datos van tal como salen IMPRESOS en el comprobante que recibe el
cliente**, no como figuran en el contrato del banco. Si no coinciden con lo
impreso, el análisis marcará como sospechoso cada pago legítimo — y una alerta
que salta siempre se deja de leer en dos días.

Sin cuenta ni titular configurados, el análisis **no corre** aunque el
interruptor esté en `true`: sin patrón contra el que comparar, un veredicto "ok"
sería un aprobado que nadie ha dado.

## Calibrarlo

El único punto que hay que ajustar con comprobantes reales delante es el
`PROOF_READER_PROMPT` de `analysis-vision.ts`, y solo si un banco concreto pinta
los datos de forma que el lector no reconoce. Para comprobarlo:

1. Con el análisis encendido, mirar `payment_proofs.analysis_reasons` y
   `analysis_amount` de unos cuantos pagos **buenos**.
2. Si salen `unreadable` o `account_mismatch` en pagos legítimos, el prompt no
   está encontrando el campo: hay que nombrarlo como lo llama ese banco
   ("Cuenta destino", "Beneficiario", "Para", "Cuenta abonada"…).
3. Si el titular falla, casi siempre se arregla añadiendo el alias en
   `PAYMENT_PROOF_ACCOUNT_HOLDER_ALIASES` — sin tocar código.

El coste es de una llamada de visión por comprobante recibido.
