import { z } from 'zod';
import { businessHoursClock } from '@/lib/agent/business/facts';
import type { MenuSendReason } from '@/lib/menu/dispatch';
import type { MenuCtaContext } from '@/lib/menu/cta-context';
import { LOCATION_HOW_TO_TEXT } from './outbound-classify';

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
 * Cómo se manda la ubicación, dicho paso a paso.
 *
 * Nombra la opción con las palabras EXACTAS que WhatsApp pinta en pantalla
 * —"Enviar ubicación actual"— porque una instrucción que hay que traducir a lo
 * que se ve es una instrucción que no se sigue.
 *
 * El texto NO se escribe aquí: se importa del clasificador, donde viven las
 * marcas canónicas del copy. Desde que la petición dejó de ser un botón, esta
 * línea es lo único que la distingue de cualquier otro texto, y dos copias
 * podrían separarse sin que nada avisara.
 */
export { LOCATION_HOW_TO_TEXT };

/**
 * Petición de ubicación, como MENSAJE DE TEXTO.
 *
 * ── Por qué ya no lleva el botón ─────────────────────────────────────
 *
 * Era un `interactive.location_request_message` con su botón `send_location`, y
 * el botón daba problemas en el último paso del flujo (03-09-2026): el cliente
 * se quedaba ahí y el pedido nunca llegaba a cotizarse. Ahora es texto plano con
 * las instrucciones dentro.
 *
 * Quitarlo NO rompe la correlación, y esa es la razón de que se pueda quitar.
 * El camino bueno sigue siendo `context.id` —el wamid de ESTE mensaje— cuando el
 * cliente responde citándolo; y cuando manda el pin con el clip, sin citar nada,
 * lo recoge `attachLooseLocation`, que busca un pedido en `awaiting_location` de
 * ese teléfono y le adjunta las coordenadas. Ese camino existe desde 0028
 * justamente porque mucha gente ya ignoraba el botón.
 *
 * `bodyText` mantiene su significado: omitido, el copy del WhatsApp Flow;
 * pasado, el del checkout web. Las instrucciones se añaden AQUÍ y no en cada
 * copy, para que ningún camino pueda quedarse sin ellas.
 */
