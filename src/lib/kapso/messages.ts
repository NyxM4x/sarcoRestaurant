import { z } from 'zod';
import { businessHoursClock } from '@/lib/agent/business/facts';
import { formatBs } from '@/lib/orders/calculate';
import { shortOrderNumber } from '@/lib/orders/order-number';
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
      // Preguntó si puede pagar en efectivo, y todavía no entró al menú
      // (05-09-2026). Se le contesta que SÍ antes que nada: es lo que le está
      // impidiendo tocar el botón. Y se le dice dónde se elige, porque la
      // respuesta completa es "sí, y se hace ahí dentro".
      case 'cash':
        return (
          '¡Sí! 👇 Armá tu pedido en el botón y al confirmarlo elegí EFECTIVO ' +
          'como método de pago: le pagás al delivery cuando llegue con tu pedido.'
        );
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
      // Solo saludó. Es casi siempre el primer contacto, y lo que necesita es
      // el horario y una puerta — no una pregunta de vuelta. Reutiliza el
      // saludo completo en lugar de escribir una variante: es el mismo mensaje,
      // y tener dos que digan lo mismo es tener dos que se desincronicen.
      case 'greeting':
        return MENU_CTA_BODY_TEXT;
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
 * Etiqueta del botón cuando el enlace viene a CAMBIAR un pedido (0035).
 *
 * "Ver menú" sería mentir por omisión: lo que hay detrás no es la carta para
 * pedir otra cosa, es el mismo pedido para corregirlo. Quien lo toque tiene que
 * saber qué va a pasar antes de tocarlo.
 *
 * En MAYÚSCULAS desde el 04-09-2026, por decisión del negocio: el botón llega a
 * un cliente que acaba de pedir un cambio y tiene que distinguirse de un vistazo
 * del "Ver menú" de siempre. WhatsApp no admite formato dentro de un botón, así
 * que las mayúsculas son lo único que queda para diferenciarlos.
 *
 * Diecinueve caracteres, dentro del tope de veinte que impone WhatsApp: no cabe
 * ni una letra más.
 */
export const MENU_CHANGE_BUTTON_TEXT = 'MODIFICAR MI PEDIDO';

/**
 * Cuerpo del CTA que abre el pedido para corregirlo.
 *
 * ── Las tres cosas que tiene que decir ──────────────────────────────────────
 *
 *   1. de QUÉ pedido hablamos —su número y su total, para que no dude—;
 *   2. que TODAVÍA se puede, que es lo que le quita la urgencia de escribir;
 *   3. que al confirmar recibe el total nuevo, para que no pague el viejo.
 *
 * El punto 3 es el que evita el peor desenlace: que pague el QR anterior por un
 * pedido que acaba de cambiar. Por eso no se recorta aunque alargue el mensaje.
 */
export function orderChangeCtaText(
  orderNumber: string,
  totalAmount: number,
  /** `true` si el pedido se paga en efectivo: entonces no hay QR que mandar. */
  isCash = false,
): string {
  const cierre = isCash
    ? 'te mandamos el total actualizado'
    : 'te mandamos el total actualizado con el QR';
  return (
    `Tu pedido ${shortOrderNumber(orderNumber)} todavía no está pagado, así que ` +
    `podés cambiarlo 👇 Armálo de nuevo como lo querés y ${cierre}. ` +
    `Ahora mismo suma ${formatBs(totalAmount)}.`
  );
}

/** Una línea del pedido, tal como se le enseña al cliente. */
export interface OrderReviewLine {
  name: string;
  quantity: number;
  subtotal: number;
}

/**
 * "Tu pedido quedó así: ¿te falta algo?" (05-09-2026).
 *
 * ── Por qué se le ENSEÑA el pedido antes de ofrecerle cambiarlo ─────────────
 *
 * Porque el desglose es el dato que no tenía. El cliente conoce su total —se lo
 * dijimos— pero no lo que lo compone, y desde el chat no hay forma de mirarlo:
 * el menú ya se cerró. Pedirle que decida si le falta algo sin enseñarle lo que
 * lleva es pedirle que lo recuerde.
 *
 * ── Y por qué se le pregunta en vez de mandarle el botón directo ────────────
 *
 * Es una decisión del negocio, tomada con su coste sobre la mesa: cuesta un
 * turno más. A cambio, el cliente ve su pedido y elige, en vez de recibir un
 * botón que no pidió.
 *
 * ── La forma de la pregunta no es libre ─────────────────────────────────────
 *
 * "¿Querés agregar algo más?" y no "¿está bien tu pedido?": es lo que hace que
 * un "no" suelto signifique una sola cosa. Ver `order-review-reply.ts`, que la
 * lee. Cambiar esta frase sin cambiar aquel módulo rompe las respuestas.
 *
 * Los números son la parte fea y la que no se puede quitar: el sistema no lee
 * las respuestas de botón de WhatsApp, así que la única respuesta que no hay que
 * adivinar es un dígito. Los sinónimos los cubre el detector, porque casi nadie
 * va a contestar con el número.
 */
