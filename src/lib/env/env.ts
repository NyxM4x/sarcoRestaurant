import 'server-only';
import { z } from 'zod';

/**
 * Variables de entorno server-only (ver `.env.example` y IDEA.md §13).
 *
 * IMPORTANTE: la validación es **lazy**. No se ejecuta al importar este módulo
 * ni durante `next build`; solo corre cuando algo llama a `getServerEnv()`
 * (en la práctica, la primera vez que se usa el cliente de Supabase). Así el
 * build de la Fase 1 no falla por faltar credenciales reales.
 */
// Opcional que trata la cadena vacía como "no definida": una variable presente
// pero vacía (placeholder) equivale a ausente y no debe fallar la validación de
// otras fases. Evita que un secreto opcional vacío bloquee endpoints que no lo usan.
const optionalString = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().url().optional(),
);

const serverEnvSchema = z.object({
  // Requeridas para usar el cliente de Supabase (Fase 1+).
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Requeridas en fases posteriores (webhook / Kapso / correlación).
  // Opcionales por ahora para no bloquear otras fases.
  INTERNAL_API_TOKEN: optionalString,
  KAPSO_API_KEY: optionalString,
  KAPSO_WEBHOOK_SECRET: optionalString,
  KAPSO_PHONE_NUMBER_ID: optionalString,
  /** Override opcional de la URL base de la API de Kapso (ver client.ts). */
  KAPSO_API_BASE_URL: optionalUrl,
  APP_BASE_URL: optionalUrl,
  /** Secreto para generar tokens de sesión de menú (HMAC-SHA256). Fase 5.2B. */
  MENU_SESSION_SECRET: optionalString,
  /**
   * Alertas Telegram para incidencias de notificaciones (Fase 5.2D.5E.2).
   * SOLO server-side; nunca NEXT_PUBLIC_. Opcionales: si faltan, el worker no
   * envía alertas (sin fetch) y el resto del tick sigue igual.
   */
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  /**
   * Acceso interno (/dashboard y /cocina). Server-only, nunca NEXT_PUBLIC_.
   *
   * Secreto HMAC (>=32 chars) que firma la cookie de sesion. Si falta, el
   * acceso queda cerrado (fail-closed) y no autentica a nadie.
   *
   * Las CREDENCIALES ya no viven aqui: desde la migracion 0020 cada persona
   * tiene su usuario y su rol en la tabla `dashboard_users` (ver docs/SETUP.md).
   */
  DASHBOARD_SESSION_SECRET: optionalString,
  /**
   * Almacenamiento de comprobantes de pago (Cloudflare R2, compatible S3).
   *
   * Server-only, nunca NEXT_PUBLIC_. Los comprobantes son archivos privados de
   * clientes: el bucket NO debe tener dominio publico conectado, y la app nunca
   * genera una URL publica ni firmada como fuente de verdad — los sirve por su
   * propio endpoint autenticado.
   *
   * Si falta cualquiera de las cuatro, la captura de comprobantes queda
   * apagada y el resto del sistema sigue funcionando igual (fail-closed).
   */
  R2_ACCOUNT_ID: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  R2_BUCKET: optionalString,
  /**
   * Agent Core (Fase 6D.2F.3). Todas opcionales: si falta cualquiera, el agente
   * no llama a OpenAI y el sistema se comporta exactamente como antes.
   *
   * AI_ENABLED es el interruptor general; solo la cadena 'true' lo enciende
   * (cualquier otro valor, incluido vacío, deja el agente apagado).
   *
   * AI_TEST_PHONES limita el despliegue a una LISTA de teléfonos separados por
   * coma, por coincidencia exacta de dígitos. AI_TEST_PHONE es la forma
   * anterior —un solo número— y se conserva como respaldo: si AI_TEST_PHONES no
   * está definida (o está vacía, que aquí es lo mismo), se usa aquella. Ninguna
   * de las dos habilita a nadie por omisión.
   */
  AI_ENABLED: optionalString,
  /**
   * AI_ACCESS_MODE decide A QUIÉN atiende el agente: 'all' abre la demo a
   * cualquier teléfono; cualquier otro valor —ausente, vacío o inválido— deja
   * el modo 'allowlist'. Solo la cadena exacta 'all' abre nada, para que
   * ninguna variable perdida ni ningún typo lo hagan por su cuenta.
   */
  AI_ACCESS_MODE: optionalString,
  AI_TEST_PHONES: optionalString,
  AI_TEST_PHONE: optionalString,
  /**
   * Minutos que dura la pausa por takeover humano (Fase 6D.2F.5C.1).
   *
   * Se declara como cadena, igual que el resto: el esquema valida FORMA, y el
   * significado lo interpreta quien lo usa. Aquí lo hace
   * `humanTakeoverPauseMinutes()`, que ante cualquier valor imposible cae al
   * default en vez de tumbar el webhook — un número mal escrito no puede dejar
   * al negocio sin recibir mensajes.
   */
  HUMAN_TAKEOVER_PAUSE_MINUTES: optionalString,
  /**
   * ACK durable del webhook (Fase 6D.2F.5C.1). Solo la cadena 'true' lo
   * enciende; ausente o cualquier otro valor deja el procesamiento EN LÍNEA,
   * que es el comportamiento anterior a 5C.1.
   *
   * El default apagado es deliberado: el modo nuevo se activa cuando se decide,
   * no por el hecho de desplegar. El negocio es el mismo en los dos modos — lo
   * único que cambia es si se procesa antes o después de responder.
   */
  WEBHOOK_ASYNC_ACK: optionalString,
  /**
   * Captura de comprobantes de pago (0021-0023). Solo la cadena exacta 'true'
   * la enciende; ausente, vacia o cualquier otro valor la deja APAGADA.
   *
   * El default apagado es deliberado y del mismo tipo que AI_ENABLED: esto
   * corre dentro del webhook que atiende a TODOS los clientes, asi que se
   * enciende cuando se decide, no por el hecho de desplegar. Apagarla en
   * produccion es cambiar esta variable, sin revertir codigo.
   */
  PAYMENT_PROOF_CAPTURE_ENABLED: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  // Sin OPENAI_BASE_URL a propósito: el host de OpenAI es una constante del
  // adaptador. Hacerlo configurable permitiría que una variable mal puesta
  // enviara el Bearer de la clave a un host arbitrario, y no hay ningún
  // requisito de proxy que lo justifique. En pruebas se inyecta `fetch`.
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

/**
 * Valida y devuelve las variables de entorno server-only.
 * Cachea el resultado tras la primera validación exitosa.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // No exponer valores; solo los nombres de las variables inválidas.
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `Variables de entorno inválidas o faltantes: ${missing}. ` +
        'Revisa .env.example y configura tu entorno.',
    );
  }

  cached = parsed.data;
  return cached;
}
