import { BOLIVIA_UTC_OFFSET_MS } from '@/lib/orders/business-day';

/**
 * El aviso de horario del menú — módulo PURO.
 *
 * Don Zarco atiende de 19:00 a 04:00 (20-09-2026: antes abría a las 18:00). El
 * menú está abierto a cualquier hora —el enlace llega por WhatsApp y la gente
 * lo abre cuando quiere—, así que fuera del servicio hay que decirle al cliente
 * en qué momento entró:
 *
 *   · 18:30–19:00  el local está por abrir. Se puede ir armando el pedido.
 *   · 19:00–03:50  se está sirviendo: NO se muestra nada.
 *   · 03:50–04:15  el cierre está encima. Se acepta la solicitud, pero se
 *                  advierte de que hay que consultar si todavía da tiempo.
 *   · 04:15–18:30  cerrado. Es la franja larga, y la que más se ve.
 *
 * Las cuatro se tocan sin pisarse y sin dejar un minuto mudo: de las 03:50 a
 * las 19:00 SIEMPRE hay un cartel. Es deliberado — un hueco de quince minutos
 * con el local cerrado deja el menú exactamente igual que cuando está abierto,
 * que es el engaño que todo esto vino a corregir.
 *
 * ── Por qué franjas y no "¿está abierto?" ───────────────────────────────────
 *
 * Un indicador de abierto/cerrado sería un semáforo: mismo peso a las tres de
 * la tarde que a las 03:55, cuando lo que el cliente necesita saber en cada
 * momento es distinto. Cada franja dice qué le va a pasar a SU pedido si lo
 * manda ahora, que es la única pregunta que se está haciendo.
 *
 * ── La hora ─────────────────────────────────────────────────────────────────
 *
 * Zona del negocio, con el desfase fijo de Bolivia (UTC−4) igual que
 * `orders/business-day.ts`: el país no tiene horario de verano, así que no hace
 * falta la base de datos de zonas horarias del entorno.
 *
 * El instante llega como argumento y no se lee del reloj: una función que
 * consulta la hora por su cuenta no se puede probar, y aquí hay que poder
 * afirmar qué pasa el minuto antes y el minuto después de cada frontera.
 */

/** Aviso a mostrar, ya resuelto. `null` = no mostrar nada. */
export interface ServiceNotice {
  kind: 'opening' | 'after_hours' | 'closed';
  title: string;
  body: string;
}