export function orderReviewText(input: {
  orderNumber: string;
  lines: readonly OrderReviewLine[];
  deliveryAmount: number;
  totalAmount: number;
  isCash: boolean;
}): string {
  const lineas = input.lines.map(
    (l) => `• ${l.quantity}x ${l.name} — ${formatBs(l.subtotal)}`,
  );

  // El envío solo si está cotizado: en `awaiting_location` todavía no existe, y
  // escribir "Envío: Bs. 0" diría que es gratis.
  const envio = input.deliveryAmount > 0 ? [`Envío: ${formatBs(input.deliveryAmount)}`] : [];

  // Cómo paga, en la misma línea del total: es lo que cierra la cuenta. Sin
  // total cotizado no se afirma ninguno.
  const comoPaga = input.isCash ? ' (pagás en efectivo al recibir)' : '';
  const total =
    input.totalAmount > 0 ? [`Total: ${formatBs(input.totalAmount)}${comoPaga}`] : [];

  return [
    `Tu pedido ${shortOrderNumber(input.orderNumber)} quedó así 👇`,
    '',
    ...lineas,
    ...envio,
    ...total,
    '',
    '¿Querés agregar algo más?',
    '  Respondé *1* para agregar algo',
    '  Respondé *2* si está bien así',
  ].join('\n');
}

/**
 * "Listo, queda así." La respuesta a quien contestó que no le falta nada.
 *
 * Cierra el turno y no propone nada más: quien acaba de decir que su pedido
 * está bien no necesita otra pregunta. Lo único que se le recuerda es lo que
 * todavía tiene que hacer —mandar el comprobante—, y solo cuando es cierto: en
 * efectivo no hay nada que mandar, se paga en la puerta.
 */
export function orderReviewKeptText(
  orderNumber: string,
  totalAmount: number,
  isCash = false,
): string {
  const cierre = isCash
    ? `Pagás ${formatBs(totalAmount)} en efectivo al recibirlo.`
    : 'Cuando puedas, mandanos la foto del comprobante por acá y lo pasamos a la cocina.';

  return `Listo, tu pedido ${shortOrderNumber(orderNumber)} queda así 🙌 ${cierre}`;
}

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
  /**
   * Etiqueta del botón. Por defecto "Ver menú": la única razón para cambiarla
   * es que el enlace haga otra cosa, como el de 0035, que abre el pedido para
   * corregirlo.
   */
  buttonText: string = MENU_CTA_BUTTON_TEXT,
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
          display_text: buttonText,
          url,
        },
      },
    },
  } as const;
}

// ── Recordatorio del comprobante (03-09-2026) ────────────────────────────────

/**
 * Lo que recibe quien ya tiene su pedido cotizado y todavía no mandó el pago.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * Desde que el botón del menú es la respuesta por defecto (`default-reply.ts`),
 * hay un cliente al que mandárselo sería contestarle a otra persona: el que ya
 * armó su pedido, recibió su total y su QR, y escribe mientras busca la foto del
 * comprobante. A ese no le falta el menú — le falta un paso, y es el único que
 * queda entre su pedido y la plancha.
 *
 * ── Lo que este texto NO puede parecer ──────────────────────────────────────
 *
 * No lleva el prefijo `📦 Pedido ` ni las etiquetas `Comida:` / `Delivery:` /
 * `Total:`. Esas son las MARCAS CANÓNICAS con las que `outbound-classify`
 * reconoce una confirmación, y un recordatorio que las llevara se emparejaría
 * con la notificación de otro mensaje al reconciliar. El número va en su forma
 * corta (`#7`), que además es la que el cliente reconoce.
 */
export function proofReminderText(orderNumber: string, totalAmount: number): string {
  return (
    `Tu pedido ${shortOrderNumber(orderNumber)} está guardado por ` +
    `${formatBs(totalAmount)} 🙌 Falta que nos mandes la foto del comprobante ` +
    'por acá y lo pasamos a la cocina al toque.'
  );
}

