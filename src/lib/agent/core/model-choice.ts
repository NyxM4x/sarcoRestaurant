/**
 * Qué modelo atiende ESTE turno — módulo PURO.
 *
 * ── Por qué el turno con foto merece otro modelo ────────────────────────────
 *
 * Los modelos no cuestan lo mismo según lo que se les dé de comer, y la
 * diferencia no está en la tabla de precios: está en cómo cuenta cada uno los
 * tokens de una imagen.
 *
 * `gpt-4o-mini` es el más barato del catálogo para TEXTO, y para IMAGEN es el
 * más caro con diferencia: cobra 2 833 tokens de base más 5 667 por cada cuadro
 * de 512 px. Una foto de móvil corriente le sale por unos 48 000 tokens de
 * entrada — lo mismo que once conversaciones enteras. Los `gpt-5-*` cuentan por
 * parches de 32 px con tope, y la misma foto ronda los 3 000.
 *
 * Así que el modelo barato de verdad depende de si el cliente mandó una foto, y
 * eso solo se sabe turno a turno. Elegir uno fijo significa pagar de más en la
 * mitad de los casos, y da igual cuál se elija: pagas de más en texto o pagas
 * siete veces de más en imagen.
 *
 * ── Por qué la decisión vive aquí y no en el cableado ───────────────────────
 *
 * Es una regla —"si hay foto, el otro modelo"— y las reglas se prueban. En el
 * cableado sería un ternario dentro de una llamada, invisible para los tests y
 * fácil de romper el día que alguien reordene los argumentos.
 */

/** Lo que hace falta saber del turno para elegir. */
export interface TurnModelChoice {
  /** ¿Alguno de los mensajes del turno trae una imagen que el modelo vaya a mirar? */
  hasImage: boolean;
  /** Modelo para turnos de solo texto. */
  textModel: string;
  /**
   * Modelo para turnos con imagen. Vacío o ausente = se usa el de texto.
   *
   * Que se pueda dejar sin poner es deliberado: sin la variable, el
   * comportamiento es EXACTAMENTE el de antes de que existiera esta regla. Una
   * optimización de coste no debe poder cambiar a qué modelo habla el negocio
   * sin que alguien lo escriba.
   */
  visionModel?: string | null;
}

/**
 * Modelo que atiende el turno.
 *
 * Nunca devuelve cadena vacía: si el modelo de visión no está configurado —o
 * está pero vacío— responde el de texto, que siempre tiene valor.
 */
export function pickTurnModel(choice: TurnModelChoice): string {
  if (!choice.hasImage) return choice.textModel;
  const vision = (choice.visionModel ?? '').trim();
  return vision === '' ? choice.textModel : vision;
}

/**
 * ¿Este turno lleva alguna imagen?
 *
 * Se pregunta por `image` porque es exactamente lo que mira el resolutor de
 * media: si el adjunto no está ahí, no se descarga, no se convierte en
 * `input_image` y no cuesta tokens de imagen.
 *
 * Es importante que ambas cosas miren el MISMO campo. La puerta de comprobantes
 * retira los bytes de los adjuntos no autorizados, así que un comprobante
 * retenido llega aquí sin `image` — y entonces este turno es de texto y de texto
 * debe cobrarse. Preguntar por otra cosa haría pagar el modelo caro por una foto
 * que nadie va a mirar.
 */
export function turnHasImage(burst: readonly { image?: unknown }[] | undefined): boolean {
  return (burst ?? []).some((m) => m.image !== null && m.image !== undefined);
}
