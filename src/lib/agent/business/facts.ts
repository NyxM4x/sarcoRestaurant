/**
 * DATOS DUROS del negocio (Don Zarco) — módulo PURO.
 *
 * Aquí vive lo ÚNICO del negocio que el agente puede afirmar de memoria, sin
 * consultar una herramienta: horario y ubicación. Todo lo demás —productos,
 * precios, disponibilidad— sigue viniendo de `get_menu_items`, que lee la misma
 * tabla que la web.
 *
 * ── Por qué existe este archivo ─────────────────────────────────────────────
 *
 * El prompt se escribió con una regla dura: CERO datos de negocio adentro. La
 * razón sigue siendo buena — un dato pegado en el prompt parece verificado sin
 * serlo, y queda congelado en el commit mientras el negocio cambia.
 *
 * El horario y la dirección son la excepción deliberada: no existe ninguna
 * tabla que los guarde, cambian muy rara vez, y son las dos preguntas más
 * frecuentes de WhatsApp. Dejarlos fuera obligaba a derivar a una persona la
 * mitad de las consultas.
 *
 * La excepción se paga con disciplina: son POCOS, viven SOLO aquí, y se
 * inyectan al prompt desde este módulo. Si el negocio cambia de horario o se
 * muda, se edita este archivo y nada más — pero hace falta un despliegue, así
 * que no sirve para cierres temporales ni feriados.
 *
 * Lo que NO va aquí: precios, productos, promociones, tiempos de entrega,
 * tarifas de delivery ni nada que ya tenga una fuente de verdad en la base.
 */

/** Cómo se presenta el negocio. */
export const BUSINESS_NAME = 'Don Zarco';

/** Qué vende y dónde, en una línea. */
export const BUSINESS_DESCRIPTION =
  'un local de trancapechos cochabambinos en Santa Cruz, Bolivia';

/**
 * Horario de atención, redactado tal como el agente puede repetirlo.
 *
 * Es el horario REGULAR. El agente nunca deduce de aquí si está abierto en este
 * momento: no tiene reloj confiable, no sabe de feriados y no sabe si hoy
 * cerraron antes. Esa restricción viaja en el prompt.
 */
export const BUSINESS_HOURS = 'todos los días, de seis de la tarde a cuatro de la madrugada';

/**
 * El mismo horario en números, para lo que no es conversación.
 *
 * `BUSINESS_HOURS` está redactado para que el agente lo repita en voz alta;
 * esto es el dato. Se declaran juntos a propósito: separarlos garantiza que un
 * día se cambie uno y no el otro, y entonces el agente diría una hora mientras
 * el sistema opera con otra.
 */
export const BUSINESS_OPENS_HOUR = 18;
export const BUSINESS_CLOSES_HOUR = 4;

/**
 * El horario en formato reloj: `18:00 a 04:00`.
 *
 * Lo usan los mensajes automáticos, que no conversan y donde la prosa sobra.
 * Se DERIVA de las horas de arriba en vez de escribirse aparte: la copia a mano
 * que había en `kapso/messages.ts` se quedó desactualizada exactamente como
 * avisaba su propio comentario que pasaría.
 */
export function businessHoursClock(): string {
  const dosDigitos = (h: number) => String(h).padStart(2, '0');
  return `${dosDigitos(BUSINESS_OPENS_HOUR)}:00 a ${dosDigitos(BUSINESS_CLOSES_HOUR)}:00`;
}

/** Enlace oficial de Google Maps del local. */
export const BUSINESS_MAPS_URL = 'https://maps.app.goo.gl/NL8foBoiySELVKMr8?g_st=ic';

/**
 * Dirección en palabras (calle, barrio o referencia).
 *
 * `null` mientras el cliente no la confirme por escrito. Con `null`, el agente
 * responde SOLO con el enlace de Maps: es preferible a inventar una calle o a
 * transcribir mal un barrio. Al completarla, entra sola al prompt.
 */
export const BUSINESS_ADDRESS: string | null =
  'sobre la avenida Doble Vía La Guardia, frente al Hipermaxi Las Palmas';

/**
 * Bloque de "hechos del negocio" que se inyecta en el system prompt.
 *
 * ── La dirección y el enlace van JUNTOS, y es una orden ─────────────────
 *
 * Antes decía "el enlace es este y puedes compartirlo tal cual". Eso es un
 * permiso, no una instrucción, y el modelo hacía lo que hace cualquiera con un
 * permiso: unas veces sí y otras no. Desde que la dirección está escrita a mano
 * ya tenía algo que responder, así que soltaba la calle y se dejaba el enlace
 * —justo la regresión que se notó (02-09-2026)—.
 *
 * Y son las dos cosas porque cada una sola falla de una forma distinta: la
 * dirección sin enlace obliga al cliente a buscarla a mano, y el enlace sin
 * dirección obliga a abrir el navegador solo para saber si queda cerca.
 *
 * ── Que hay un solo local es un HECHO, no un dato que falte ──────────────
 *
 * "¿Están también en otra zona?" se contestaba con "no tengo esa información",
 * porque la sección "Cuando no sabes" del prompt recoge todo lo que no esté
 * escrito aquí. Pero no es que se ignore: es que no hay más locales. Se dice
 * explícitamente para que el agente afirme en vez de encogerse de hombros.
 */
export function businessFactsBlock(): string {
  const ubicacion =
    BUSINESS_ADDRESS === null
      ? `- Dónde están: no tienes la dirección escrita, así que no la inventes ni la describas. Cuando pregunten por la ubicación, pasa el enlace de Google Maps tal cual, escrito entero dentro del mensaje: ${BUSINESS_MAPS_URL}`
      : `- Dónde están: ${BUSINESS_ADDRESS}. Cuando pregunten por la ubicación, responde SIEMPRE con las dos cosas en el mismo mensaje: esa dirección en palabras y el enlace de Google Maps ${BUSINESS_MAPS_URL} escrito entero. Nunca una sin la otra.`;

  return [
    'Lo único que sabes de memoria (y puedes decir sin consultar nada):',
    `- Horario de atención: ${BUSINESS_HOURS}.`,
    ubicacion,
    '- Es su ÚNICO local: no hay sucursales ni otro punto de venta. Si preguntan si están en otra zona, en otro barrio o si tienen otra sede, contesta que no, que solo atienden en esa dirección. Eso lo sabes: no es un dato que te falte, así que no respondas que no tienes la información.',
    '- Hacen delivery en moto a domicilio. El costo lo calcula el sistema con la ubicación del cliente, en el momento; tú nunca lo estimas.',
    '- Fuera de lo anterior, no tienes ningún dato del negocio en la cabeza.',
  ].join('\n');
}
