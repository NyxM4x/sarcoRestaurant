import { normalizeIntentText } from '@/lib/webhook/menu-intent';

/**
 * "Quiero hablar con una persona" — detección determinística, módulo PURO.
 *
 * ── Para qué ────────────────────────────────────────────────────────────────
 *
 * Es la LLAVE que abre la puerta de `handoff-gate.ts`. Ese umbral existe
 * porque el modelo derivaba conversaciones en su primer mensaje; pero hay un
 * caso en que derivar en el primer mensaje es exactamente lo correcto, y es
 * este. Alguien que pide una persona con todas las letras no tiene que
 * ganarse el derecho intercambiando tres mensajes con un bot que ya le dijo
 * que no quería.
 *
 * ── Por qué se reconoce aquí y no se le pregunta al modelo ─────────────────
 *
 * Al modelo se le sigue preguntando: es él quien elige `request_human`, y en
 * el eval acierta este caso 3 de 3. Lo que NO puede hacer es abrir la puerta,
 * porque entonces la puerta no serviría de nada — bastaría con que se
 * equivocara, que es justo lo que hace.
 *
 * Así que hay dos condiciones y las dos son necesarias: el modelo tiene que
 * elegir derivar Y el texto tiene que pedirlo, o el turno tiene que llevar
 * conversación suficiente. Una sola de las dos ya demostró no bastar.
 *
 * ── Cómo reconoce ──────────────────────────────────────────────────────────
 *
 * Mismo rigor y mismo normalizador que `webhook/delivery-quote-intent.ts`:
 * exige un verbo de CONTACTO y un sustantivo de PERSONA juntos. Ninguno basta
 * solo, y eso es toda la defensa:
 *
 *   · "una persona me dijo que tenían promo"  → persona sin contacto  → NO
 *   · "quiero hablar de mi pedido"            → contacto sin persona  → NO
 *   · "quiero hablar con una persona"         → las dos              → SÍ
 *
 * Un falso negativo aquí no rompe nada: el cliente simplemente pasa por el
 * umbral normal de cuatro mensajes, como todos los demás.
 */

/** Pedir contacto. Cubre "quiero hablar con", "pasame con", "necesito hablar". */
const CONTACTO =
  /\b(hablar|hablo|comunicar|comunicarme|contactar|pasame|paseme|pasarme|derivar|deriva|transferir|atiende|atienda|atiendan|atienden|atenderme)\b/;

/**
 * A quién quiere. Los sustantivos de trato humano y los del negocio.
 *
 * `repartidor` y `motoquero` quedan FUERA: "quiero hablar con el repartidor"
 * es una petición sobre un pedido en curso, no sobre esta conversación, y
 * derivarla al equipo de WhatsApp no le sirve a nadie.
 */
const PERSONA =
  /\b(persona|humano|humana|alguien|encargad[oa]|due[ñn][oa]|jefe|jefa|gerente|operador|operadora|asesor|asesora|agente humano|un humano|el equipo|atencion al cliente|servicio al cliente)\b/;

/**
 * Formas que no llevan verbo y aun así lo piden sin ambigüedad. Van por
 * coincidencia de frase, no por palabra suelta: "atención" a secas es un
 * grito de auxilio en un chat, no una petición de traspaso.
 */
const FRASES_DIRECTAS =
  /\b(atencion humana|agente humano|operador humano|con un humano|con una persona real)\b/;

/** `true` solo si el cliente pide hablar con una persona del equipo. */
export function isExplicitHumanRequest(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeIntentText(text);
  if (norm === '') return false;

  if (FRASES_DIRECTAS.test(norm)) return true;
  return CONTACTO.test(norm) && PERSONA.test(norm);
}
