/**
 * El aviso del análisis dentro del ticket — módulo PURO.
 *
 * Traduce el pago de un pedido a UNA sola cosa: ¿hay que mirar el comprobante
 * con lupa, y por qué? El KDS se mira a un metro y con las manos ocupadas, así
 * que lo que llega a la tarjeta es una frase y una lista corta, no el estado del
 * analizador.
 *
 * ── Por qué se retira en cuanto el pago está decidido ───────────────────────
 *
 * El aviso existe para ayudar a decidir. Una vez decidido —confirmado o
 * rechazado— ya cumplió, y dejarlo puesto convierte la tarjeta de un pedido que
 * se está cocinando en un cartel rojo permanente que no pide ninguna acción. En
 * cocina, un aviso que no pide nada es un aviso que enseña a ignorar los avisos.
 *
 * El historial no se pierde: el análisis sigue escrito en la base y el panel del
 * encargado lo muestra junto al comprobante.
 */
import type { PaymentView, ProofAnalysisView } from '@/lib/dashboard/attempt-review';

export interface KitchenProofAlert {
  /** Título corto: qué pasa. */
  headline: string;
  /** Motivos concretos, sin repetir. */
  reasons: string[];
  /**
   * `red` = algo NO cuadra; `amber` = no se pudo leer.
   *
   * Son dos cosas distintas y se dicen distinto: acusar a una foto borrosa de lo
   * mismo que a un monto cambiado gastaría la única alerta que de verdad
   * importa. El color nunca comunica solo: siempre va con su texto.
   */
  tone: 'red' | 'amber';
  /**
   * A quien dice el comprobante que fue el dinero (0034).
   *
   * Solo cuando la acusacion es sobre el destino. Va aparte de `reasons` porque
   * no es un motivo mas: es el dato con el que se comprueba el motivo, y en un
   * ticket que se lee a un metro la diferencia entre acusar y mostrar es lo que
   * decide si alguien abre la imagen o pulsa por inercia.
   */
  destination: string | null;
}

/** Comprobantes que todavía están esperando una decisión. */
function comprobantesPendientes(payment: PaymentView) {
  const vigente = payment.attempts[0] ?? null;
  // Un intento ya decidido no aporta aviso; los sueltos nunca se deciden, así
  // que su aviso sigue en pie mientras estén ahí.
  const delIntento = vigente && vigente.canDecide ? vigente.proofs : [];
  return [...delIntento, ...payment.unlinkedProofs];
}

/**
 * Aviso del ticket, o `null` si no hay nada que decir.
 *
 * Con varios comprobantes gana el peor: si uno no cuadra y otro solo es
 * ilegible, lo que hay que mirar es el que no cuadra.
 */
export function proofAlertOf(payment: PaymentView | null): KitchenProofAlert | null {
  if (payment === null) return null;

  const analisis = comprobantesPendientes(payment)
    .map((p) => p.analysis)
    .filter((a): a is ProofAnalysisView => a !== null);
  if (analisis.length === 0) return null;

  const sospechosos = analisis.filter((a) => a.verdict === 'suspicious');
  const relevantes = sospechosos.length > 0 ? sospechosos : analisis;

  const reasons: string[] = [];
  for (const a of relevantes) {
    for (const r of a.reasons) if (!reasons.includes(r)) reasons.push(r);
  }

  return {
    headline: relevantes[0].headline,
    reasons,
    tone: sospechosos.length > 0 ? 'red' : 'amber',
    // El primero que tenga destino leido: con varios comprobantes, el que
    // manda es el mismo cuyo titular encabeza el aviso.
    destination: relevantes.find((a) => a.destination !== null)?.destination ?? null,
  };
}
