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
  kind: 'opening' | 'closing';
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
export const CLOSING_NOTICE_FROM = hm(3, 50);
export const CLOSING_NOTICE_UNTIL = hm(4, 15);

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
export function serviceNoticeAt(ms: number): ServiceNotice | null {
  const minuto = boliviaMinutes(ms);

  if (minuto >= OPENING_NOTICE_FROM && minuto < OPENING_NOTICE_UNTIL) return OPENING;
  if (minuto >= CLOSING_NOTICE_FROM && minuto < CLOSING_NOTICE_UNTIL) return CLOSING;

  return null;
}
