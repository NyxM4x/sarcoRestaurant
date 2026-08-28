# Retención de comprobantes — DISEÑO, sin implementar

> **Estado: propuesta. NO implementada, NO autorizada.**
>
> No se ha borrado ningún objeto, no se ha configurado ninguna lifecycle rule de
> R2 y no se ha escrito ningún `storage_expires_at`. Este documento existe para
> que la decisión se tome con todo delante, y **requiere autorización separada**
> —y contable— antes de tocar nada.

## El problema

Hoy los comprobantes se guardan en R2 y no caducan nunca. Cada archivo es la
imagen o el PDF de un movimiento bancario de un cliente real: su nombre, su
banco, su número de cuenta y muchas veces su saldo. Un bucket que solo crece es
un bucket cuyo peor día es cada vez peor.

Guardarlos indefinidamente no es una decisión que nadie haya tomado: es lo que
pasa cuando no se decide.

## Lo que ya existe y no hay que inventar

| Pieza | Estado |
| --- | --- |
| `payment_proofs.storage_expires_at timestamptz` | **ya está en la tabla** (0021), hoy siempre `NULL` |
| Key particionada `payment-proofs/<yyyy>/<mm>/<uuid>.<ext>` | ya |
| Namespace propio (`PROOF_NAMESPACE`) | ya |
| Acceso solo por endpoint con sesión, sin URLs firmadas | ya |
| Metadatos, decisiones y hashes en Postgres, no en R2 | ya |

La partición por mes y el namespace propio son justo lo que permite una
lifecycle rule acotada. No hace falta migración de esquema.

## Propuesta

### 1. Noventa días de retención del archivo bruto

**Sujeto a aprobación contable.** 90 días es una propuesta, no un hecho: quien
tiene que decir cuánto hay que conservar un respaldo de cobro es contabilidad,
no ingeniería. El número puede subir; lo que no debe seguir es en "para
siempre por omisión".

El plazo se cuenta desde `storage_stored_at`, no desde `received_at`: lo que
caduca es **el objeto**, y el objeto empieza a existir cuando se guardó.

### 2. `storage_expires_at` deja de ser nulo

Se sella en el mismo `markStored` que cierra la captura, dentro del CAS que ya
existe. Así:

- ningún comprobante nuevo nace sin fecha de caducidad;
- la fecha es **un dato de la fila**, no una regla escondida en la consola de
  Cloudflare;
- se puede consultar "qué se va a borrar el mes que viene" con un `SELECT`.

Para los comprobantes **ya almacenados** (que hoy tienen `NULL`), un backfill
explícito y revisable —no un `UPDATE` a ciegas—, y solo después de que
contabilidad fije el plazo.

### 3. La UI dice "archivo expirado por política"

Cuando `storage_expires_at` ya pasó, el panel **sigue mostrando el comprobante**
—su fila, su pedido, su decisión, su hash— y en lugar del archivo muestra un
estado explícito:

> **Archivo expirado por política de retención** · almacenado el 12/05/2026 ·
> expirado el 10/08/2026

Esto no es cosmético: es la diferencia entre "esto se borró porque tocaba" y
"esto se perdió". La segunda lectura es la que hace que nadie vuelva a confiar
en el panel.

El endpoint de archivo (`/api/dashboard/proofs/file`) devuelve un 410 saneado
—`gone`— en vez de intentar el `GetObject` y traducir un 404 de R2 en un error
genérico.

### 4. Lifecycle de R2 acotada al prefijo de comprobantes

```text
Regla:   expirar objetos
Prefijo: payment-proofs/          ← EXACTAMENTE este, nunca la raíz
Edad:    90 días desde la creación del objeto
```

El prefijo es la parte que no se negocia. Una regla sin prefijo, o con un
prefijo más ancho, alcanza cualquier otra cosa que llegue a vivir en ese bucket.

**La lifecycle rule es la red, no la fuente de verdad.** La fuente de verdad es
`storage_expires_at`. Que R2 borre el objeto un poco antes o un poco después no
puede cambiar lo que el panel dice, y por eso la UI mira la columna y no el
resultado de pedir el archivo.

### 5. Lo que NO caduca

Se conservan **independientemente del archivo**, sin plazo:

- la fila de `payment_proofs` entera;
- la asociación (`order_id`, `attempt_id`, `association_method`,
  `routing_exception`);
- `content_sha256` y `duplicate_of_id` — el hash sigue detectando reenvíos del
  mismo archivo aunque el archivo ya no esté;
- la decisión del operador y su `payment_attempts`;
- `declared_mime_type` / `verified_mime_type`, `safe_filename`,
  `storage_stored_at`, `storage_expires_at`.

O sea: **se pierde la imagen, no la trazabilidad.** Se puede seguir respondiendo
"¿este pedido se pagó, quién lo aceptó y cuándo?" y "¿este archivo ya había
llegado antes?" para siempre.

### 6. Legal hold

Si hiciera falta —una disputa, un requerimiento—, un comprobante concreto debe
poder quedar exento. Diseño mínimo:

- `payment_proofs.legal_hold_at timestamptz null` (nueva columna);
- con `legal_hold_at` no nulo, `storage_expires_at` se pone a `NULL` y la fila
  queda fuera de cualquier barrido;
- la lifecycle rule de R2 **no puede** respetar esto por sí sola (no conoce la
  base), así que un legal hold obliga a **copiar el objeto a un prefijo exento**
  —p. ej. `payment-proofs-hold/`— fuera del alcance de la regla;
- ponerlo y quitarlo se registra, con quién y cuándo.

Es la parte más incompleta del diseño a propósito: sin un caso real que fije el
requisito, cualquier cosa más elaborada es adivinar.

## Orden de implementación, si se autoriza

El orden importa, porque los primeros pasos son reversibles y los últimos no:

1. Sellar `storage_expires_at` en las capturas **nuevas**. No borra nada.
2. UI de "archivo expirado por política", leyendo la columna. No borra nada.
3. Observar un ciclo completo: comprobar que las fechas salen donde deben.
4. Backfill de las filas antiguas, revisado.
5. **Solo entonces** la lifecycle rule de R2. Es el único paso que destruye.

Nada de esto se ejecuta sin autorización explícita y sin que contabilidad haya
fijado el plazo.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| El plazo contable real es mayor que 90 días | No implementar el paso 5 antes de tener el número por escrito |
| La regla de R2 se crea sin prefijo | Revisión a cuatro ojos; el prefijo va en el runbook, no en la memoria de nadie |
| Un legal hold llega después de que el objeto expiró | Ninguna: por eso el legal hold necesita existir **antes** que el borrado |
| La UI muestra "expirado" por un fallo de R2 | La UI mira `storage_expires_at`, no el resultado de pedir el archivo |
