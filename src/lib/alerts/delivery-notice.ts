/**
 * Aviso del pedido al grupo de reparto — módulo PURO.
 *
 * Construye el texto que se manda por Telegram cuando un pedido de delivery
 * queda confirmado y cotizado. Sin red, sin Supabase: recibe los datos ya
 * cargados y devuelve una cadena.
 *
 * ── Por qué este mensaje SÍ lleva datos personales ──────────────────────────
 *
 * `./alert-message` construye alertas TÉCNICAS y tiene prohibido incluir
 * teléfono, nombre o coordenadas: van a un canal de incidencias y esos datos no
 * ayudarían a resolver ninguna. Este módulo es lo contrario: su destinatario es
 * quien va a llevar el pedido, y sin nombre, teléfono y ubicación no puede
 * hacer su trabajo.
 *
 * La diferencia está en el destino, no en el descuido: este texto va al grupo
 * privado de reparto del negocio. No se registra en logs ni se expone por HTTP.
 *
 * ── Sobre la ubicación: solo el enlace ──────────────────────────────────────
 *
 * El aviso llevaba también la dirección en texto, como contexto para saber si
 * era lejos antes de abrir nada. Se quitó el 02-09-2026, y el motivo es que ese
 * contexto no existía: el geocoding inverso en Santa Cruz devuelve "Calle 1,
 * Santa Cruz de la Sierra, Departamento de Santa Cruz, Bolivia" —una línea que
 * ocupa dos renglones en el celular y no distingue un punto de otro—.
 *
 * La distancia, que sí dice si es lejos, ya va en la línea del envío.
 *
 * De paso deja de pedirse un geocoding inverso por pedido: era una llamada de
 * pago a Mapbox para producir un adorno que nadie podía usar.
 */

/** Línea de producto ya resuelta (nombre real del pedido, no del catálogo). */
export interface DeliveryNoticeItem {
  name: string;
  quantity: number;
}

/**
 * Qué se cobra al entregar. Lo calcula `deliveryCollectOf` en cocina y llega
 * aquí ya resuelto: este módulo no deduce nada del pago, solo lo escribe.
 *
 * `null` = no se pudo determinar, y entonces no se escribe ninguna línea. Es
 * mejor que una instrucción que nadie comprobó: el repartidor siempre puede
 * preguntar, pero no puede deshacer un cobro.
 */
export type DeliveryNoticeCollect =
  | { kind: 'pagado' }
  | { kind: 'envio' }
  | { kind: 'todo'; amount: number };

export interface DeliveryNoticeInput {
  orderNumber: string;
  customerName: string | null;
  /** Dígitos normalizados; se muestra tal cual para poder llamar. */
  customerPhone: string;
  items: DeliveryNoticeItem[];
  /** Tarifa de envío en Bs, ya cotizada. */
  deliveryAmount: number;
  /**
   * La comida sin el envío, en Bs. Solo se escribe en el aviso de EFECTIVO.
   *
   * En un pedido por QR esa cifra ya está cobrada y ponerla delante de quien
   * reparte solo añade un número que no tiene que pedir.
   */
  subtotalAmount: number;
  /**
   * ¿Paga en efectivo al recibir? (04-09-2026)
   *
   * Cambia el mensaje entero, no una línea: quien lleva un pedido en efectivo
   * cobra la comida Y el envío, y necesita el desglose para dar el vuelto. En
   * QR el desglose sobra, porque lo único cobrable es el envío.
   */
  isCash: boolean;
  /**
   * Qué se cobra en la puerta. Sustituye al total del pedido, que se quitó el
   * 03-09-2026: ver `buildDeliveryNotice`.
   */
  collect: DeliveryNoticeCollect | null;
  latitude: number;
  longitude: number;
  /** Distancia de ruta en metros, si se conoce. */
  distanceMeters: number | null;
}

/**
 * Escapa lo que va dentro de un mensaje con `parse_mode: HTML`.
 *
 * Se aplica a TODO lo variable: el nombre del cliente, los nombres de los
 * productos y los enlaces —el de Maps lleva un `&` que sin escapar puede
 * comerse el resto de la URL—. Las únicas etiquetas del mensaje son las que
 * pone este módulo.
 *
 * Tres caracteres, que son los tres que Telegram exige en modo HTML.
 */
