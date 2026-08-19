import { NextResponse } from 'next/server';

/**
 * GET /api/health — comprobación mínima de que el deployment está vivo.
 *
 * Deliberadamente NO consulta Supabase, no lee variables de entorno ni expone
 * versiones internas: solo confirma que el proceso de Next.js responde.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ ok: true, service: 'don-zarco-orders' });
}
