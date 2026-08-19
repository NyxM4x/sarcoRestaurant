import 'server-only';
import { getServerEnv } from '@/lib/env/env';
import { createKapsoTransport, type KapsoClient } from './transport';

/**
 * Cliente de Kapso — wrapper server-only sobre el transporte puro.
 *
 * URL oficial confirmada por la documentación de Kapso:
 *   POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages
 *   Headers: Content-Type: application/json, X-API-Key: <KAPSO_API_KEY>
 *   Respuesta: messages[0].id
 *
 * `KAPSO_API_BASE_URL` permite sobreescribir la base solo para pruebas locales;
 * el valor por defecto es siempre la URL oficial anterior.
 */
const DEFAULT_KAPSO_BASE_URL = 'https://api.kapso.ai/meta/whatsapp/v24.0';

export class KapsoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KapsoConfigError';
  }
}

let client: KapsoClient | null = null;

/** Devuelve el cliente (lazy). Lanza `KapsoConfigError` si faltan credenciales. */
export function getKapsoClient(): KapsoClient {
  if (client) return client;

  const env = getServerEnv();
  if (!env.KAPSO_API_KEY || !env.KAPSO_PHONE_NUMBER_ID) {
    // Solo nombres de variables; nunca valores.
    throw new KapsoConfigError(
      'Faltan KAPSO_API_KEY y/o KAPSO_PHONE_NUMBER_ID para enviar mensajes.',
    );
  }

  client = createKapsoTransport({
    apiKey: env.KAPSO_API_KEY,
    phoneNumberId: env.KAPSO_PHONE_NUMBER_ID,
    baseUrl: env.KAPSO_API_BASE_URL ?? DEFAULT_KAPSO_BASE_URL,
  });
  return client;
}
