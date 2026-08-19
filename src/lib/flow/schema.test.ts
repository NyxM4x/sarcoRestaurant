import { describe, it, expect } from 'vitest';
import { orderSummaryRequestSchema } from './schema';

// UUIDs válidos distintos para las pruebas de correlación.
const UUID_A = '9f1c8f2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const UUID_B = '00000000-0000-4000-8000-000000000000';

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    flow_token: `order_${UUID_A}`,
    order_session_id: UUID_A,
    customer_phone: '59170000000',
    data: {
      delivery_type: 'delivery',
      la_fija: '2',
    },
    ...overrides,
  };
}

/** Nombres de los campos con error, aplanados desde issues.path. */
function errorPaths(result: ReturnType<typeof orderSummaryRequestSchema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((i) => i.path.join('.'));
}

describe('orderSummaryRequestSchema — order_session_id UUID + coherencia con flow_token', () => {
  it('acepta un UUID válido con flow_token coherente', () => {
    const result = orderSummaryRequestSchema.safeParse(baseRequest());
    expect(result.success).toBe(true);
  });

  it('rechaza order_session_id que no es UUID', () => {
    const result = orderSummaryRequestSchema.safeParse(
      // token coherente con el valor, pero el valor no es UUID.
      baseRequest({ flow_token: 'order_not-a-uuid', order_session_id: 'not-a-uuid' }),
    );
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('order_session_id');
  });

  it('rechaza un UUID válido cuyo flow_token pertenece a otro UUID', () => {
    const result = orderSummaryRequestSchema.safeParse(
      baseRequest({ flow_token: `order_${UUID_B}`, order_session_id: UUID_A }),
    );
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('flow_token');
  });

  it('rechaza un flow_token sin el prefijo order_', () => {
    const result = orderSummaryRequestSchema.safeParse(
      baseRequest({ flow_token: UUID_A, order_session_id: UUID_A }),
    );
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('flow_token');
  });

  it('rechaza order_session_id ausente', () => {
    const req = baseRequest();
    delete (req as Record<string, unknown>).order_session_id;
    const result = orderSummaryRequestSchema.safeParse(req);
    expect(result.success).toBe(false);
  });

  it('exige customer_phone', () => {
    const result = orderSummaryRequestSchema.safeParse(
      baseRequest({ customer_phone: '' }),
    );
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('customer_phone');
  });
});
