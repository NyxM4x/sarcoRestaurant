import { z } from 'zod';

/**
 * Construcción de mensajes salientes de Kapso — módulo puro.
 *
 * El payload de `location_request_message` es EXACTAMENTE el confirmado por
 * Kapso Support (no cambiar la forma sin reconfirmar).
 */

export const LOCATION_REQUEST_BODY_TEXT =
  'Por favor comparte tu ubicación actual para coordinar el delivery.';

/**
 * Cuerpo del location_request_message para el checkout WEB (Fase 5.2D).
 *
 * Incluye el `order_number` para que el mensaje sea identificable al reconciliar
 * envíos ambiguos contra `GET /messages` (Fase 5.2D.5A): el número de pedido es
 * el único token que permite emparejar un saliente con su notificación.
 *
 * Es una función separada: el copy por defecto del WhatsApp Flow NO cambia.
 */
export function buildWebLocationRequestBodyText(orderNumber: string): string {
  return `📍 Pedido ${orderNumber}: envíame tu ubicación GPS, por favor, para calcular el costo del envío 😊`;
}

/**
 * Payload exacto del location_request_message (formato Kapso/WhatsApp Cloud).
 *
 * `bodyText` es opcional y solo cambia `interactive.body.text`; cuando se omite
 * (undefined) se conserva EXACTAMENTE el texto del WhatsApp Flow. Si se pasa
 * explícitamente, no puede estar vacío ni ser solo espacios. La forma del
 * payload (`interactive.type = 'location_request_message'`,
 * `action.name = 'send_location'`) no varía. `toDigits` se espera ya normalizado
 * (lo hace el transporte).
 */
export function buildLocationRequestPayload(
  toDigits: string,
  bodyText: string = LOCATION_REQUEST_BODY_TEXT,
) {
  if (bodyText.trim() === '') {
    throw new Error('buildLocationRequestPayload: bodyText must not be empty');
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toDigits,
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: {
        text: bodyText,
      },
      action: {
        name: 'send_location',
      },
    },
  } as const;
}

/**
 * Payload de un mensaje de texto simple (formato Kapso/WhatsApp Cloud).
 *
 * No incluye `preview_url`: el formato actual de Kapso no lo exige y su omisión
 * deja el comportamiento por defecto de WhatsApp (sin previsualización de enlaces).
 *
 * `toDigits` se espera ya normalizado (lo hace el transporte). `text` se envía
 * verbatim —incluidos saltos de línea— y no puede estar vacío ni ser solo
 * espacios (invariante del emisor, no una condición de runtime).
 */
export function buildTextPayload(toDigits: string, text: string) {
  if (text.trim() === '') {
    throw new Error('buildTextPayload: text must not be empty');
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toDigits,
    type: 'text',
    text: {
      body: text,
    },
  } as const;
}

// ── Imagen (Fase 6D.1: QR de pago) ────────────────────────────────────────

/**
 * URL pública del QR de pago fijo del restaurante. Es una constante (igual que
 * `MENU_URL`) y NO se deriva de `APP_BASE_URL` a propósito: WhatsApp exige una
 * URL pública https para la imagen, y en local `APP_BASE_URL` valdría
 * `http://localhost:3000`, inaccesible desde el teléfono. Fuente única: si
 * cambia el dominio del deployment, cambiar aquí.
 */
export const PAYMENT_QR_URL = 'https://sarco-restaurant.vercel.app/payment/qr.png';

/**
 * Texto para el cliente cuando su ubicación queda FUERA de la zona de delivery
 * (> 18 km de ruta real, Fase 6D.2C). Copy corto y neutro; sin kilómetros, sin
 * tarifa, sin detalles de Mapbox. Se envía como texto directo best-effort (NO
 * crea fila en order_notifications) y una sola vez, únicamente cuando
 * `mark_delivery_quote_result` confirma la transición real a out_of_coverage.
 */
export const OUT_OF_COVERAGE_TEXT =
  'Lo sentimos 😔 tu ubicación está fuera de nuestra zona de delivery. ' +
  'Escríbenos y coordinamos una alternativa para tu pedido.';

