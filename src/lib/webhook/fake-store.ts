import { hasAttemptsLeft } from './inbox';
import type {
  InsertProcessingInput,
  WebhookEventRow,
  WebhookEventStatus,
  WebhookEventStore,
} from './kapso';

/**
 * Doble en memoria de `webhook_events` — SOLO para pruebas.
 *
 * Existe como módulo compartido y no como clase copiada en cada archivo de test
 * porque ahora modela una máquina de estados con lease, intentos y reclamo
 * atómico. Tres copias de eso serían tres sitios donde el doble puede dejar de
 * parecerse a la base, y un doble que miente convierte los tests en decoración.
 *
 * Simula lo que de verdad importa del comportamiento real:
 *
 *  · el reclamo solo gana desde `received` (compare-and-set);
 *  · reclamar sube `attempts` en el mismo acto;
 *  · el lease vence, y una fila vencida vuelve a ser reclamable;
 *  · un terminal nunca queda agendado.
 */

export interface FakeRow {
  key: string;
  status: WebhookEventStatus;
  messageId: string | null;
  payload?: unknown;
  eventName: string;
  error?: string;
  attempts: number;
  maxAttempts: number;
  /** Epoch ms. `null` = no agendada (invisible para el recovery). */
  nextAttemptAt: number | null;
}

export class FakeWebhookEventStore implements WebhookEventStore {
  rows = new Map<string, FakeRow>();
  private seq = 0;

  /** Fuerza que `reopenForRetry` pierda la carrera. */
  claimLost = false;
  markProcessedCalls = 0;
  lastInsert?: InsertProcessingInput;
  /** Reloj inyectable para envejecer leases sin esperar. */
  now: () => number = () => Date.now();

  seed(key: string, status: WebhookEventStatus, over: Partial<FakeRow> = {}): string {
    const id = `seed-${key}`;
    this.rows.set(id, {
      key,
      status,
      messageId: null,
      payload: { seeded: true },
      eventName: 'whatsapp.message.received',
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: status === 'processed' || status === 'failed' ? null : this.now(),
      ...over,
    });
    return id;
  }

  private findRow(key: string): (FakeRow & { id: string }) | null {
    for (const [id, row] of this.rows) if (row.key === key) return { id, ...row };
    return null;
  }

  private toRow(id: string, row: FakeRow): WebhookEventRow {
    return {
      id,
      eventName: row.eventName,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
    };
  }

  async findByKey(key: string) {
    const found = this.findRow(key);
    return found ? { id: found.id, status: found.status } : null;
  }

  async insertReceived(
    input: InsertProcessingInput,
  ): Promise<{ id: string } | { duplicate: true }> {
    this.lastInsert = input;
    if (this.findRow(input.event_id)) return { duplicate: true };
    const id = `row-${++this.seq}`;
    this.rows.set(id, {
      key: input.event_id,
      // Nace `received`, NUNCA `processing`: aceptar y reclamar son actos
      // distintos, y quien reclama es quien va a trabajar.
      status: 'received',
      messageId: input.message_id,
      payload: input.payload,
      eventName: input.event_name,
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: this.now(),
    });
    return { id };
  }

  async claimEvent(id: string, leaseSeconds: number): Promise<WebhookEventRow | null> {
    const row = this.rows.get(id);
    // Compare-and-set contra `received`. Una fila `processing` con lease
    // vigente NO se puede robar por id: eso es trabajo de otro.
    if (!row || row.status !== 'received') return null;
    row.status = 'processing';
    row.attempts += 1;
    row.nextAttemptAt = this.now() + leaseSeconds * 1000;
    row.error = undefined;
    return this.toRow(id, row);
  }

  async releaseForRetry(id: string, nextAttemptAt: string, errorMessage: string): Promise<void> {
    const row = this.rows.get(id)!;
    row.status = 'received';
    row.nextAttemptAt = new Date(nextAttemptAt).getTime();
    row.error = errorMessage;
  }

  async reopenForRetry(id: string): Promise<boolean> {
    if (this.claimLost) return false;
    const row = this.rows.get(id);
    if (row?.status === 'failed') {
      row.status = 'received';
      row.nextAttemptAt = this.now();
      row.error = undefined;
      return true;
    }
    return false;
  }

  async markProcessed(id: string): Promise<void> {
    this.markProcessedCalls += 1;
    const row = this.rows.get(id)!;
    row.status = 'processed';
    row.nextAttemptAt = null;
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    const row = this.rows.get(id)!;
    row.status = 'failed';
    row.error = errorMessage;
    row.nextAttemptAt = null;
  }

  // ── Selector de vencidos (lo que hace `claim_due_webhook_events`) ──────────

  /**
   * Reclama trabajo VENCIDO. Incluye `processing` cuyo lease expiró: eso es,
   * por definición, trabajo abandonado — nadie tiene que decidir cuánto es
   * "demasiado tiempo".
   */
  async claimDue(limit: number, leaseSeconds: number): Promise<WebhookEventRow[]> {
    const nowMs = this.now();
    const claimed: WebhookEventRow[] = [];
    for (const [id, row] of this.rows) {
      if (claimed.length >= limit) break;
      if (row.nextAttemptAt === null || row.nextAttemptAt > nowMs) continue;
      if (row.status !== 'received' && row.status !== 'processing') continue;
      if (!hasAttemptsLeft(row.attempts, row.maxAttempts)) continue;
      row.status = 'processing';
      row.attempts += 1;
      row.nextAttemptAt = nowMs + leaseSeconds * 1000;
      claimed.push(this.toRow(id, row));
    }
    return claimed;
  }

  statuses(): WebhookEventStatus[] {
    return [...this.rows.values()].map((r) => r.status);
  }
}
