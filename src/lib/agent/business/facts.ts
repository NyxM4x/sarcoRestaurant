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
export const BUSINESS_HOURS = 'todos los días, de nueve de la noche a cuatro de la madrugada';

/** Enlace oficial de Google Maps del local. */
export const BUSINESS_MAPS_URL = 'https://maps.app.goo.gl/DLJZvSY7GyJNzccD9';

/**
 * Dirección en palabras (calle, barrio o referencia).
 *
 * `null` mientras el cliente no la confirme por escrito. Con `null`, el agente
 * responde SOLO con el enlace de Maps: es preferible a inventar una calle o a
 * transcribir mal un barrio. Al completarla, entra sola al prompt.
 */
export const BUSINESS_ADDRESS: string | null =
  'sobre la avenida Doble Vía La Guardia, frente al Hipermaxi Las Palmas';

/** Bloque de "hechos del negocio" que se inyecta en el system prompt. */
export function businessFactsBlock(): string {
  const ubicacion =
    BUSINESS_ADDRESS === null
      ? `- Dónde están: no tienes la dirección escrita, así que no la inventes ni la describas. Comparte el enlace de Google Maps tal cual: ${BUSINESS_MAPS_URL}`
      : `- Dónde están: ${BUSINESS_ADDRESS}. El enlace de Google Maps es ${BUSINESS_MAPS_URL} y puedes compartirlo tal cual.`;

  return [
    'Lo único que sabes de memoria (y puedes decir sin consultar nada):',
    `- Horario de atención: ${BUSINESS_HOURS}.`,
    ubicacion,
    '- Hacen delivery en moto a domicilio. El costo lo calcula el sistema con la ubicación del cliente, en el momento; tú nunca lo estimas.',
    '- Fuera de estas tres cosas, no tienes ningún dato del negocio en la cabeza.',
  ].join('\n');
}
