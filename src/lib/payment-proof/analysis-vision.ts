/**
 * Lectura del comprobante con visión — módulo PURO (el modelo se INYECTA).
 *
 * Convierte una imagen en HECHOS: qué banco, qué cuenta recibió, a nombre de
 * quién, cuánto, cuándo y con qué número de transacción. Nada más. El juicio
 * —si eso cuadra o no— es de `analysis.ts`, y esa frontera es deliberada:
 * leer es una tarea de percepción y juzgar es una regla del negocio.
 *
 * ── Por qué NO se le dice lo que esperamos encontrar ────────────────────────
 *
 * El prompt no menciona la cuenta de Don Zarco, ni el titular, ni el monto del
 * pedido. Es lo contrario de lo que parece más listo, y es a propósito: un
 * modelo al que se le enseña la respuesta correcta tiende a verla. Dile que la
 * cuenta debería terminar en 4471 y leerá 4471 donde pone 4477, que es justo el
 * dígito que el retoque cambia.
 *
 * Leyendo a ciegas, lo que devuelve es lo que hay en la imagen. La comparación
 * la hace después un `===` que no tiene imaginación.
 *
 * ── Por qué se pide JSON y se valida con zod ────────────────────────────────
 *
 * La respuesta de un modelo es texto, y el texto de un modelo a veces trae una
 * disculpa, una explicación o unas comillas de más. Se valida como se valida
 * cualquier entrada externa —porque eso es lo que es— y una respuesta que no
 * encaja se descarta entera en vez de aprovecharse a medias: media lectura
 * produce media sospecha, que es peor que ninguna.
 */
import { z } from 'zod';
import type { AgentModel, AgentModelInput } from '@/lib/agent/core/model';
import type { ProofFacts } from './analysis';

/** Techo de la respuesta: es un JSON corto, no una redacción. */
export const PROOF_VISION_MAX_OUTPUT_TOKENS = 500;

/**
 * Timeout de UNA lectura. Corre dentro del webhook, así que no puede alargarse:
 * si el modelo tarda más, se abandona la lectura y el comprobante sigue su
 * camino sin análisis. Perder el análisis es molesto; perder el comprobante no.
 */
export const PROOF_VISION_TIMEOUT_MS = 15_000;

/**
 * Instrucción del lector.
 *
 * Escrita para que la respuesta "no lo sé" sea siempre barata: cada campo admite
 * `null`, y el prompt lo repite. Un modelo que siente que debe rellenar todos
 * los huecos inventa un número de cuenta, y un número de cuenta inventado
 * produce una acusación falsa contra un cliente real.
 */
export const PROOF_READER_PROMPT = `Eres un lector de comprobantes de pago bolivianos (transferencias y pagos por QR).

Mira la imagen y devuelve ÚNICAMENTE un objeto JSON, sin texto alrededor y sin bloques de código, con exactamente estas claves:

{
  "looksLikeReceipt": boolean,
  "legible": boolean,
  "bank": string | null,
  "destinationBank": string | null,
  "destinationAccount": string | null,
  "destinationHolder": string | null,
  "amount": number | null,
  "currency": string | null,
  "transactionRef": string | null,
  "paidAtLocal": string | null
}

Reglas:
- "looksLikeReceipt": true solo si la imagen es un comprobante, recibo o captura de una transferencia o pago. Una foto de comida, una conversación, un QR sin pagar o una captura de otra cosa es false.
- "legible": false si la imagen está tan borrosa, cortada u oscura que no puedes leer los datos del pago.
- "bank" es el banco o la app que EMITE el comprobante (el membrete de arriba).
- "destinationBank" es el banco que RECIBE el dinero ("banco destino", "del banco" junto a la cuenta de destino). Suele ser distinto del membrete. Si no aparece, null.
- "destinationAccount" y "destinationHolder" son de quien RECIBE el dinero (destino, beneficiario, "cuenta destino", "a la cuenta", "se acreditó a la cuenta", "para"), NUNCA de quien lo envía ("originante", "remitente", "cuenta de origen", "se debitó de", "enviado por", "realizado por"). Si la imagen solo muestra al remitente, deja ambos en null.
- En un pago con QR, quien cobra puede aparecer como "solicitante" o "beneficiario", y quien paga como "remitente": el solicitante del QR es el DESTINO.
- Si la imagen no separa origen y destino y solo hay un nombre junto al monto (por ejemplo en Yape), ese es el destino; la cuenta y el banco que figuren en los datos de la transacción son también los del destino.
- Copia la cuenta TAL COMO SE VE, incluidos asteriscos o guiones del enmascarado.
- "amount": solo el número, sin símbolo ni separador de miles. Usa punto decimal.
- "currency": "BOB" para bolivianos (Bs), "USD" para dólares.
- "transactionRef": el número de transacción, operación, comprobante o autorización.
- "paidAtLocal": fecha y hora del pago en formato "AAAA-MM-DDTHH:mm", hora local de Bolivia. Si falta la hora o el año, devuelve null.
- Si un dato no aparece en la imagen o no lo lees con seguridad, devuelve null en ese campo. NO adivines, NO completes y NO uses ejemplos.`;