export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Bs con dos decimales solo cuando hacen falta: "16" y no "16.00". */
function formatBs(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** Kilómetros con un decimal: 5762 m → "5.8 km". */
function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * El número tal como se lee en Telegram: `ORD-260902-009` → `ORD-009`.
 *
 * En el grupo de reparto, quien toma un pedido RESPONDE al mensaje —casi
 * siempre con un sticker— y de la cita solo queda visible el principio de su
 * primera línea. Con la jornada dentro del número, `ORD-260902-009` se corta
 * antes de llegar al correlativo y dos pedidos de la misma noche se citan
 * idénticos: nadie sabe cuál agarró cada uno, que es justo para lo que se
 * responde.
 *
 * La fecha no se pierde, se deja de PINTAR aquí. `orders.order_number` sigue
 * siendo el completo en la base, en el panel y en cocina, que es donde sirve
 * —reinicia la numeración cada jornada y distingue el pedido 9 de anoche del
 * pedido 9 de hoy—. Este recorte es de presentación y de un solo canal.
 *
 * Un número que no tenga esta forma —los de la numeración vieja, `ORD-000123`—
 * se devuelve entero: recortar a ciegas produciría un número que no existe.
 */
export function shortOrderNumber(orderNumber: string): string {
  const partes = /^ORD-\d{6}-(\d+)$/.exec(orderNumber.trim());
  return partes === null ? orderNumber : `ORD-${partes[1]}`;
}

/**
 * El teléfono, como enlace directo al chat de WhatsApp del cliente.
 *
 * En la moto nadie copia un número para pegarlo en otra app: se toca. `wa.me`
 * abre la conversación de un golpe, y el número se sigue leyendo dentro del
 * propio enlace —así que escribirlo además aparte sería el mismo dato dos veces
 * en un mensaje que se lee de un vistazo—.
 *
 * Si no queda ningún dígito que enlazar, se escribe lo que haya tal cual: un
 * enlace roto es peor que un número que hay que teclear a mano.
 */
export function whatsappLink(phone: string): string {
  const digitos = phone.replace(/\D+/g, '');
  return digitos === '' ? phone : `https://wa.me/${digitos}`;
}

/**
 * Enlace de mapa con las coordenadas exactas.
 *
 * Google Maps y no Mapbox a propósito: es la app que el repartidor ya tiene
 * instalada, y el enlace abre la navegación directamente desde el celular.
 */
export function mapsLink(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

/**
 * Texto del aviso al grupo de reparto.
 *
 * Sin markdown: se envía como texto plano y los asteriscos o guiones bajos de
 * un nombre de cliente romperían el formato o el envío.
 *
 * ── Por qué ya no lleva el total del pedido (03-09-2026) ────────────────────
 *
 * Porque a quien lo lee no le sirve, y encima confundía. El repartidor no cobra
 * la comida: por QR se paga antes, y cocina no suelta un pedido sin comprobante
 * que cuadre con el subtotal. Lo único que puede tener que cobrar en la puerta
 * es el envío — y "Total a cobrar: Bs 31" junto a "Envío: Bs 13" es un mensaje
 * que ofrece dos cifras sin decir cuál de las dos hay que pedir.
 *
 * En su lugar va la INSTRUCCIÓN, sola en su renglón y en mayúsculas: qué hacer,
 * no qué sumar. Y no repite la cifra del envío, que ya está en la línea de
 * arriba: el mismo número dos veces, en un mensaje que se lee de reojo y en la
 * moto, es una oportunidad de leer el equivocado.
 */
export function buildDeliveryNotice(input: DeliveryNoticeInput): string {
  const lines: string[] = [];

  // Solo el número, sin emoji y sin la palabra "Pedido": lo que Telegram
  // enseña al citar el mensaje es el principio de esta línea, y cualquier cosa
  // por delante empuja fuera lo único que hay que leer ahí.
  lines.push(shortOrderNumber(input.orderNumber));
  lines.push('');

  const nombre = (input.customerName ?? '').trim();
  lines.push(`Cliente: ${escapeTelegramHtml(nombre === '' ? 'sin nombre' : nombre)}`);
  lines.push(`Teléfono: ${escapeTelegramHtml(whatsappLink(input.customerPhone))}`);
  lines.push('');

  // Cantidades explícitas: en la moto se lee de un vistazo y se verifica la
  // bolsa contra esta lista.
  const total = input.items.reduce((sum, i) => sum + i.quantity, 0);
  lines.push(`Pedido (${total} ${total === 1 ? 'producto' : 'productos'}):`);
  for (const item of input.items) {
    lines.push(`  ${item.quantity}x ${escapeTelegramHtml(item.name)}`);
  }
  lines.push('');

  const distancia = input.distanceMeters === null ? '' : ` · ${formatDistance(input.distanceMeters)}`;

  if (input.isCash) {
    // ── EFECTIVO ────────────────────────────────────────────────────────────
    //
    // Aquí el repartidor no comprueba un cobro: lo hace. Va el desglose entero
    // —comida, envío y suma— porque es lo que tiene que pedir en la puerta y lo
    // que necesita para dar el vuelto, y va el aviso en negrita arriba del todo
    // porque lo primero que cambia su trabajo es que este pedido no está pagado.
    //
    // El total se calcula aquí y no se recibe: sumar dos cifras que ya están en
    // el mensaje no puede dar una tercera distinta de la que el cliente vio.
    lines.push('<b>QUIERE EFECTIVO</b>');
    lines.push(`Productos: Bs ${formatBs(input.subtotalAmount)}`);
    lines.push(`Envío: Bs ${formatBs(input.deliveryAmount)}${distancia}`);
    lines.push(`TOTAL A COBRAR: Bs ${formatBs(input.subtotalAmount + input.deliveryAmount)}`);
    lines.push('');
  } else {
    lines.push(`Envío: Bs ${formatBs(input.deliveryAmount)}${distancia}`);
    lines.push('');

    // Lo que se busca con la vista al llegar a la puerta. `null` no escribe nada.
    const instruccion = collectLine(input.collect);
    if (instruccion !== null) {
      lines.push(instruccion);
      lines.push('');
    }
  }

  lines.push(`Ubicación: ${escapeTelegramHtml(mapsLink(input.latitude, input.longitude))}`);

  return lines.join('\n');
}

/**
 * La línea de la instrucción.
 *
 * `envio` NO repite el monto: ya está arriba, y es la única cifra cobrable del
 * mensaje. `todo` sí lo lleva, porque ahí se cobra la comida más el envío y esa
 * suma no aparece en ningún otro sitio. Hoy no llega por este canal —el aviso
 * sale al aceptar un pago por QR— pero si algún día llega, quien reparte no
 * puede quedarse sin la cifra.
 */
function collectLine(collect: DeliveryNoticeCollect | null): string | null {
  if (collect === null) return null;
  if (collect.kind === 'pagado') return 'ENVÍO PAGADO';
  if (collect.kind === 'envio') return 'COBRAR ENVÍO';
  return `COBRAR TODO: Bs ${formatBs(collect.amount)}`;
}
