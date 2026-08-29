import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  dispatchMenu,
  type ClaimMenuDeliveryInput,
  type ClaimMenuDeliveryResult,
  type DispatchMenuInput,
  type FinishMenuDeliveryInput,
  type MenuDeliveryStatus,
  type MenuDispatchDeps,
  type MenuSendResult,
} from './dispatch';

/**
 * Shared Menu Dispatch (Fase 6D.2F.5A).
 *
 * Lo que se prueba aquí es la ÚNICA autoridad sobre el efecto "mandar el menú":
 * que el mismo WAMID nunca produzca dos CTAs, que un WAMID nuevo sí pueda, y
 * que ningún desenlace del proveedor deje el sistema en un estado desde el que
 * un reintento reenvíe.
 *
 * Sin red, sin Supabase, sin Kapso: todo inyectado.
 */

const PHONE = '59162139119';
const WAMID_IN = 'wamid.IN_1';
const WAMID_CTA = 'wamid.CTA_1';
const NOW = '2026-08-15T12:00:00.000Z';
const MENU_URL = 'https://sarco-restaurant.vercel.app/menu?session=TOKEN_SECRETO';

interface FakeDelivery {
  id: string;
  customerPhone: string;
  sourceMessageId: string;
  reason: string;
  status: MenuDeliveryStatus;
  providerMessageId: string | null;
  errorCode: string | null;
  completedAt: string | null;
}

/** Ledger en memoria con el MISMO UNIQUE que la migración 0015. */
class FakeLedger {
  rows: FakeDelivery[] = [];
  claims = 0;
  private seq = 0;

  async claim(input: ClaimMenuDeliveryInput): Promise<ClaimMenuDeliveryResult> {
    this.claims += 1;
    const existing = this.rows.find((r) => r.sourceMessageId === input.sourceMessageId);
    if (existing) {
      return { result: 'exists', deliveryId: existing.id, status: existing.status };
    }
    const row: FakeDelivery = {
      id: `del-${++this.seq}`,
      customerPhone: input.customerPhone,
      sourceMessageId: input.sourceMessageId,
      reason: input.reason,
      status: 'pending',
      providerMessageId: null,
      errorCode: null,
      completedAt: null,
    };
    this.rows.push(row);
    return { result: 'claimed', deliveryId: row.id };
  }

  async finish(input: FinishMenuDeliveryInput): Promise<void> {
    const row = this.rows.find((r) => r.id === input.deliveryId)!;
    row.status = input.status;
    row.completedAt = input.completedAt;
    row.providerMessageId = input.providerMessageId ?? null;
    row.errorCode = input.errorCode ?? null;
    assertCoherence(row);
  }
}

/** Réplica del CHECK `menu_send_deliveries_state_coherence` de 0015. */
function assertCoherence(row: FakeDelivery): void {
  const ok =
    (row.status === 'pending' &&
      row.completedAt === null &&
      row.providerMessageId === null &&
      row.errorCode === null) ||
    (row.status === 'sent' &&
      row.completedAt !== null &&
      row.providerMessageId !== null &&
      row.errorCode === null) ||
    (row.status === 'failed' &&
      row.completedAt !== null &&
      row.providerMessageId === null &&
      row.errorCode !== null) ||
    (row.status === 'send_unknown' && row.completedAt !== null && row.errorCode !== null) ||
    (row.status === 'blocked_recent' &&
      row.completedAt !== null &&
      row.providerMessageId === null &&
      row.errorCode === null);

  if (!ok) throw new Error(`check violation: estado incoherente (${row.status})`);
}

function fakeSession() {
  const calls: string[] = [];
  return {
    calls,
    port: {
      async createUrl({ sourceMessageId }: { sourceMessageId: string }) {
        calls.push(sourceMessageId);
        return { sessionUrl: MENU_URL, effectivePhoneNumberId: 'pnid-1' };
      },
    },
  };
}

