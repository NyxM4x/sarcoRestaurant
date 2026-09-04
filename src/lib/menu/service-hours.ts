import { BOLIVIA_UTC_OFFSET_MS } from '@/lib/orders/business-day';

/**
 * El aviso de horario del menú — módulo PURO.
 *
 * Don Zarco atiende de 18:00 a 04:00. El menú está abierto a cualquier hora
 * —el enlace llega por WhatsApp y la gente lo abre cuando quiere— así que hay
 * dos momentos en los que hace falta decir algo, y solo dos:
 *
 *   · 17:30–18:00  el local está por abrir. Se puede ir armando el pedido.
 *   · 03:50–04:15  el cierre está encima. Se acepta la solicitud, pero se
 *                  advierte de que hay que consultar si todavía da tiempo.
 *
 * Fuera de esas dos franjas NO se muestra nada. Ni de madrugada cerrada, ni a
 * media tarde: un cartel permanente deja de leerse a los dos días, y el resto
 * del horario ya se responde por WhatsApp cuando alguien pregunta.
 *
 * ── Por qué franjas y no "¿está abierto?" ───────────────────────────────────
 *
 * Un indicador de abierto/cerrado tendría que aparecer siempre —el estado
 * siempre existe— y contestaría a una pregunta que nadie hizo. Estas dos franjas
 * son las ÚNICAS en las que el cliente puede llevarse una sorpresa: pedir tres
 * minutos antes de abrir, o cinco antes de cerrar. El aviso existe para eso.
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
  kind: 'opening' | 'closing' | 'after_hours' | 'closed';
  title: string;
  body: string;
}

/** Minutos desde medianoche, hora boliviana. */
function boliviaMinutes(ms: number): number {
  const d = new Date(ms - BOLIVIA_UTC_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

const hm = (h: number, m: number): number => h * 60 + m;

/** Apertura: media hora antes de las 18:00. */
export const OPENING_NOTICE_FROM = hm(17, 30);
export const OPENING_NOTICE_UNTIL = hm(18, 0);

/** Cierre: desde diez minutos antes de las 04:00 y hasta el cuarto de hora. */
/**
 * El día entero con el local cerrado (04-09-2026).
 *
 * Entre las 05:30 y las 17:30 el menú se veía EXACTAMENTE igual que a las diez
 * de la noche: precios, fotos y el botón de pedir, sin una palabra que dijera
 * que no hay nadie en la plancha. El cliente que entra a media tarde arma su
 * pedido creyendo que le llega, y lo que recibe es silencio hasta las seis.
 *
 * ── Por qué empieza a las 05:00 y no a las 04:00 ────────────────────────────
 *
 * Porque la hora de después del cierre tiene su propio aviso: hasta las 05:00
 * la plancha puede seguir prendida y lo que se le dice al cliente es que
 * preguntamos (`AFTER_HOURS`). A las 05:00 ya no hay nada que preguntar.
 *
 * ── Y por qué termina a las 17:30 ───────────────────────────────────────────
 *
 * Porque ahí empieza el aviso de apertura, que dice algo mejor: que ya se puede
 * ir armando el pedido. Las dos franjas se tocan sin pisarse.
 */
export const CLOSED_NOTICE_FROM = hm(5, 0);
export const CLOSED_NOTICE_UNTIL = hm(17, 30);

export const CLOSING_NOTICE_FROM = hm(3, 50);
export const CLOSING_NOTICE_UNTIL = hm(4, 0);

/**
 * La hora en la que la plancha PUEDE seguir prendida (04:00–05:00).
 *
 * El horario termina a las 04:00, pero no todas las noches a la misma hora
 * real: hay días en que se sigue sirviendo un rato. Esa hora no es "abierto"
 * —prometerlo sería mentir la mitad de las noches— ni "cerrado" —decirlo echa a
 * un cliente al que sí se le habría preparado—. Es la única franja en la que la
 * respuesta honesta es "preguntamos y te decimos".
 */
export const AFTER_HOURS_NOTICE_FROM = hm(4, 0);
export const AFTER_HOURS_NOTICE_UNTIL = hm(5, 0);

const OPENING: ServiceNotice = {
  kind: 'opening',
  title: 'Estamos abriendo',
  // Se le dice qué PUEDE hacer ya, no solo que espere. Quien abre el menú a las
  // 17:45 viene decidido: si lo único que lee es "todavía no", se va.
  body: 'Abrimos a las 18:00, pero ya puedes ir armando tu pedido.',
};

const CLOSING: ServiceNotice = {
  kind: 'closing',
  title: 'Atención fuera de horario',
  // No promete y no niega: dice exactamente qué va a pasar. Prometer a las 04:05
  // que se prepara sería mentir la mitad de las noches.
  body:
    'Nuestro horario habitual termina a las 04:00. Puedes enviar tu solicitud y ' +
    'consultaremos si todavía es posible preparar tu pedido.',
};

/**
 * Qué aviso toca en este instante, o `null` si ninguno.
 *
 * Las dos franjas son cerradas por abajo y ABIERTAS por arriba: a las 18:00 en
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
    'Abrimos hoy a las 18:00. Puedes dejar tu pedido armado, pero recién lo ' +
    'preparamos cuando abramos.',
};

/**
 * Pasadas las 04:00, cuando todavía puede quedar plancha.
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
  if (minuto >= CLOSING_NOTICE_FROM && minuto < CLOSING_NOTICE_UNTIL) return CLOSING;
  if (minuto >= AFTER_HOURS_NOTICE_FROM && minuto < AFTER_HOURS_NOTICE_UNTIL) return AFTER_HOURS;
  if (minuto >= CLOSED_NOTICE_FROM && minuto < CLOSED_NOTICE_UNTIL) return CLOSED;

  return null;
}