/** Minutos desde medianoche, hora boliviana. */
function boliviaMinutes(ms: number): number {
  const d = new Date(ms - BOLIVIA_UTC_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

const hm = (h: number, m: number): number => h * 60 + m;

/** Apertura: media hora antes de las 19:00. */
export const OPENING_NOTICE_FROM = hm(18, 30);
export const OPENING_NOTICE_UNTIL = hm(19, 0);

/** Cierre: desde diez minutos antes de las 04:00 y hasta el cuarto de hora. */
/**
 * El día entero con el local cerrado (04-09-2026).
 *
 * Entre las 05:30 y las 17:30 el menú se veía EXACTAMENTE igual que a las diez
 * de la noche: precios, fotos y el botón de pedir, sin una palabra que dijera
 * que no hay nadie en la plancha. El cliente que entra a media tarde arma su
 * pedido creyendo que le llega, y lo que recibe es silencio hasta las seis.
 *
 * ── Por qué empieza a las 04:15 y no a las 04:00 ────────────────────────────
 *
 * Porque el tramo del cierre tiene su propio aviso: hasta las 04:15 la plancha
 * puede seguir prendida y lo que se le dice al cliente es que preguntamos
 * (`AFTER_HOURS`). A las 04:15 ya no hay nada que preguntar.
 *
 * Empieza EXACTAMENTE donde termina aquel, no un minuto después. El 20-09-2026
 * se propuso dejarlo arrancar a las 04:30, y eso abría un hueco de quince
 * minutos con el local ya cerrado en el que el menú —precios, fotos, botón de
 * pedir— se veía igual que a las diez de la noche.
 *
 * ── Y por qué termina a las 18:30 ───────────────────────────────────────────
 *
 * Porque ahí empieza el aviso de apertura, que dice algo mejor: que ya se puede
 * ir armando el pedido. Las dos franjas se tocan sin pisarse.
 */
export const CLOSED_NOTICE_FROM = hm(4, 15);
export const CLOSED_NOTICE_UNTIL = hm(18, 30);

/**
 * El rato en el que la plancha PUEDE seguir prendida (03:50–04:15).
 *
 * 20-09-2026: llegaba hasta las 05:00 y se recortó a las 04:15. El local pasó a
 * cerrar de verdad más temprano, y una hora entera de "puede que alcancemos"
 * prometía una gracia que ya casi nunca se cumple.
 *
 * El horario termina a las 04:00, pero no todas las noches a la misma hora
 * real: hay días en que se sigue sirviendo un rato. Ese tramo no es "abierto"
 * —prometerlo sería mentir la mitad de las noches— ni "cerrado" —decirlo echa a
 * un cliente al que sí se le habría preparado—. Es la única franja en la que la
 * respuesta honesta es "preguntamos y te decimos".
 *
 * ── Por qué empieza ANTES del cierre ────────────────────────────────────────
 *
 * Hasta el 04-09-2026 los diez minutos previos tenían su propio cartel
 * ("atención fuera de horario"), y decía casi lo mismo con otras palabras. Dos
 * carteles seguidos para la misma duda es un cartel de más: el cliente que
 * escribe a las 03:55 y el que escribe a las 04:30 están en la misma situación
 * —puede que alcance, puede que no— y merecen la misma frase.
 */
export const AFTER_HOURS_NOTICE_FROM = hm(3, 50);
export const AFTER_HOURS_NOTICE_UNTIL = hm(4, 15);

const OPENING: ServiceNotice = {
  kind: 'opening',
  title: 'Estamos abriendo',
  // Se le dice qué PUEDE hacer ya, no solo que espere. Quien abre el menú a las
  // 17:45 viene decidido: si lo único que lee es "todavía no", se va.
  body: 'Abrimos a las 19:00, pero ya puedes ir armando tu pedido.',
};

/**
 * Qué aviso toca en este instante, o `null` si ninguno.
 *
 * Las franjas son cerradas por abajo y ABIERTAS por arriba: a las 19:00 en
 * punto el local ya abrió y el cartel de "estamos abriendo" sobra. Es el mismo
 * criterio que gobierna el vencimiento de una promoción.
 */
/**
 * El local está cerrado y falta mucho para abrir.
 *
 * Dice la hora de apertura y qué puede hacer mientras tanto, como los otros dos
 * avisos. Lo que NO hace es prometer que el pedido se prepara ya: es la única
 * franja en la que no hay nadie en la cocina, y de eso justamente avisa.
 */
const CLOSED: ServiceNotice = {
  kind: 'closed',
  title: 'Estamos cerrados',
  body:
    'Abrimos hoy a las 19:00. Puedes dejar tu pedido armado, pero recién lo ' +
    'preparamos cuando abramos.',
};

/**
 * El tramo del cierre, cuando todavía puede quedar plancha.
 *
 * No promete y no niega, igual que el aviso de cierre: dice exactamente qué va a
 * pasar con su pedido, que es que alguien va a preguntar. Es lo único cierto a
 * esa hora.
 */
const AFTER_HOURS: ServiceNotice = {
  kind: 'after_hours',
  title: 'Puede que todavía alcancemos',
  body:
    'Nuestro horario termina a las 04:00, pero a veces la plancha sigue ' +
    'prendida. Manda tu pedido y consultamos si aún te lo podemos preparar.',
};

export function serviceNoticeAt(ms: number): ServiceNotice | null {
  const minuto = boliviaMinutes(ms);

  if (minuto >= OPENING_NOTICE_FROM && minuto < OPENING_NOTICE_UNTIL) return OPENING;
  if (minuto >= AFTER_HOURS_NOTICE_FROM && minuto < AFTER_HOURS_NOTICE_UNTIL) return AFTER_HOURS;
  if (minuto >= CLOSED_NOTICE_FROM && minuto < CLOSED_NOTICE_UNTIL) return CLOSED;

  return null;
}