function fakeSend(result: MenuSendResult = { ok: true, wamid: WAMID_CTA }) {
  const calls: { customerPhone: string; menuUrl: string; phoneNumberId: string }[] = [];
  return {
    calls,
    port: {
      async sendCta(input: { customerPhone: string; menuUrl: string; phoneNumberId: string }) {
        calls.push(input);
        return result;
      },
    },
  };
}

function fakeMemory(failing = false) {
  const calls: { customerPhone: string; providerMessageId: string; sentAt: string }[] = [];
  return {
    calls,
    port: {
      async recordMenuSent(input: {
        customerPhone: string;
        providerMessageId: string;
        phoneNumberId: string;
        sentAt: string;
      }) {
        if (failing) throw new Error('supabase caida');
        calls.push(input);
      },
    },
  };
}

let ledger: FakeLedger;

beforeEach(() => {
  ledger = new FakeLedger();
});

function deps(over: Partial<MenuDispatchDeps> = {}): MenuDispatchDeps {
  return {
    deliveries: ledger,
    session: fakeSession().port,
    send: fakeSend().port,
    now: () => NOW,
    ...over,
  };
}

function input(over: Partial<DispatchMenuInput> = {}): DispatchMenuInput {
  return {
    customerPhone: PHONE,
    sourceMessageId: WAMID_IN,
    phoneNumberId: 'pnid-1',
    reason: 'explicit_request',
    ...over,
  };
}

describe('dispatch — claim antes del efecto', () => {
  it('1 · el primer claim gana y envía', async () => {
    const send = fakeSend();

    const result = await dispatchMenu(input(), deps({ send: send.port }));

    expect(result).toEqual({ result: 'sent', deliveryId: 'del-1', wamid: WAMID_CTA });
    expect(send.calls).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ status: 'sent', providerMessageId: WAMID_CTA });
  });

  it('2 · el reintento del MISMO wamid no envía por segunda vez', async () => {
    const send = fakeSend();
    const d = deps({ send: send.port });

    await dispatchMenu(input(), d);
    const retry = await dispatchMenu(input(), d);

    expect(retry).toEqual({ result: 'duplicate', deliveryId: 'del-1', status: 'sent' });
    expect(send.calls).toHaveLength(1); // UN solo CTA en total
    expect(ledger.rows).toHaveLength(1);
  });

  it('3 · dos wamid distintos son dos operaciones independientes', async () => {
    // Anti-repeat de UX ≠ idempotencia técnica: un mensaje NUEVO del cliente
    // puede legítimamente producir un CTA nuevo.
    const send = fakeSend();
    const d = deps({ send: send.port });

    await dispatchMenu(input({ sourceMessageId: 'wamid.A' }), d);
    const second = await dispatchMenu(input({ sourceMessageId: 'wamid.B' }), d);

    expect(second).toMatchObject({ result: 'sent' });
    expect(send.calls).toHaveLength(2);
    expect(ledger.rows).toHaveLength(2);
  });

  it('el claim ocurre DESPUÉS de la sesión: un fallo de sesión no quema el wamid', async () => {
    // Si el claim fuera antes, un fallo transitorio dejaría ese mensaje del
    // cliente sin menú para siempre.
    const session = {
      createUrl: async () => {
        throw new Error('MENU_SESSION_SECRET not configured');
      },
    };

    await expect(dispatchMenu(input(), deps({ session }))).rejects.toThrow();
    expect(ledger.rows).toEqual([]);

    // Y el reintento, ya con la sesión sana, sí envía.
    const send = fakeSend();
    const result = await dispatchMenu(input(), deps({ send: send.port }));
    expect(result).toMatchObject({ result: 'sent' });
    expect(send.calls).toHaveLength(1);
  });

  it('una fila `pending` de otra ejecución NO se reenvía', async () => {
    // `pending` solo puede significar "nos caímos durante la llamada a Kapso":
    // el caso ambiguo en el que callar es lo correcto.
    await ledger.claim({
      customerPhone: PHONE,
      sourceMessageId: WAMID_IN,
      reason: 'explicit_request',
      claimedAt: NOW,
    });
    const send = fakeSend();

    const result = await dispatchMenu(input(), deps({ send: send.port }));

    expect(result).toMatchObject({ result: 'duplicate', status: 'pending' });
    expect(send.calls).toEqual([]);
  });
});