/**
 * Ya tenemos su comprobante y todavía no lo hemos mirado (04-09-2026).
 *
 * Es la otra mitad de `proofReminderText`. Al cliente que YA mandó su foto no
 * se le puede pedir otra —el 04-09 le pasó a uno, y acabó reenviándola tres
 * veces y hablando con una persona— pero tampoco se le puede dejar sin
 * respuesta: el que escribe después de pagar está preguntando si llegó.
 *
 * Dice las dos cosas que necesita y ninguna más: que la tenemos, y que no tiene
 * que hacer nada. No promete cuándo, porque eso depende de que alguien la mire.
 */
export function proofAckText(orderNumber: string): string {
  return (
    `Ya tenemos tu comprobante del pedido ${shortOrderNumber(orderNumber)} 🙌 ` +
    'Lo estamos revisando y te avisamos apenas lo pasemos a la cocina. ' +
    'No hace falta que lo mandes de nuevo.'
  );
}

/**
 * El pedido pasa a recojo porque el cliente dijo que se lo lleva él.
 *
 * Dice las TRES cosas que cambian para él, en el orden en que le importan: que
 * ya no hay envío, cuánto queda por pagar, y que no tiene que hacer nada con el
 * QR que ya tiene. Esa última frase es la que evita el mensaje siguiente:
 * cambiar el tipo de entrega no cambia lo que se paga por QR —el envío nunca
 * viajó en él, se cobraba en la puerta—, pero el cliente no tiene por qué
 * saberlo, y sin decírselo vuelve a preguntar.
 *
 * NO promete deshacerlo. Mientras no exista el camino de vuelta automático,
 * ofrecerlo sería la promesa que este proyecto no hace.
 */
export function pickupSwitchText(
  orderNumber: string,
  foodAmount: number,
  /** `true` si paga en efectivo: no hay QR, paga al recoger. */
  isCash = false,
): string {
  const pago = isCash
    ? `Ya no pagas envío: son ${formatBs(foodAmount)} y los pagas al recoger.`
    : `Ya no pagas envío: son ${formatBs(foodAmount)} y el QR que te mandamos sigue valiendo.`;
  return (
    `Listo 🛍️ Tu pedido ${shortOrderNumber(orderNumber)} queda para que lo recojas ` +
    `en el local. ${pago} Te avisamos apenas esté listo.`
  );
}

/**
 * Lo que recibe quien pide algo para la plancha sobre un pedido ya armado.
 *
 * ── Por qué no se le manda a rearmar el pedido ──────────────────────────────
 *
 * Porque "sin cebolla" no cambia ni una línea ni un centavo, y hacerle rehacer
 * todo su pedido por eso es desproporcionado — palabras del dueño el
 * 03-09-2026. Lo que sí hace falta es que la cocina se entere, y de eso se
 * encarga la nota; este mensaje solo lo confirma.
 *
 * La segunda frase es la que evita que esto se repita cada noche: le enseña
 * dónde va la próxima vez. Enseñar el sitio vale más que pedir disculpas por no
 * tenerlo.
 *
 * ── Por qué es más largo de lo que parece necesario (04-09-2026) ────────────
 *
 * La primera versión decía lo mismo en dos líneas y el dueño la leyó SECA. No
 * es un capricho de tono: el cliente que escribe "sin cebolla" está pidiendo un
 * favor, y una respuesta que solo confirma y da una instrucción se lee como un
 * reproche por haberlo pedido mal. Por eso el texto explica el PORQUÉ —que se
 * pierde entre los mensajes de otros clientes— y cierra agradeciendo.
 *
 * El texto es del dueño, palabra por palabra. No se "corrige" de estilo.
 *
 * Se afirma SOLO lo que ya ocurrió: cuando este texto sale, la nota está escrita
 * en el pedido y la comanda la lleva. Es la misma regla que gobierna el resto de
 * los salientes — nada de "se lo vamos a pasar".
 */
export const KITCHEN_NOTE_ACK_TEXT =
  '¡Claro que sí! Ya se lo anotamos a la cocina 🙌 La próxima puedes escribirlo ' +
  'en los comentarios al armar tu pedido por favor, así no se nos perdera entre ' +
  'los msjs con otros clientes, todo esto es para darte la mejor atencion, ' +
  'muchas gracias por su preferencia.';

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
