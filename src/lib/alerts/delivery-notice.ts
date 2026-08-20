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
 * ── Sobre la ubicación ──────────────────────────────────────────────────────
 *
 * El dato que de verdad sirve es el enlace de mapa: se toca y abre la
 * navegación al punto exacto. La dirección en texto va como contexto —ayuda a
 * saber si es lejos antes de abrir nada— pero NUNCA la sustituye: el geocoding
 * inverso en Santa Cruz devuelve cosas como "Calle 1", que no identifican nada.
 * Por eso el enlace siempre está y la dirección es opcional.
 */

/** Línea de producto ya resuelta (nombre real del pedido, no del catálogo). */
export interface DeliveryNoticeItem {
  name: string;
  quantity: number;
}

export interface DeliveryNoticeInput {
  orderNumber: string;
  customerName: string | null;
  /** Dígitos normalizados; se muestra tal cual para poder llamar. */
  customerPhone: string;
  items: DeliveryNoticeItem[];
  /** Tarifa de envío en Bs, ya cotizada. */
  deliveryAmount: number;
  /** Total del pedido en Bs (productos + envío). */
  totalAmount: number;
  latitude: number;
  longitude: number;
  /** Dirección aproximada (geocoding inverso o la que mandó WhatsApp). */
  address: string | null;
  /** Distancia de ruta en metros, si se conoce. */
  distanceMeters: number | null;
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
 */
export function buildDeliveryNotice(input: DeliveryNoticeInput): string {
  const lines: string[] = [];

  lines.push(`🛵 Pedido ${input.orderNumber}`);
  lines.push('');

  const nombre = (input.customerName ?? '').trim();
  lines.push(`Cliente: ${nombre === '' ? 'sin nombre' : nombre}`);
  lines.push(`Teléfono: ${input.customerPhone}`);
  lines.push('');

  // Cantidades explícitas: en la moto se lee de un vistazo y se verifica la
  // bolsa contra esta lista.
  const total = input.items.reduce((sum, i) => sum + i.quantity, 0);
  lines.push(`Pedido (${total} ${total === 1 ? 'producto' : 'productos'}):`);
  for (const item of input.items) {
    lines.push(`  ${item.quantity}x ${item.name}`);
  }
  lines.push('');

  const distancia = input.distanceMeters === null ? '' : ` · ${formatDistance(input.distanceMeters)}`;
  lines.push(`Envío: Bs ${formatBs(input.deliveryAmount)}${distancia}`);
  lines.push(`Total a cobrar: Bs ${formatBs(input.totalAmount)}`);
  lines.push('');

  const direccion = (input.address ?? '').trim();
  if (direccion !== '') {
    // "aprox." es literal y deliberado: viene de geocoding inverso y puede
    // estar a cuadras del punto real. Quien reparte debe guiarse por el enlace.
    lines.push(`Zona (aprox.): ${direccion}`);
  }
  lines.push(`Ubicación: ${mapsLink(input.latitude, input.longitude)}`);

  return lines.join('\n');
}