describe('dispatch — desenlace del proveedor', () => {
  it('4 · éxito con WAMID => sent', async () => {
    const result = await dispatchMenu(
      input(),
      deps({ send: fakeSend({ ok: true, wamid: WAMID_CTA }).port }),
    );

    expect(result).toMatchObject({ result: 'sent', wamid: WAMID_CTA });
    expect(ledger.rows[0].completedAt).toBe(NOW);
  });

  it('5 · rechazo determinístico (4xx / payload inválido) => failed', async () => {
    for (const send of [
      { ok: false as const, error: 'invalid_phone' },
      { ok: false as const, error: 'invalid_body_text' },
      { ok: false as const, error: 'http_error', status: 400 },
    ]) {
      ledger = new FakeLedger();
      const result = await dispatchMenu(input(), deps({ send: fakeSend(send).port }));

      // El status, cuando lo hay, forma parte del código.
      const esperado =
        send.status === undefined ? `send.${send.error}` : `send.${send.error}.${send.status}`;
      expect(result, send.error).toMatchObject({ result: 'failed', error: esperado });
      expect(ledger.rows[0].status, send.error).toBe('failed');
      expect(ledger.rows[0].providerMessageId, send.error).toBeNull();
    }
  });

  it('6 · timeout, red y 5xx => send_unknown', async () => {
    for (const send of [
      { ok: false as const, error: 'timeout' },
      { ok: false as const, error: 'network_error' },
      { ok: false as const, error: 'invalid_response' },
      { ok: false as const, error: 'http_error', status: 503 },
    ]) {
      ledger = new FakeLedger();
      const result = await dispatchMenu(input(), deps({ send: fakeSend(send).port }));

      expect(result, send.error).toMatchObject({ result: 'send_unknown' });
      expect(ledger.rows[0].status, send.error).toBe('send_unknown');
    }
  });

  it('7 · send_unknown + reintento del mismo inbound => NO reenvía', async () => {
    const send = fakeSend({ ok: false, error: 'timeout' });
    const d = deps({ send: send.port });

    await dispatchMenu(input(), d);
    const retry = await dispatchMenu(input(), d);

    expect(retry).toMatchObject({ result: 'duplicate', status: 'send_unknown' });
    expect(send.calls).toHaveLength(1);
  });

  it('failed + reintento del mismo inbound tampoco reenvía', async () => {
    const send = fakeSend({ ok: false, error: 'invalid_phone' });
    const d = deps({ send: send.port });

    await dispatchMenu(input(), d);
    const retry = await dispatchMenu(input(), d);

    expect(retry).toMatchObject({ result: 'duplicate', status: 'failed' });
    expect(send.calls).toHaveLength(1);
  });
});

