import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerEnv } from '@/lib/env/env';
import { extractBearer, safeCompare } from '@/lib/security/auth';
import { orderSummaryRequestSchema } from '@/lib/flow/schema';
import { upsertOrderDraft } from '@/lib/orders/service';
import { buildSummaryLines, formatBs, OrderValidationError } from '@/lib/orders/calculate';
import { log } from '@/lib/log';

// Requiere APIs de Node (crypto, service_role) — no Edge. Siempre dinámico.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/flow/order-summary
 *
 * Data Endpoint del WhatsApp Flow (vía Kapso Function). Autentica, valida el
 * `data_exchange`, calcula el total con precios reales, crea/actualiza el
 * borrador y devuelve la pantalla `ORDER_SUMMARY`.
 */
export async function POST(request: Request): Promise<Response> {
  const env = getServerEnv();

  // 1. Autenticación Bearer (Kapso Function → Vercel), comparación timing-safe.
  const token = extractBearer(request.headers.get('authorization'));
  if (!env.VERCEL_INTERNAL_TOKEN || !safeCompare(token, env.VERCEL_INTERNAL_TOKEN)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2. Body JSON.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // 3. Validación de forma con Zod.
  const parsed = orderSummaryRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', issues: z.treeifyError(parsed.error) },
      { status: 422 },
    );
  }
  const payload = parsed.data;

  // 4. Validez de firma del Data Endpoint (si Kapso la envía, debe ser true).
  if (payload.signature_valid === false) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  // 5. Calcular y persistir el borrador.
  try {
    const { data } = payload;
    const { order, calc } = await upsertOrderDraft({
      flow_token: payload.flow_token,
      customer_phone: payload.customer_phone,
      order_session_id: payload.order_session_id,
      conversation_id: payload.conversation_id ?? null,
      customer_name: data.customer_name ?? null,
      notes: data.notes ?? null,
      delivery_type: data.delivery_type,
      quantitiesByCode: data,
      rawFlowResponse: body,
    });

    log.info('order_draft_upserted', {
      order_id: order.id,
      order_session_id: payload.order_session_id,
      conversation_id: payload.conversation_id ?? null,
      delivery_type: order.delivery_type,
      lines: calc.lines.length,
      total_amount: calc.total_amount,
    });

    return NextResponse.json({
      screen: 'ORDER_SUMMARY',
      data: {
        order_draft_id: order.id,
        summary_lines: buildSummaryLines(calc),
        total_text: formatBs(calc.total_amount),
        delivery_type: order.delivery_type,
        customer_name: order.customer_name ?? '',
        notes: order.notes ?? '',
      },
    });
  } catch (error) {
    if (error instanceof OrderValidationError) {
      return NextResponse.json(
        { error: 'validation_error', message: error.message },
        { status: 422 },
      );
    }
    log.error('order_summary_failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
