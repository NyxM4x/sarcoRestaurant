import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getKapsoClient } from '@/lib/kapso/client';
import { log } from '@/lib/log';
import { getDeliveryConfig } from './config';
import { getDistanceByRoad } from './mapbox';
import { feeForMeters } from './fee';
import { readRainSurcharge } from './settings';
import {
  ASK_LOCATION_FOR_QUOTE_TEXT,
  buildQuoteText,
  hasQuoteQuota,
  isSamePoint,
  QUOTE_FAILED_TEXT,
  QUOTE_OUT_OF_COVERAGE_TEXT,
  QUOTE_OVER_LIMIT_TEXT,
  QUOTE_REUSE_WINDOW_HOURS,
  STANDALONE_QUOTE_WINDOW_HOURS,
  type Coords,
} from './quote-request';

/**
 * Cotización de envío sin pedido — cableado server-only.
 *
 * Orden de los pasos, y por qué este:
 *
 *   1. RECLAMAR  — se mira si el WAMID del pin ya tiene fila. Si la tiene, este
 *                  mensaje ya se atendió: se para, sin llamar a Mapbox ni volver
 *                  a escribirle al cliente. Va PRIMERO por eso.
 *   2. CUPO      — se cuentan las cotizaciones que este teléfono ya recibió.
 *   3. REUSAR    — ¿medimos ya este mismo punto hace poco? Entonces no se paga.
 *   4. MEDIR     — Mapbox, solo si no había nada que reutilizar.
 *   5. TARIFAR   — `feeForMeters`, la única fuente del precio.
 *   6. CONTESTAR — siempre. Este flujo existe para que nadie se quede callado.
 *
 * El paso 6 no tiene excepciones: cupo agotado, fuera de cobertura y Mapbox
 * caído tienen cada uno su texto. Un cliente que manda su ubicación y no recibe
 * nada es justamente el fallo que esto viene a arreglar, y sería absurdo
 * reproducirlo en las ramas de error.
 */

/** Estados que el cliente llegó a ver, y que por tanto gastan cupo. */
const ESTADOS_ATENDIDOS = ['quoted', 'out_of_coverage'] as const;

export type StandaloneQuoteResult =
  | { result: 'quoted'; amount: number }
  | { result: 'out_of_coverage' }
  | { result: 'over_limit' }
  | { result: 'failed'; error: string }
  | { result: 'duplicate' };

export interface StandaloneQuoteInput {
  /** Ya normalizado a dígitos por el transporte. */
  customerPhone: string;
  /** WAMID del pin. Clave de idempotencia. */
  sourceMessageId: string;
  coords: Coords;
  phoneNumberId: string | null;
}

interface FilaReusable {
  latitude: number;
  longitude: number;
  distance_meters: number;
}

/**
 * Distancia ya medida para este mismo punto y este mismo cliente, si la hay.
 *
 * Se leen las candidatas recientes y se comparan EN MEMORIA con la tolerancia
 * real: hacerlo en SQL exigiría un cálculo geoespacial dentro de la consulta
 * para ahorrarse unas pocas filas, y la ventana ya las deja en un puñado.
 *
 * `null` ante cualquier error. No medir por un fallo de lectura sería peor que
 * pagar una llamada de más.
 */
export async function findReusableDistanceMeters(
  supabase: SupabaseClient,
  customerPhone: string,
  coords: Coords,
): Promise<number | null> {
  try {
    const desde = new Date(Date.now() - QUOTE_REUSE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('delivery_quote_requests')
      .select('latitude, longitude, distance_meters')
      .eq('customer_phone', customerPhone)
      .not('distance_meters', 'is', null)
      .gte('created_at', desde)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error || !data) return null;

    const fila = (data as unknown as FilaReusable[]).find((f) =>
      isSamePoint({ lat: f.latitude, lng: f.longitude }, coords),
    );
    return fila ? fila.distance_meters : null;
  } catch {
    return null;
  }
}