describe('dispatch — memoria del automatismo', () => {
  it('9 · un envío correcto queda anotado como mensaje real del canal', async () => {
    const memory = fakeMemory();

    await dispatchMenu(input(), deps({ memory: memory.port }));

    expect(memory.calls).toEqual([
      {
        customerPhone: PHONE,
        providerMessageId: WAMID_CTA,
        phoneNumberId: 'pnid-1',
        sentAt: NOW,
        // El motivo viaja también a la memoria: es lo que decidió el texto que
        // vio el cliente, y sin él el historial guardaría siempre el de saludo.
        reason: 'explicit_request',
      },
    ]);
  });

  it('el MOTIVO llega al puerto de envío: es lo que elige el texto del botón', async () => {
    // `dispatchMenu` no conoce ni una letra del copy —y no debe—, pero sí decide
    // POR QUÉ se manda. Ese dato tiene que cruzar la frontera, o el canal no
    // puede elegir entre saludar, explicar o reenviar.
    const send = fakeSend();
    await dispatchMenu({ ...input(), reason: 'agent_suggestion' }, deps({ send: send.port }));

    expect(send.calls[0]).toMatchObject({ reason: 'agent_suggestion' });
  });

  it('8 · si la memoria falla, el CTA ya salió: NO se reenvía', async () => {
    // El ledger es la evidencia del efecto; la memoria es contabilidad nuestra.
    const send = fakeSend();
    const d = deps({ send: send.port, memory: fakeMemory(true).port });

    const result = await dispatchMenu(input(), d);

    expect(result).toMatchObject({ result: 'sent' });
    expect(ledger.rows[0].status).toBe('sent'); // el ledger conserva la verdad

    const retry = await dispatchMenu(input(), d);
    expect(retry).toMatchObject({ result: 'duplicate', status: 'sent' });
    expect(send.calls).toHaveLength(1);
  });

  it('sin memoria inyectada el despacho se comporta como antes de la fase', async () => {
    const send = fakeSend();

    const result = await dispatchMenu(input(), deps({ send: send.port, memory: undefined }));

    expect(result).toMatchObject({ result: 'sent' });
    expect(send.calls).toHaveLength(1);
  });

  it('no se anota nada cuando el envío no salió', async () => {
    const memory = fakeMemory();

    await dispatchMenu(
      input(),
      deps({ send: fakeSend({ ok: false, error: 'invalid_phone' }).port, memory: memory.port }),
    );

    expect(memory.calls).toEqual([]);
  });
});

describe('dispatch — sin ventana temporal (6D.2F.5B)', () => {
  /**
   * El cooldown de quince minutos para `agent_suggestion` se eliminó: bloqueaba
   * interacciones legítimas. Que a alguien le acabe de llegar el menú no lo
   * descalifica para volver a pedirlo — el enlace no le cargó, cerró la
   * ventana, cambió de idea— y adivinar cuál de esas cosas pasó con un reloj es
   * adivinar mal.
   *
   * Lo único que impide un segundo CTA es el mismo WAMID.
   */
  async function seedSentAt(completedAt: string) {
    const claim = await ledger.claim({
      customerPhone: PHONE,
      sourceMessageId: `wamid.PREVIO_${completedAt}`,
      reason: 'explicit_request',
      claimedAt: completedAt,
    });
    await ledger.finish({
      deliveryId: (claim as { deliveryId: string }).deliveryId,
      status: 'sent',
      completedAt,
      providerMessageId: 'wamid.CTA_PREVIO',
    });
  }

  it('C · una sugerencia pasa aunque el CTA anterior sea de hace segundos', async () => {
    await seedSentAt('2026-08-15T11:59:30.000Z'); // hace 30 segundos
    const send = fakeSend();

    const result = await dispatchMenu(
      input({ sourceMessageId: 'wamid.NUEVO', reason: 'agent_suggestion' }),
      deps({ send: send.port }),
    );

    expect(result).toMatchObject({ result: 'sent' });
    expect(send.calls).toHaveLength(1);
  });

  it('D · los cuatro motivos envían igual: ninguno abre ni cierra puertas', async () => {
    for (const reason of [
      'agent_suggestion',
      'explicit_request',
      'explicit_resend',
      'qa_trigger',
    ] as const) {
      ledger = new FakeLedger();
      await seedSentAt('2026-08-15T11:59:30.000Z');
      const send = fakeSend();

      const result = await dispatchMenu(
        input({ sourceMessageId: `wamid.${reason}`, reason }),
        deps({ send: send.port }),
      );

      expect(result, reason).toMatchObject({ result: 'sent' });
      expect(send.calls, reason).toHaveLength(1);
      // El motivo sigue quedando anotado: es observabilidad, no permiso.
      expect(ledger.rows.at(-1), reason).toMatchObject({ reason });
    }
  });

  it('A · dos WAMID distintos seguidos producen dos CTAs', async () => {
    const send = fakeSend();
    const d = deps({ send: send.port });

    const primera = await dispatchMenu(
      input({ sourceMessageId: 'wamid.UNO', reason: 'agent_suggestion' }),
      d,
    );
    const segunda = await dispatchMenu(
      input({ sourceMessageId: 'wamid.DOS', reason: 'agent_suggestion' }),
      d,
    );

    expect(primera).toMatchObject({ result: 'sent' });
    expect(segunda).toMatchObject({ result: 'sent' });
    expect(send.calls).toHaveLength(2);
  });

  it('B · el MISMO WAMID sigue sin producir dos CTAs', async () => {
    const send = fakeSend();
    const d = deps({ send: send.port });

    await dispatchMenu(input({ sourceMessageId: 'wamid.IGUAL' }), d);
    const segunda = await dispatchMenu(input({ sourceMessageId: 'wamid.IGUAL' }), d);

    expect(segunda).toMatchObject({ result: 'duplicate' });
    expect(send.calls).toHaveLength(1);
  });

  it('E · no queda ninguna lectura temporal: el reloj no decide nada', async () => {
    // `dispatchMenu` ya no consulta cuándo fue el último envío, así que el
    // ledger no necesita ni exponer esa pregunta. Si alguien reintrodujera un
    // cooldown, tendría que volver a añadir el método — y este test lo vería.
    expect('lastSentAt' in ledger).toBe(false);

    const fuente = readFileSync(new URL('./dispatch.ts', import.meta.url), 'utf8');

    expect(fuente).not.toMatch(/cooldownMinutes/);
    expect(fuente).not.toMatch(/COOLDOWN/);
    expect(fuente).not.toMatch(/lastSentAt/);
    // Y ninguna ejecución puede escribir ya el estado que producía la ventana.
    expect(fuente).not.toMatch(/status: 'blocked_recent'/);
  });
});