/** El mensaje que se le manda al modelo: la instrucción y la imagen. */
export function buildProofReadInput(dataUrl: string): AgentModelInput[] {
  return [
    { role: 'system', content: PROOF_READER_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Lee este comprobante.' },
        // `high`: el número de cuenta y el monto son texto pequeño, y es
        // exactamente el texto del que depende todo lo demás.
        { type: 'input_image', image_url: dataUrl, detail: 'high' },
      ],
    },
  ];
}

/**
 * Forma esperada de la respuesta.
 *
 * Todo lo opcional se normaliza a `null`, y las cadenas vacías también: un
 * `""` que llegara como cuenta acabaría comparándose contra la nuestra y dando
 * `unknown` por el camino largo, cuando lo que significa es que no hay dato.
 */
const textoOpcional = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s.length > 0 ? s : null;
  });

const numeroOpcional = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    // Un modelo puede devolver "48,00" o "Bs 48.00" pese a lo que pida el
    // prompt. Se acepta lo que sea inequívocamente un número y se descarta el
    // resto: no se intenta interpretar "48 o 43".
    const limpio = v.replace(/[^\d,.-]/g, '').replace(',', '.');
    const n = Number(limpio);
    return limpio.length > 0 && Number.isFinite(n) ? n : null;
  });

const factsSchema = z.object({
  looksLikeReceipt: z.boolean(),
  legible: z.boolean(),
  bank: textoOpcional,
  destinationBank: textoOpcional,
  destinationAccount: textoOpcional,
  destinationHolder: textoOpcional,
  amount: numeroOpcional,
  currency: textoOpcional,
  transactionRef: textoOpcional,
  paidAtLocal: textoOpcional,
});

/**
 * Extrae el objeto JSON de la respuesta.
 *
 * Se recorta al primer `{` y al último `}` porque un modelo puede envolverlo en
 * ```json o precederlo de una frase. No es indulgencia con el formato: es que
 * descartar una lectura correcta por una valla de código sería tirar el trabajo
 * —y el coste— por un detalle de presentación.
 */
function recortarJson(text: string): string | null {
  const inicio = text.indexOf('{');
  const fin = text.lastIndexOf('}');
  if (inicio < 0 || fin <= inicio) return null;
  return text.slice(inicio, fin + 1);
}

/** Convierte la respuesta cruda en hechos. `null` si no es utilizable. */
export function parseProofFacts(text: string): ProofFacts | null {
  const json = recortarJson(text ?? '');
  if (json === null) return null;
  let crudo: unknown;
  try {
    crudo = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = factsSchema.safeParse(crudo);
  return parsed.success ? parsed.data : null;
}

export type ProofReadResult =
  | { ok: true; facts: ProofFacts; model: string }
  /**
   * No se pudo leer. El código es corto y sin datos: acaba en un log.
   *
   * `code` lleva lo que dijo el proveedor —`http_error.404`, `timeout`,
   * `not_configured`— y NO es un adorno: sin él, `model_error` significa a la
   * vez "la clave no vale", "ese modelo no existe para esta cuenta", "nos
   * pasamos de cuota" y "se cayó la red", que son cuatro problemas con cuatro
   * respuestas distintas.
   *
   * La noche del 03→04-09-2026 el análisis dejó de leer TODOS los comprobantes
   * y el log solo decía `model_error`: averiguar cuál de los cuatro era costó
   * una investigación entera contra la base y la API. Es la misma lección que
   * ya había aprendido el despacho del menú —"el STATUS HTTP viaja en el
   * código, no se tira"— sin aplicar aquí.
   */
  | { ok: false; error: 'model_error' | 'invalid_response'; code?: string };

/**
 * Lee un comprobante. Nunca lanza: un fallo del modelo no puede propagarse al
 * webhook que atiende a todos los clientes.
 */
export async function readProofFacts(
  model: AgentModel,
  dataUrl: string,
): Promise<ProofReadResult> {
  let res;
  try {
    res = await model.complete(buildProofReadInput(dataUrl), {
      maxOutputTokens: PROOF_VISION_MAX_OUTPUT_TOKENS,
      timeoutMs: PROOF_VISION_TIMEOUT_MS,
    });
  } catch {
    // El adaptador no lanza; llegar aquí es un fallo del entorno, no del modelo.
    return { ok: false, error: 'model_error', code: 'threw' };
  }
  if (!res.ok) {
    // El status viaja PEGADO al código, como en el ledger del menú: un 404 (ese
    // modelo no existe para esta cuenta) y un 429 (cuota o límite por minuto) se
    // arreglan en sitios distintos, y `model_error` a secas no los separa.
    const code = res.status === undefined ? res.error : `${res.error}.${res.status}`;
    return { ok: false, error: 'model_error', code };
  }
  const facts = parseProofFacts(res.text);
  if (facts === null) return { ok: false, error: 'invalid_response' };
  return { ok: true, facts, model: res.model };
}