/** Cuántas cotizaciones RECIBIÓ este teléfono dentro de la ventana del cupo. */
async function contarAtendidas(
  supabase: SupabaseClient,
  customerPhone: string,
): Promise<number | null> {
  const desde = new Date(
    Date.now() - STANDALONE_QUOTE_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const { count, error } = await supabase
    .from('delivery_quote_requests')
    .select('id', { count: 'exact', head: true })
    .eq('customer_phone', customerPhone)
    .in('status', ESTADOS_ATENDIDOS)
    .gte('created_at', desde);

  // `null` = no se pudo contar, y el llamador decide NO cotizar: un contador
  // ciego que deja pasar todo no es un cupo.
  return error ? null : (count ?? 0);
}

/** ¿Este WAMID ya tiene fila? `null` si no se pudo consultar. */
async function yaExiste(
  supabase: SupabaseClient,
  sourceMessageId: string,
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from('delivery_quote_requests')
    .select('id')
    .eq('source_message_id', sourceMessageId)
    .maybeSingle();
  if (error) return null;
  return data !== null;
}

interface Desenlace {
  status: 'quoted' | 'out_of_coverage' | 'over_limit' | 'failed';
  distanceMeters?: number;
  distanceSource?: 'mapbox' | 'reused';
  feeAmount?: number;
  errorCode?: string;
}

/**
 * Escribe la fila. Best-effort: si falla, el cliente recibe su cotización igual.
 *
 * La alternativa —no contestar porque no se pudo registrar— cambiaría un
 * problema de contabilidad por uno de atención. Lo que se pierde si esto falla
 * es que una reentrega de Kapso vuelva a cotizar: unos céntimos, no una venta.
 */
async function guardar(
  supabase: SupabaseClient,
  input: StandaloneQuoteInput,
  desenlace: Desenlace,
): Promise<void> {
  const { error } = await supabase.from('delivery_quote_requests').insert({
    customer_phone: input.customerPhone,
    source_message_id: input.sourceMessageId,
    latitude: input.coords.lat,
    longitude: input.coords.lng,
    status: desenlace.status,
    distance_meters: desenlace.distanceMeters ?? null,
    distance_source: desenlace.distanceSource ?? null,
    fee_amount: desenlace.feeAmount ?? null,
    error_code: desenlace.errorCode ?? null,
  });
  if (error) log.warn('delivery_quote_request_ledger_write_failed');
}

/** El recargo de lluvia, best-effort: si no se puede leer, no se recarga. */
async function leerLluvia(supabase: SupabaseClient): Promise<boolean> {
  try {
    return await readRainSurcharge(supabase);
  } catch {
    return false;
  }
}

/**
 * Le pide la ubicación al que preguntó cuánto sale el envío. Nunca lanza.
 *
 * Un texto fijo y nada más: no mide, no consulta el ledger y no gasta cupo —
 * todavía no hay ningún punto que medir. El cupo empieza a contar cuando llega
 * el pin, que es cuando se paga por Mapbox.
 */
export async function askLocationForQuote(input: {
  toDigits: string;
  phoneNumberId: string | null;
}): Promise<{ ok: boolean }> {
  try {
    const enviado = await getKapsoClient().sendText(input.toDigits, ASK_LOCATION_FOR_QUOTE_TEXT, {
      phoneNumberId: input.phoneNumberId ?? undefined,
    });
    return { ok: enviado.ok };
  } catch {
    log.warn('delivery_quote_prompt_failed');
    return { ok: false };
  }
}

/**
 * Atiende un pin suelto: cotiza y contesta. Nunca lanza.
 *
 * El resultado es para el log y para el cuerpo del webhook; al cliente ya se le
 * respondió aquí dentro.
 */
export async function quoteStandaloneLocation(
  input: StandaloneQuoteInput,
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<StandaloneQuoteResult> {
  const { customerPhone, sourceMessageId, coords, phoneNumberId } = input;

  const responder = async (text: string): Promise<void> => {
    try {
      await getKapsoClient().sendText(customerPhone, text, {
        phoneNumberId: phoneNumberId ?? undefined,
      });
    } catch {
      // Sin `error.message`: el transporte puede traer detalle del proveedor.
      log.warn('delivery_quote_request_reply_failed');
    }
  };

  // 1. RECLAMAR.
  const atendidoYa = await yaExiste(supabase, sourceMessageId);
  if (atendidoYa === null) return { result: 'failed', error: 'ledger_unavailable' };
  if (atendidoYa) return { result: 'duplicate' };

  // 2. CUPO.
  const atendidas = await contarAtendidas(supabase, customerPhone);
  if (atendidas === null) return { result: 'failed', error: 'quota_unavailable' };

  if (!hasQuoteQuota(atendidas)) {
    await guardar(supabase, input, { status: 'over_limit' });
    await responder(QUOTE_OVER_LIMIT_TEXT);
    log.info('delivery_quote_request_over_limit', { answered: atendidas });
    return { result: 'over_limit' };
  }

  // 3. REUSAR y, solo si no hay nada, 4. MEDIR.
  const reusada = await findReusableDistanceMeters(supabase, customerPhone, coords);
  let metros = reusada;
  let fuente: 'mapbox' | 'reused' = 'reused';

  if (metros === null) {
    const config = getDeliveryConfig();
    const medida = await getDistanceByRoad(
      {
        origin: { lat: config.restaurantLat, lng: config.restaurantLng },
        destination: coords,
      },
      { accessToken: config.mapboxAccessToken, timeoutMs: config.mapboxTimeoutMs },
    );

    if (!medida.ok) {
      await guardar(supabase, input, { status: 'failed', errorCode: `mapbox.${medida.error}` });
      await responder(QUOTE_FAILED_TEXT);
      log.warn('delivery_quote_request_failed', { error: medida.error });
      return { result: 'failed', error: medida.error };
    }
    metros = medida.distanceMeters;
    fuente = 'mapbox';
  }

  // 5. TARIFAR. El recargo de lluvia se aplica igual que en el pedido: lo que se
  // cotiza tiene que ser lo que se cobra, o la cifra anticipada miente.
  const tarifa = feeForMeters(metros, { rain: await leerLluvia(supabase) });

  if (!tarifa.ok) {
    if (tarifa.reason === 'out_of_coverage') {
      await guardar(supabase, input, {
        status: 'out_of_coverage',
        distanceMeters: metros,
        distanceSource: fuente,
      });
      await responder(QUOTE_OUT_OF_COVERAGE_TEXT);
      log.info('delivery_quote_request_out_of_coverage', { source: fuente });
      return { result: 'out_of_coverage' };
    }
    await guardar(supabase, input, { status: 'failed', errorCode: `fee.${tarifa.reason}` });
    await responder(QUOTE_FAILED_TEXT);
    log.warn('delivery_quote_request_failed', { error: tarifa.reason });
    return { result: 'failed', error: tarifa.reason };
  }

  // 6. CONTESTAR.
  await guardar(supabase, input, {
    status: 'quoted',
    distanceMeters: metros,
    distanceSource: fuente,
    feeAmount: tarifa.amount,
  });
  await responder(buildQuoteText(tarifa.amount));
  log.info('delivery_quote_request_quoted', { source: fuente });
  return { result: 'quoted', amount: tarifa.amount };
}
