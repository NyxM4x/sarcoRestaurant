import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getKapsoClient } from '@/lib/kapso/client';
import { log } from '@/lib/log';
import { getDeliveryConfig } from './config';
import { getDistanceByRoad } from './mapbox';
import { feeForMeters } from './fee';
import { readRainSurcharge } from './settings';
import { dispatchMenu } from '@/lib/menu/dispatch';
import { createMenuDispatchDeps } from '@/lib/kapso/send-menu-cta';
import {
  ASK_LOCATION_FOR_QUOTE_TEXT,
  QUOTE_LINK_WITHOUT_COORDS_TEXT,
  buildQuoteCtaText,
  buildQuoteText,
  hasQuoteQuota,
  isSamePoint,
  QUOTE_FAILED_CTA_TEXT,
  QUOTE_FAILED_TEXT,
  QUOTE_OUT_OF_COVERAGE_TEXT,
  QUOTE_OVER_LIMIT_CTA_TEXT,
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

/**
 * Manda un mensaje de cotización CON el botón "Ver menú" en el mismo globo.
 *
 * ── Por qué la cotización lleva botón (03-09-2026) ──────────────────────────
 *
 * Porque todos estos textos terminan diciendo "armá tu pedido en el menú", y
 * hasta hoy salían como texto plano. Dos conversaciones reales de esa noche
 * acabaron igual: el cliente preguntó el envío, recibió su tarifa, y acto
 * seguido se puso a dictar su pedido por chat. No es que no entendiera — es
 * que no tenía por dónde. Le habíamos señalado una puerta sin ponerla.
 *
 * Ahora el precio y la puerta van juntos: un solo mensaje contesta lo que
 * preguntó y le deja el menú abierto.
 *
 * ── El fallback no es opcional ──────────────────────────────────────────────
 *
 * Este módulo entero existe para que nadie se quede sin respuesta después de
 * mandar su ubicación. Si el CTA falla —Kapso caído, la sesión no se pudo
 * crear, la tabla del ledger no responde— la cotización sale igual, como
 * texto, con la versión que NO promete ningún botón.
 *
 * Y `send_unknown` cae al fallback también. Es el caso ambiguo: el proveedor no
 * nos dio certeza, así que puede acabar en un mensaje repetido. Se prefiere
 * repetir a callar, que es justo el fallo que este flujo vino a cerrar.
 */
async function responderConMenu(input: {
  customerPhone: string;
  sourceMessageId: string;
  phoneNumberId: string | null;
  /** Cuerpo del CTA: habla del botón que va debajo. */
  ctaText: string;
  /** El mismo mensaje sin botón, para cuando el CTA no sale. */
  plainText: string;
}): Promise<void> {
  const enviarPlano = async (): Promise<void> => {
    try {
      await getKapsoClient().sendText(input.customerPhone, input.plainText, {
        phoneNumberId: input.phoneNumberId ?? undefined,
      });
    } catch {
      // Sin `error.message`: el transporte puede traer detalle del proveedor.
      log.warn('delivery_quote_request_reply_failed');
    }
  };

  try {
    const enviado = await dispatchMenu(
      {
        customerPhone: input.customerPhone,
        sourceMessageId: input.sourceMessageId,
        phoneNumberId: input.phoneNumberId,
        // Nadie pidió el menú: llegó una ubicación. Es la definición exacta de
        // `agent_suggestion` — "el entrante no lo nombraba".
        reason: 'agent_suggestion',
        bodyText: input.ctaText,
      },
      createMenuDispatchDeps(),
    );

    // `duplicate` = este WAMID ya produjo un CTA, así que el cliente ya lo
    // tiene. Reenviar sería justo lo que el ledger impide.
    if (enviado.result === 'sent' || enviado.result === 'duplicate') return;

    log.warn('delivery_quote_cta_failed', { result: enviado.result });
  } catch {
    log.warn('delivery_quote_cta_failed', { result: 'threw' });
  }

  await enviarPlano();
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
 * Busca la última cotización que este teléfono YA recibió. `null` si no hay.
 *
 * Solo `quoted`: de una fila `out_of_coverage` no sale ninguna cifra que
 * repetir. La ventana es la misma del reuso de mediciones —si la distancia
 * sigue valiendo para no volver a pagar Mapbox, la cifra sigue valiendo para
 * repetírsela al cliente—.
 *
 * Fail-safe hacia el comportamiento de antes: ante cualquier fallo devuelve
 * `null` y se le pide la ubicación, que es lo que se hacía siempre.
 */
async function ultimaCotizacion(
  supabase: SupabaseClient,
  phoneDigits: string,
): Promise<number | null> {
  const desde = new Date(Date.now() - QUOTE_REUSE_WINDOW_HOURS * 3_600_000).toISOString();
  try {
    const { data, error } = await supabase
      .from('delivery_quote_requests')
      .select('fee_amount')
      .eq('customer_phone', phoneDigits)
      .eq('status', 'quoted')
      .gte('created_at', desde)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const fee = Number((data as { fee_amount: unknown }).fee_amount);
    return Number.isFinite(fee) ? fee : null;
  } catch {
    return null;
  }
}

/**
 * Contesta al que preguntó cuánto sale el envío. Nunca lanza.
 *
 * No mide y no gasta cupo: el cupo empieza a contar cuando llega el pin, que es
 * cuando se paga por Mapbox.
 *
 * ── Al que ya se le cotizó no se le pide la ubicación otra vez ──────────────
 *
 * Visto en producción el 02-09-2026: el cliente mandó su ubicación, se le
 * respondió "el envío sale Bs 17", y acto seguido escribió "aquí cuánto el
 * envío" — recibiendo "necesito tu ubicación 📍". Dos mensajes seguidos que se
 * contradicen, y el segundo pidiéndole algo que acababa de dar.
 *
 * El detector de intención no tenía la culpa: "aquí cuánto el envío" ES esa
 * pregunta. Lo que faltaba era mirar si ya había respuesta. Así que antes de
 * pedir nada se consulta el ledger, y si hay una cotización viva se repite su
 * cifra — que es lo que el cliente estaba preguntando.
 *
 * `link_without_coords` se queda fuera: ese cliente está intentando cotizar un
 * punto NUEVO que no se pudo leer, y responderle con la tarifa de otra
 * ubicación sería darle un precio que no es el suyo.
 */
export async function askLocationForQuote(input: {
  toDigits: string;
  phoneNumberId: string | null;
  /**
   * WAMID del mensaje que hizo la pregunta. Solo hace falta para repetir una
   * cotización viva, que sale con el botón del menú y por tanto necesita la
   * clave de idempotencia del despacho. Ausente = ese caso sale como texto.
   */
  sourceMessageId?: string | null;
  /**
   * Por qué se le pide. Cambia el TEXTO y nada más.
   *
   * `link_without_coords` es el cliente que ya creyó compartir su ubicación y
   * mandó un link de Maps que no traía el punto. Repetirle el texto de siempre
   * —"compartila con el botón"— lo deja mandando el mismo link otra vez, que es
   * exactamente lo que se vio en las dos conversaciones del 01-09-2026.
   */
  reason?: 'asked' | 'link_without_coords';
}, supabase: SupabaseClient = getSupabaseAdmin()): Promise<{ ok: boolean }> {
  let texto: string;
  if (input.reason === 'link_without_coords') {
    texto = QUOTE_LINK_WITHOUT_COORDS_TEXT;
  } else {
    const yaCotizado = await ultimaCotizacion(supabase, input.toDigits);

    // Repetir la cifra ES una cotización, así que sale como todas: con el
    // botón. Si no, este cliente —que pregunta el precio por SEGUNDA vez—
    // recibiría el mismo "armá tu pedido en el menú" sin menú que lo dejó
    // preguntando la primera.
    if (yaCotizado !== null && input.sourceMessageId) {
      await responderConMenu({
        customerPhone: input.toDigits,
        sourceMessageId: input.sourceMessageId,
        phoneNumberId: input.phoneNumberId,
        ctaText: buildQuoteCtaText(yaCotizado),
        plainText: buildQuoteText(yaCotizado),
      });
      // `responderConMenu` nunca lanza y siempre acaba escribiéndole al
      // cliente por una vía o la otra: el desenlace para el webhook es `ok`.
      return { ok: true };
    }

    // Pedir la ubicación se queda en texto A PROPÓSITO. Lo que este mensaje
    // necesita que el cliente toque es el botón de ubicación de WhatsApp, y
    // ponerle al lado un botón "Ver menú" es darle dos puertas cuando solo una
    // contesta lo que preguntó.
    texto = yaCotizado === null ? ASK_LOCATION_FOR_QUOTE_TEXT : buildQuoteText(yaCotizado);
  }
  try {
    const enviado = await getKapsoClient().sendText(input.toDigits, texto, {
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

  /**
   * Los desenlaces que mandan al cliente al menú salen CON el menú.
   *
   * Son tres —la tarifa, el cupo agotado y el fallo de medición— y los tres
   * terminaban su frase señalando un botón que el cliente no tenía. Fuera de
   * cobertura NO entra aquí: a ese cliente no se le está pidiendo que arme
   * nada, se le está diciendo que no llegamos, y ofrecerle el menú después
   * sería contradecirse en el mismo mensaje.
   */
  const responderConCta = (ctaText: string, plainText: string): Promise<void> =>
    responderConMenu({
      customerPhone,
      sourceMessageId,
      phoneNumberId,
      ctaText,
      plainText,
    });

  // 1. RECLAMAR.
  const atendidoYa = await yaExiste(supabase, sourceMessageId);
  if (atendidoYa === null) return { result: 'failed', error: 'ledger_unavailable' };
  if (atendidoYa) return { result: 'duplicate' };

  // 2. CUPO.
  const atendidas = await contarAtendidas(supabase, customerPhone);
  if (atendidas === null) return { result: 'failed', error: 'quota_unavailable' };

  if (!hasQuoteQuota(atendidas)) {
    await guardar(supabase, input, { status: 'over_limit' });
    await responderConCta(QUOTE_OVER_LIMIT_CTA_TEXT, QUOTE_OVER_LIMIT_TEXT);
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
      await responderConCta(QUOTE_FAILED_CTA_TEXT, QUOTE_FAILED_TEXT);
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
    await responderConCta(QUOTE_FAILED_CTA_TEXT, QUOTE_FAILED_TEXT);
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
  await responderConCta(buildQuoteCtaText(tarifa.amount), buildQuoteText(tarifa.amount));
  log.info('delivery_quote_request_quoted', { source: fuente });
  return { result: 'quoted', amount: tarifa.amount };
}