/**
 * Payload de un mensaje de imagen por enlace (formato Kapso/WhatsApp Cloud).
 *
 * `imageUrl` debe ser una URL pública https. `caption` viaja verbatim como pie
 * de la imagen (WhatsApp lo admite hasta ~1024 caracteres) y NO puede estar
 * vacío ni ser solo espacios. `toDigits` se espera ya normalizado (lo hace el
 * transporte).
 */
export function buildImagePayload(toDigits: string, imageUrl: string, caption: string) {
  if (imageUrl.trim() === '') {
    throw new Error('buildImagePayload: imageUrl must not be empty');
  }
  if (caption.trim() === '') {
    throw new Error('buildImagePayload: caption must not be empty');
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toDigits,
    type: 'image',
    image: {
      link: imageUrl,
      caption,
    },
  } as const;
}

// ── CTA URL "Ver menú" (Fase 5.2A) ───────────────────────────────────────

/**
 * Texto del cuerpo del mensaje interactivo con el botón del menú.
 *
 * Va SIEMPRE acompañado del botón "Ver menú" en el mismo mensaje: por eso aquí
 * sí se puede pedir que lo toquen. En un mensaje de texto suelto esa frase
 * sería una promesa falsa (no habría ningún botón que tocar).
 *
 * El horario se repite aquí a propósito, porque este suele ser el primer
 * mensaje que recibe un cliente nuevo. Su fuente es `BUSINESS_HOURS`
 * (`src/lib/agent/business/facts.ts`): si cambia el horario, cambiar ambos.
 */
export const MENU_CTA_BODY_TEXT =
  'Hola, soy Don Zarco 👋 Atendemos todos los días de 21:00 a 04:00. ' +
  'Toca el botón para ver el menú y armar tu pedido.';

/** Etiqueta del botón (WhatsApp la limita a 20 caracteres). */
export const MENU_CTA_BUTTON_TEXT = 'Ver menú';

/**
 * Imagen de portada del CTA del menú (Fase 6D.2E). Asset local versionado y
 * público (mismo patrón que `PAYMENT_QR_URL`). DEBE ser JPEG/PNG: WhatsApp Cloud
 * NO admite WebP en mensajes tipo imagen (solo stickers). Fuente única: si cambia
 * el dominio del deployment, cambiar aquí.
 */
export const MENU_COVER_URL = 'https://sarco-restaurant.vercel.app/menu/menu-cover.jpeg';

/**
 * URL de la tienda. Es una constante y NO se deriva de `APP_BASE_URL` a
 * propósito: WhatsApp exige una URL pública https, y en local `APP_BASE_URL`
 * vale `http://localhost:3000`, que abriría un enlace roto en el teléfono.
 * Si cambia el dominio del deployment, cambiar aquí.
 */
export const MENU_URL = 'https://sarco-restaurant.vercel.app/menu';

/**
 * Payload del mensaje interactivo CTA URL con el botón "Ver menú".
 *
 * Fase 5.2B: `url` puede ser dinámico (con sesión) o el valor constante.
 * Fase 6D.2E (Opción A): incluye un `header` de imagen (portada del menú) en el
 * MISMO mensaje interactivo — un solo envío, atómico. `coverImageUrl` es
 * inyectable (default `MENU_COVER_URL`); el `session_token` viaja SOLO en `url`,
 * nunca en el body ni en el header.
 */
export function buildMenuCtaPayload(
  toDigits: string,
  url: string = MENU_URL,
  coverImageUrl: string = MENU_COVER_URL,
) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toDigits,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      header: {
        type: 'image',
        image: {
          link: coverImageUrl,
        },
      },
      body: {
        text: MENU_CTA_BODY_TEXT,
      },
      action: {
        name: 'cta_url',
        parameters: {
          display_text: MENU_CTA_BUTTON_TEXT,
          url,
        },
      },
    },
  } as const;
}

/**
 * Respuesta exitosa del envío: debe contener el id del mensaje saliente en
 * `messages[0].id` (se guarda en `orders.location_request_message_id`).
 */
export const kapsoSendResponseSchema = z.object({
  messages: z
    .array(z.object({ id: z.string().min(1) }))
    .min(1),
});

export type KapsoSendResponse = z.infer<typeof kapsoSendResponseSchema>;