describe('dispatch — el token y la URL no salen de aquí', () => {
  it('10 · el ledger no guarda token, URL ni hash', async () => {
    await dispatchMenu(input(), deps());

    const dump = JSON.stringify(ledger.rows);
    expect(dump).not.toContain('TOKEN_SECRETO');
    expect(dump).not.toContain('session=');
    expect(dump).not.toContain('/menu');
  });

  it('lo que se anota en memoria tampoco los lleva', async () => {
    const memory = fakeMemory();

    await dispatchMenu(input(), deps({ memory: memory.port }));

    const dump = JSON.stringify(memory.calls);
    expect(dump).not.toContain('TOKEN_SECRETO');
    expect(dump).not.toContain('session=');
    expect(dump).not.toContain('/menu');
  });

  it('ningún resultado del despacho expone la URL', async () => {
    for (const send of [
      { ok: true as const, wamid: WAMID_CTA },
      { ok: false as const, error: 'http_error', status: 500 },
    ]) {
      ledger = new FakeLedger();
      const result = await dispatchMenu(input(), deps({ send: fakeSend(send).port }));

      expect(JSON.stringify(result)).not.toContain('TOKEN_SECRETO');
    }
  });

  it('el error del proveedor viaja como código corto, sin cuerpo', async () => {
    const result = await dispatchMenu(
      input(),
      deps({ send: fakeSend({ ok: false, error: 'http_error', status: 503 }).port }),
    );

    // El STATUS forma parte del código: `send.http_error` a secas no distingue
    // una credencial rechazada de un payload inválido o de un límite de tarifa,
    // y sin ese número la única vía de diagnóstico es reproducir la llamada a
    // mano contra la API del proveedor.
    expect(result).toMatchObject({ error: 'send.http_error.503' });
    // Mismo formato que agent_runs.error_code: cabe en un log.
    expect(ledger.rows[0].errorCode).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });

  it('cada status HTTP queda distinguible en el ledger', async () => {
    // Los tres que de verdad se confunden hoy bajo una sola etiqueta.
    for (const status of [400, 401, 429]) {
      ledger.rows.length = 0;
      await dispatchMenu(
        input(),
        deps({ send: fakeSend({ ok: false, error: 'http_error', status }).port }),
      );
      expect(ledger.rows[0].errorCode, `status ${status}`).toBe(`send.http_error.${status}`);
    }
  });

  it('sin status el código queda como antes, sin un sufijo inventado', async () => {
    // `timeout` y `network_error` no llegan a tener respuesta: no hay número que
    // añadir, y poner un `0` o un `unknown` sería fabricar un dato.
    await dispatchMenu(
      input(),
      deps({ send: fakeSend({ ok: false, error: 'timeout' }).port }),
    );
    expect(ledger.rows[0].errorCode).toBe('send.timeout');
  });

  it('el código nunca arrastra nada del cliente', async () => {
    await dispatchMenu(
      input(),
      deps({ send: fakeSend({ ok: false, error: 'http_error', status: 400 }).port }),
    );
    const code = ledger.rows[0].errorCode ?? '';
    expect(code).not.toContain('59100000000');
    expect(code.length).toBeLessThanOrEqual(64);
  });
});