export function buildLocationRequestPayload(
  toDigits: string,
  bodyText: string = LOCATION_REQUEST_BODY_TEXT,
) {
  if (bodyText.trim() === '') {
    throw new Error('buildLocationRequestPayload: bodyText must not be empty');
  }
  return buildTextPayload(toDigits, bodyText + '\n\n' + LOCATION_HOW_TO_TEXT);
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
 *
 * ── El nombre del archivo lleva el año, y no es decorativo ──────────────────
 *
 * Al cambiar de cuenta (02-09-2026) el fichero se renombró en vez de
 * sobrescribirse. Reemplazar los píxeles dejando la misma URL habría dejado dos
 * cachés capaces de servir el QR ANTERIOR durante horas —la CDN del deployment
 * y la de medios de WhatsApp, que guarda por enlace—, y ese QR apunta a una
 * cuenta que ya no es la del negocio: el cliente transferiría el dinero a otro
 * sitio y el análisis lo marcaría como sospechoso teniendo razón.
 *
 * Una URL que nunca ha existido no puede estar cacheada. Al renombrar el QR,
 * renombrar también aquí.
 */
export const PAYMENT_QR_URL = 'https://sarco-restaurant.vercel.app/payment/qr-2026.jpeg';

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
 * El horario aparece aquí porque este suele ser el primer mensaje que recibe un
 * cliente nuevo. Ya NO se escribe a mano: sale de `businessHoursClock()`, la
 * misma fuente que usa el agente.
 *
 * La copia a mano duró hasta el primer cambio de horario, tal como avisaba el
 * comentario que estaba aquí: el local pasó a abrir a las 18:00 y este mensaje
 * siguió diciendo 21:00 a cada cliente nuevo. Un dato duplicado "con cuidado" es
 * un dato que se va a desincronizar; lo único que lo evita es que haya uno solo.
 */
export const MENU_CTA_BODY_TEXT =
  `Hola, soy Don Zarco 👋 Atendemos todos los días de ${businessHoursClock()}. ` +
  'Toca el botón para ver el menú, elegir lo que quieras y mandar tu pedido desde ahí mismo.';

/**
 * El cuerpo del CTA, según POR QUÉ se manda el menú.
 *
 * ── Por qué el copy vive aquí y no en el prompt ─────────────────────────────
 *
 * Un `send_menu` confirmado cierra el turno EN SILENCIO: el modelo no escribe
 * ni una frase después de mandar el botón. Así que todo lo que hay que decirle
 * al cliente para que entienda el cambio tiene que caber en este mensaje — no
 * hay ningún otro momento en el que decirlo.
 *
 * Y está bien que sea así. Escrito aquí, el texto llega siempre igual de bien
 * redactado, el modelo no puede estropearlo ni inventarse una variante, no
 * cuesta un solo token, y lo ve TAMBIÉN quien llega por la ruta determinística
 * —que ni pasa por el agente—.
 *
 * ── Qué distingue a cada variante ───────────────────────────────────────────
 *
 * El motivo lo decide el backend leyendo el mensaje real del cliente, nunca el
 * modelo. Y el criterio de redacción es el mismo en todas: la ventaja es del
 * CLIENTE. "Hemos actualizado nuestro sistema" habla del negocio y a nadie le
 * importa; "así entra completo y no se pierde nada" habla de su pedido.
 *
 * El horario aparece SOLO en la variante de saludo: quien escribe "menu" en
 * frío suele ser un primer contacto. Repetirlo en las demás gasta líneas de un
 * mensaje que se lee de un vistazo.
 */
export function menuCtaBodyText(
  reason: MenuSendReason,
  context: MenuCtaContext | null = null,
): string {
  // El CONTEXTO manda sobre el motivo cuando consta, porque es más específico:
  // el motivo dice con qué autoridad se manda el menú, y el contexto qué
  // acababa de preguntar el cliente. Contestar a lo segundo es lo que convierte
  // este mensaje en una respuesta y no solo en un botón.
  //
  // El reenvío es la excepción y va antes: a quien dice "no me llegó" el
  // problema no fue de comprensión, y explicarle otra vez cómo se pide sería
  // tratarlo de torpe por muy bien clasificada que esté su frase anterior.
  if (context !== null && reason !== 'explicit_resend') {
    switch (context) {
      // Preguntó un precio. El menú los tiene todos, y esa es la respuesta.
      case 'price':
        return (
          'Los precios están todos ahí dentro 👇 Tocá el botón, mirá lo que ' +
          'quieras y armá tu pedido con el total a la vista.'
        );
      // Preguntó por el envío. No se le da un monto —depende de su ubicación—
      // pero sí dónde y cuándo lo va a ver, que es lo que quería saber.
      case 'delivery':
        return (
          'Armá tu pedido acá 👇 Al confirmarlo compartís tu ubicación y te ' +
          'sale el costo del envío sumado al total, antes de pagar.'
        );
      // Dictó su pedido. Se le reconoce lo que quiere y se le explica la
      // ventaja, nunca la regla: "no puedo" suena a muro y no ayuda a nadie.
      case 'dictated':
        return (
          'Armálo vos mismo acá 👇 Elegís lo tuyo, ves el total al momento y ' +
          'el pedido entra completo, sin que se pierda nada por el camino.'
        );
    }
  }

  switch (reason) {
    // "No me llegó", "mandámelo de nuevo": el problema fue técnico, no de
    // comprensión. Explicarle otra vez cómo se pide sería tratarlo de torpe.
    case 'explicit_resend':
      return (
        'Te lo mando de nuevo 👇 Tocá el botón y ahí elegís lo que quieras, ' +
        'ves el total y confirmás tu pedido.'
      );
    // Nadie pidió el menú: lo mandamos porque preguntó qué hay o qué venden.
    case 'agent_suggestion':
      return (
        'Todo lo que tenemos está acá 👇 Tocá el botón, mirá los precios y armá ' +
        'tu pedido en un minuto.'
      );
    // Pidió el menú por su nombre, o es la prueba interna: el saludo completo.
    default:
      return MENU_CTA_BODY_TEXT;
  }
}

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
  /**
   * Cuerpo del mensaje. Por defecto el de saludo, para que un llamador que aún
   * no distinga el motivo se comporte exactamente como antes.
   */
  bodyText: string = MENU_CTA_BODY_TEXT,
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
        text: bodyText,
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
