import type { ProvenanceMessage } from '@/lib/kapso/channel/provenance';
import type { AssociationDecision } from './association';

/**
 * LA PUERTA DETERMINÍSTICA — los adjuntos no viajan a OpenAI salvo permiso.
 *
 * ── El problema que resuelve ────────────────────────────────────────────────
 *
 * El flujo capturaba el comprobante y, acto seguido, dejaba LA MISMA imagen
 * dentro del burst que se le pasa a `runAgentTurn`. El agente la descargaba, la
 * convertía en `input_image` y la mandaba a OpenAI. Nadie lo había decidido: era
 * el efecto de que las dos rutas —captura y turno— recorren la misma lista de
 * mensajes entrantes y ninguna sabía de la otra.
 *
 * La foto de un comprobante bancario lleva nombre, banco, número de cuenta y a
 * menudo el saldo. El agente no responde sobre pagos: de eso se encargan el
 * panel y una persona.
 *
 * ── AUTORIZACIÓN POSITIVA, no lista de excepciones ─────────────────────────
 *
 * La primera versión de esta puerta era una lista de RETENIDOS: se calculaba
 * qué WAMIDs eran comprobantes y se les quitaban los bytes. Una auditoría
 * encontró dos agujeros, y los dos eran el MISMO agujero visto desde dos sitios:
 * la puerta solo podía retener lo que había conseguido clasificar.
 *
 *   · Una imagen SIN WAMID nunca llegaba al motor de comprobantes —no hay clave
 *     con la que reclamarla— así que no entraba en la lista de retenidos… y por
 *     tanto pasaba. Se demostró con una sonda: `resolveImage` llamado,
 *     `input_image` construido, base64 en la petición al modelo.
 *   · Con `PAYMENT_PROOF_CAPTURE_ENABLED` apagado, o sin el puerto de captura
 *     cableado, la lista de retenidos salía VACÍA y pasaban todas.
 *
 * En los dos casos la puerta autorizaba por AUSENCIA de información, que es
 * exactamente al revés de como debe fallar un control de privacidad.
 *
 * Ahora la lista es de AUTORIZADOS. Un adjunto viaja al modelo solo si se
 * cumplen las cuatro condiciones, todas positivas y comprobables:
 *
 *   1. el mensaje tiene un WAMID no vacío;
 *   2. el motor de comprobantes se ejecutó;
 *   3. hay un veredicto para EXACTAMENTE ese WAMID;
 *   4. el veredicto es explícitamente `not_payment_proof`.
 *
 * Cualquier otra cosa —duda, error, silencio, flag apagado, puerto ausente,
 * identidad ausente— retiene los bytes. No hay una lista de casos que bloquear
 * que alguien pueda dejar incompleta: lo que no está autorizado, no pasa.
 *
 * ── Qué se retiene y qué no ─────────────────────────────────────────────────
 *
 * Se retienen LOS BYTES, no el mensaje. El texto del cliente sigue viajando al
 * agente, el mensaje sigue persistido con su WAMID, el comprobante se sigue
 * capturando y almacenando, y el panel no cambia.
 */

/**
 * Veredicto del motor determinístico sobre un adjunto entrante.
 *
 * `unknown` NO es un tercer estado teórico: es lo que queda cuando el motor no
 * llegó a pronunciarse —una excepción, la base inalcanzable, la captura
 * apagada, un puerto que no devolvió clasificación—. No autoriza nada.
 */
export type ProofClassification = 'payment_proof' | 'not_payment_proof' | 'unknown';

/**
 * ¿Este enrutado significa que el archivo llegó COMO UN PAGO?
 *
 * La regla es el complemento exacto de "no había ningún pedido esperando
 * cobro": solo `unresolved` SIN excepción de enrutado describe una imagen
 * normal.
 *
 * ── Por qué la excepción de enrutado también cuenta ─────────────────────────
 *
 * `unresolved` a secas significa que no hay ningún pedido al que esto pudiera
 * ir: el cliente mandó una foto y no tiene nada pendiente de pagar.
 *
 * Pero `unresolved` CON `routingException` significa lo contrario: sabemos
 * exactamente a qué pedido iba, y ese pedido ya no admite pagos —vencido,
 * cerrado, o con el pago ya aceptado—. El caso más común es el más delicado: el
 * cliente reenvía su comprobante después de que el operador ya lo aceptó. Ahí
 * `method` vale `unresolved`, y si la puerta mirara solo el método, ese
 * comprobante quedaría autorizado.
 *
 * ── El falso positivo que se acepta a propósito ─────────────────────────────
 *
 * Un cliente con un pedido QR abierto que manda una foto de su comida —"¿es
 * esto lo que pedí?"— NO queda autorizado y el agente no la verá. Es
 * deliberado: mientras hay un cobro en curso, "el cliente mandó una imagen"
 * significa comprobante en la práctica totalidad de los casos, y equivocarse
 * hacia el otro lado manda datos bancarios a un tercero. Se prefiere un agente
 * que responde solo por el texto a un agente que ve de más.
 */
export function isProofBearing(decision: AssociationDecision): boolean {
  return !(decision.method === 'unresolved' && decision.routingException === null);
}

