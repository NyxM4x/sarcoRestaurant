import 'server-only';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getServerEnv } from '@/lib/env/env';
import { createMenuSessionRepository } from './session-repository';
import { generateMenuSessionToken, hashMenuSessionToken } from './session-token';
import type { MenuSession } from '@/types';

/**
 * Servicio de sesiones de menú (server-only).
 *
 * Orquesta:
 * 1. Resolución del phone_number_id efectivo (evento → env → error si ninguno)
 * 2. REUTILIZACIÓN (6D.2E): si el teléfono ya tiene una sesión vigente, se
 *    regenera su token de forma reproducible y se reenvía — sin crear otra fila.
 * 3. Si no hay vigente: token HMAC(secret, source_message_id) + INSERT idempotente
 *    (getOrCreate) que además renueva expires_at si la fila existente venció.
 * 4. Construcción de la URL con el token opaco (el token viaja SOLO en la URL).
 *
 * La lógica se expone con dependencias INYECTABLES para poder probarse sin tocar
 * Supabase ni el entorno; el wiring real vive en `defaultDeps()`.
 */

export interface CreateMenuSessionParams {
  source_message_id: string;
  customer_phone: string;
  phone_number_id_from_event: string | null;
  /**
   * Pedido al que este enlace viene a SUSTITUIR (0035). Ausente = sesión normal.
   *
   * Cuando viene, la sesión NO se reutiliza ni se comparte: nace propia, con el
   * pedido escrito dentro. Un enlace de cambio y un enlace de menú no son la
   * misma cosa aunque se vean igual, y confundirlos cancelaría pedidos que nadie
   * quería cancelar.
   */
  replaces_order_id?: string | null;
}

export interface CreateMenuSessionResult {
  session_url: string;
  effective_phone_number_id: string;
}

export interface MenuSessionServiceDeps {
  appBaseUrl: string;
  secret: string;
  /** phone_number_id del entorno (`KAPSO_PHONE_NUMBER_ID`), fallback del evento. */
  envPhoneNumberId: string | null;
  findValidByPhone(customerPhone: string): Promise<MenuSession | null>;
  /** ¿La sesión ya fue consumida por un pedido? Si sí, NO se reutiliza (6D.2E.final). */
  sessionHasOrder(menuSessionId: string): Promise<boolean>;
  getOrCreate(input: {
    source_message_id: string;
    token_hash: string;
    customer_phone: string;
    phone_number_id: string;
    replaces_order_id?: string | null;
  }): Promise<MenuSession>;
}

/** Wiring real: lee env + Supabase. Solo se evalúa cuando no se inyectan deps. */
function defaultDeps(): MenuSessionServiceDeps {
  const env = getServerEnv();
  const secret = env.MENU_SESSION_SECRET;
  if (!secret) throw new Error('MENU_SESSION_SECRET not configured');

  const repo = createMenuSessionRepository(getSupabaseAdmin());
  return {
    appBaseUrl: env.APP_BASE_URL ?? 'https://sarco-restaurant.vercel.app',
    secret,
    envPhoneNumberId: env.KAPSO_PHONE_NUMBER_ID ?? null,
    findValidByPhone: (phone) => repo.findValidByPhone(phone),
    sessionHasOrder: (id) => repo.sessionHasOrder(id),
    getOrCreate: (input) => repo.getOrCreate(input),
  };
}

/** Construye la URL `/menu?session=TOKEN` (token opaco = seguro en la URL). */
function buildSessionUrl(appBaseUrl: string, token: string): string {
  const url = new URL(`${appBaseUrl}/menu`);
  url.searchParams.set('session', token);
  return url.toString();
}

export async function createMenuSessionWithUrl(
  params: CreateMenuSessionParams,
  deps: MenuSessionServiceDeps = defaultDeps(),
): Promise<CreateMenuSessionResult> {
  // 1. Resolver phone_number_id efectivo: evento → env → error.
  const effectivePhoneNumberId = params.phone_number_id_from_event || deps.envPhoneNumberId;
  if (!effectivePhoneNumberId) {
    throw new Error(
      'createMenuSessionWithUrl: no phone_number_id available ' +
        '(event provided none and KAPSO_PHONE_NUMBER_ID not configured)',
    );
  }

  // 2. Reutilizar una sesión vigente del mismo teléfono (6D.2E): regenera el
  //    token de forma reproducible desde su source_message_id. Condiciones:
  //    - el token regenerado hashea al token_hash guardado (coherencia), y
  //    - la sesión NO fue consumida por un pedido (6D.2E.final): una sesión con
  //      pedido es single-use (UNIQUE + P1003), reutilizarla impediría el segundo
  //      pedido. En ese caso se cae a crear una sesión nueva.
  //    Un enlace de CAMBIO nunca reutiliza: lo que lo define es el pedido que
  //    lleva dentro, y ninguna sesión anterior lo lleva.
  const existing = params.replaces_order_id
    ? null
    : await deps.findValidByPhone(params.customer_phone);
  if (existing) {
    const reusedToken = generateMenuSessionToken(existing.source_message_id, deps.secret);
    const tokenCoherent = hashMenuSessionToken(reusedToken) === existing.token_hash;
    if (tokenCoherent && !(await deps.sessionHasOrder(existing.id))) {
      return {
        session_url: buildSessionUrl(deps.appBaseUrl, reusedToken),
        effective_phone_number_id: existing.phone_number_id,
      };
    }
  }

  // 3. Sin sesión vigente reutilizable: token reproducible + INSERT idempotente.
  const token = generateMenuSessionToken(params.source_message_id, deps.secret);
  const tokenHash = hashMenuSessionToken(token);
  await deps.getOrCreate({
    source_message_id: params.source_message_id,
    token_hash: tokenHash,
    customer_phone: params.customer_phone,
    phone_number_id: effectivePhoneNumberId,
    replaces_order_id: params.replaces_order_id ?? null,
  });

  return {
    session_url: buildSessionUrl(deps.appBaseUrl, token),
    effective_phone_number_id: effectivePhoneNumberId,
  };
}