describe('dispatch — esta fase no toca OpenAI', () => {
  it('16 · el módulo no conoce el modelo: no hay tool ni function calling', () => {
    // 6D.2F.5A construye la infraestructura; `send_menu()` llega en 5B. Que el
    // despacho no tenga forma de llamar al modelo no es un detalle: es lo que
    // hace que "una sola autoridad sobre el efecto" siga siendo cierto.
    const source = readFileSync(new URL('./dispatch.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('openai');
    expect(source).not.toContain('agent/core/model');
    expect(source).not.toContain('function_call');
    expect(source).not.toContain('tools');
    // Sus dependencias de RUNTIME son ledger, sesión, envío y memoria. Nada más.
    //
    // El `import type` del contexto del CTA no cuenta y no puede contar: se
    // borra al compilar, no arrastra código y solo nombra el enum que viaja
    // hasta el borde para elegir el copy. Lo que esta lista protege es que este
    // módulo no gane la capacidad de llamar a nadie, no que no pueda nombrar un
    // tipo.
    const runtime = (source.match(/^import .*/gm) ?? []).filter(
      (linea) => !linea.startsWith('import type '),
    );
    expect(runtime).toEqual([
      "import { classifyKapsoSendFailure } from '@/lib/kapso/send-outcome';",
    ]);
  });
});

describe('dispatch — la sesión conserva su contrato', () => {
  it('11 y 12 · el despacho no decide sobre sesiones: delega y usa lo que reciba', async () => {
    // Reutilizar una sesión vigente o crear la siguiente cuando ya fue
    // consumida sigue siendo asunto de `session-service` (6D.2E). El despacho
    // solo le pasa el source_message_id real y envía la URL que le devuelva.
    const session = fakeSession();
    const send = fakeSend();

    await dispatchMenu(input(), deps({ session: session.port, send: send.port }));

    expect(session.calls).toEqual([WAMID_IN]);
    expect(send.calls[0]).toMatchObject({ menuUrl: MENU_URL, phoneNumberId: 'pnid-1' });
  });

  it('un WAMID ya reclamado no gasta un segundo envío', async () => {
    // La sesión SÍ se crea —es idempotente por source_message_id y no produce
    // nada visible— pero el claim corta antes de Kapso. Que la sesión corra
    // primero es lo que evita que un fallo transitorio de base queme un WAMID.
    const session = fakeSession();
    const send = fakeSend();
    const d = deps({ session: session.port, send: send.port });

    await dispatchMenu(input({ sourceMessageId: 'wamid.REPE' }), d);
    const segunda = await dispatchMenu(input({ sourceMessageId: 'wamid.REPE' }), d);

    expect(segunda).toMatchObject({ result: 'duplicate' });
    expect(send.calls).toHaveLength(1);
  });
});