/** Traduce un enrutado a la clasificación que entiende la puerta. */
export function classifyForAgentGate(decision: AssociationDecision): ProofClassification {
  return isProofBearing(decision) ? 'payment_proof' : 'not_payment_proof';
}

/**
 * ¿Este veredicto AUTORIZA que los bytes salgan hacia el modelo?
 *
 * Solo un `not_payment_proof` explícito. Escrito como comparación positiva a
 * propósito: `!== 'payment_proof'` habría autorizado también a `unknown`, que
 * es justo el fallo que se está corrigiendo.
 */
export function authorizesVision(classification: ProofClassification): boolean {
  return classification === 'not_payment_proof';
}

/**
 * La lista de AUTORIZADOS: WAMIDs cuyos bytes pueden llegar al modelo.
 *
 * Un conjunto de identificadores de mensaje y nada más. No lleva la imagen, ni
 * el teléfono, ni el veredicto: lo único que necesita saber quien la aplica es
 * si este mensaje concreto está dentro.
 */
export type VisionAllowlist = ReadonlySet<string>;

/**
 * Lista vacía: NADIE autorizado.
 *
 * Es el valor por defecto cuando el motor de comprobantes no se ejecutó —el
 * puerto no está cableado—, y significa exactamente lo que debe significar:
 * ningún adjunto viaja. No existe un camino que "no tenga puerta"; existe una
 * puerta que no autoriza a nadie.
 */
export const EMPTY_VISION_ALLOWLIST: VisionAllowlist = new Set<string>();

export interface ProofGateEntry {
  /** WAMID del mensaje entrante que traía el adjunto. */
  sourceMessageId: string;
  classification: ProofClassification;
}

/**
 * Construye la lista de autorizados a partir de lo que dijo el motor.
 *
 * Solo entra un WAMID no vacío con veredicto explícito `not_payment_proof`. Un
 * WAMID vacío se descarta antes de mirar el veredicto: autorizar la cadena
 * vacía dejaría pasar a cualquier mensaje sin identidad.
 *
 * IDEMPOTENTE por WAMID: la misma entrega reprocesada —un reintento del webhook,
 * el worker de recovery recogiendo la fila, dos entregas de Kapso del mismo
 * evento— produce la MISMA lista, porque la clave es el WAMID y el veredicto
 * sale del estado de los pedidos, no de si esta captura concreta ganó el claim.
 * Un `already_captured` autoriza exactamente igual de poco que un `captured`.
 */
export function buildVisionAllowlist(entries: readonly ProofGateEntry[]): VisionAllowlist {
  const allowlist = new Set<string>();
  for (const entry of entries) {
    if (entry.sourceMessageId === '') continue;
    if (authorizesVision(entry.classification)) allowlist.add(entry.sourceMessageId);
  }
  return allowlist;
}

/**
 * ¿Puede este mensaje concreto mandar sus bytes al modelo?
 *
 * Exige identidad Y permiso, en ese orden. Un mensaje sin WAMID no se busca
 * siquiera: no hay nada con lo que buscarlo, y "no encontrado" tiene que
 * significar "no autorizado".
 */
export function isVisionAuthorized(
  message: ProvenanceMessage,
  allowlist: VisionAllowlist,
): boolean {
  const wamid = message.providerMessageId;
  if (wamid === null || wamid === '') return false;
  return allowlist.has(wamid);
}

/**
 * Devuelve el mensaje SIN sus adjuntos salvo que esté autorizado.
 *
 * No muta: devuelve una copia. El original sigue intacto para la captura, la
 * persistencia y el cuerpo de la respuesta — la puerta solo afecta a la copia
 * que viaja al agente.
 *
 * Un mensaje sin adjuntos vuelve TAL CUAL aunque no esté autorizado: la puerta
 * habla de bytes, no de mensajes, y el texto no necesita permiso de nadie.
 *
 * Se limpian `image` y `document` a la vez. Hoy el agente solo lee `image` y un
 * PDF jamás llega a Vision, pero la puerta no depende de que eso siga siendo
 * cierto: el día que alguien cablee documentos al modelo, ya estarán retenidos.
 */
export function withholdAttachments(
  message: ProvenanceMessage,
  allowlist: VisionAllowlist,
): ProvenanceMessage {
  if (message.image == null && message.document == null) return message;
  if (isVisionAuthorized(message, allowlist)) return message;
  return { ...message, image: null, document: null };
}

/**
 * Aplica la puerta a un burst entero, conservando el ORDEN y la longitud.
 *
 * Ningún mensaje desaparece: un comprobante con caption sigue siendo un mensaje
 * del cliente y su texto sigue contando para el turno. Lo único que se cae son
 * los bytes.
 */
export function withholdAttachmentsFromBurst(
  messages: readonly ProvenanceMessage[],
  allowlist: VisionAllowlist,
): { messages: readonly ProvenanceMessage[]; withheld: number } {
  let withheld = 0;
  const out = messages.map((message) => {
    const gated = withholdAttachments(message, allowlist);
    if (gated !== message) withheld += 1;
    return gated;
  });
  // Sin retenciones se devuelve el array original: no hay copia que justificar.
  return withheld === 0 ? { messages, withheld: 0 } : { messages: out, withheld };
}
