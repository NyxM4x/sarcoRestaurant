import type { AgentModelContentPart, AgentModelMessage } from './model';
import type { AgentMessageActor, AgentMessageContentType, AgentMessageRole } from '@/types';

/**
 * Ventana de contexto del modelo — módulo puro (Fase 6D.2F.3).
 *
 * Principio congelado: la base guarda el historial COMPLETO; el modelo recibe
 * solo una ventana. Historial completo ≠ contexto completo. Mandar todo sería
 * caro, lento y acabaría chocando con el límite del modelo justo cuando la
 * conversación se vuelve importante.
 *
 * La higiene no se hace aquí a base de borrar campos: el repositorio
 * directamente NO SELECCIONA `metadata`, `provider_message_id`,
 * `provider_conversation_id` ni el payload del webhook. Lo que nunca se lee no
 * puede filtrarse. Este módulo solo recorta y ordena.
 */

/** Ventana temporal por defecto: la conversación de hoy, no la de la semana pasada. */
export const CONTEXT_WINDOW_HOURS = 24;
/** Tope de mensajes visibles. */
export const CONTEXT_MAX_MESSAGES = 24;

/**
 * Acciones de automatismo que el contexto sabe nombrar.
 *
 * Es una LISTA BLANCA, no un espejo de `metadata`, y es FAIL-CLOSED: lo que no
 * esté aquí no llega al modelo. Describir en genérico algo que no sabemos
 * interpretar sería inventar, y un automatismo futuro no debería aparecer en la
 * conversación hasta que alguien decida cómo se cuenta.
 */
export type AutomationAction = 'send_menu';

const AUTOMATION_ACTIONS: readonly AutomationAction[] = ['send_menu'];

/** ¿Es una acción conocida? Todo lo demás cae al evento genérico. */
export function toAutomationAction(raw: unknown): AutomationAction | null {
  return typeof raw === 'string' && (AUTOMATION_ACTIONS as readonly string[]).includes(raw)
    ? (raw as AutomationAction)
    : null;
}

/**
 * Mensaje tal como lo devuelve el repositorio para construir contexto. Es un
 * subconjunto DELIBERADO de `agent_messages`: aquí no hay identificadores del
 * proveedor ni metadata cruda.
 */
export interface ContextMessage {
  /**
   * Actor REAL: `customer`, `ai`, `human` o `automation`. Se conserva aunque
   * el modelo no lo reciba, porque `role` NO los distingue —los tres salientes
   * colapsan en `assistant`— y las políticas y la observabilidad futuras sí
   * necesitan saber si habló una persona, la IA o el backend.
   */
  actor: AgentMessageActor;
  role: AgentMessageRole;
  content: string | null;
  /**
   * Tipo del mensaje tal como se guardó. Es lo que decide si un `content` del
   * CLIENTE puede viajar como texto suyo — ver `isCustomerConversationalText`.
   *
   * Obligatorio a propósito: la columna es `not null` en la base, así que quien
   * construya un `ContextMessage` sin él no está simplificando, está omitiendo
   * el dato del que depende la decisión.
   */
  contentType: AgentMessageContentType;
  messageTimestamp: string;
  /**
   * Solo para `actor='automation'`: QUÉ hizo el sistema, ya reducido a la lista
   * blanca. El repositorio lo deriva de `metadata.action` y **nunca** entrega
   * la metadata entera. `null` = automatismo desconocido o sin acción.
   */
  automationAction?: AutomationAction | null;
}

/**
 * Proyección al modelo: `customer` habla como `user`, y lo que dijeron la IA o
 * una persona (`ai`, `human`) como `assistant`.
 *
 * `automation` NO está aquí: no lo dijo nadie, lo hizo el sistema, y se proyecta
 * aparte (ver `automationEventLine`).
 *
 * Que `human` siga entrando como `assistant` es deliberado: es lo que evita que
 * el agente repita lo que una persona ya contestó.
 */
export function actorToModelRole(actor: AgentMessageActor): AgentMessageRole {
  return actor === 'customer' ? 'user' : 'assistant';
}

/**
 * ¿Esta fila del CLIENTE puede viajar al modelo como palabras suyas?
 *
 * ── La política, en una frase (Fase 6D.2F.5C.4) ─────────────────────────────
 *
 * Texto generado por el PROVEEDOR en un tipo de mensaje NO TEXTUAL no se
 * convierte automáticamente en palabras del usuario.
 *
 * Hasta 5C.4 el criterio era "¿tiene `content` no vacío?", y eso bastaba
 * mientras `content` solo se rellenara con lo que el cliente escribía. Dejó de
 * bastar en cuanto se vio el payload real de una reacción: Kapso manda
 * `kapso.content = "Reacted with ❤️ to message wamid…"`, y esa frase entraba
 * por el mismo agujero que un "hola". El modelo habría leído, en inglés y en voz
 * del cliente, una frase que nadie escribió.
 *
 * El filtro es por TIPO y no por contenido a propósito: mirar las palabras para
 * decidir si son del cliente es exactamente la clase de heurística que falla en
 * cuanto Kapso traduce su copy o añade un tipo nuevo. `content_type='text'` es
 * una afirmación estructural sobre el mensaje, y solo la produce un `text.body`
 * real (ver la degradación a `unknown` en `provenance.ts`).
 *
 * Es FAIL-CLOSED, y por eso arregla el pasado además del futuro: las reacciones
 * que ya están persistidas en Production con `content_type='unknown'` dejan de
 * proyectarse sin tocar una sola fila. Y cubre por adelantado lo que traerá 5C.5
 * — un caption de imagen no se cuela como texto suelto solo por existir.
 *
 * Se aplica SOLO al cliente. Un saliente de `ai`, `human` o `automation` no lo
 * necesita: lo escribimos nosotros, no lo redacta el proveedor, y `automation`
 * ya tiene su propia lista blanca fail-closed.
 */
export function isCustomerConversationalText(
  message: ContextMessage,
): message is ContextMessage & { content: string } {
  // `image` entra desde 5C.5, y solo por su CAPTION. La diferencia con la
  // reacción no es de grado: el caption lo TECLEÓ el cliente, mientras que la
  // frase de una reacción la redacta Kapso. Es seguro porque la persistencia
  // garantiza qué hay en `content` para una imagen — el caption y nada más,
  // nunca `kapso.content`, que mezcla texto del cliente con filename y URL.
  //
  // Una imagen SIN caption tiene `content = NULL` y por tanto no entra: no se
  // fabrica una frase que el cliente no escribió. Sus píxeles son otra cosa y
  // viajan por su propio camino, solo en el turno actual (ver §9 de 5C.5).
  const tipoAporta = message.contentType === 'text' || message.contentType === 'image';
  return (
    tipoAporta && typeof message.content === 'string' && message.content.trim() !== ''
  );
}

/**
 * Lo que el modelo lee cuando el sistema hizo algo por su cuenta.
 * `null` = no hay nada que contarle y la fila se omite del contexto.
 *
 * ── Por qué el texto literal del automatismo NO puede llegar al modelo ───────
 *
 * `agent_messages` guarda el cuerpo REAL del mensaje interactivo, y hace bien:
 * es un mensaje que el cliente vio. Pero proyectarlo como si fuera una frase
 * del asistente le pone delante al modelo el copy exacto del CTA, listo para
 * copiar. Eso ocurrió en producción el 16-08-2026: ante "Que opciones tienen?"
 * el turno terminó SIN llamar a `send_menu` y con un texto que reproducía el
 * mensaje del menú — mismo copy, mismo emoji, sin botón. Un CTA falso.
 *
 * ── Y por qué es un HECHO, no una instrucción ───────────────────────────────
 *
 * La línea dice qué pasó y se calla lo demás. Nada de "no hace falta repetirlo"
 * ni "ya fue atendido": eso sería un cooldown escrito en prosa, justo después
 * de haber quitado el de verdad. Un mensaje NUEVO del cliente puede necesitar
 * el menú otra vez, y esa decisión es del turno actual — no de una frase que
 * arrastramos del pasado.
 *
 * No lleva URL, ni token, ni WAMID, ni id de entrega, ni metadata cruda: se
 * construye aquí a partir de una acción de la lista blanca, no se copia de
 * ningún sitio.
 */
export function automationEventLine(action: AutomationAction | null | undefined): string | null {
  return action === 'send_menu'
    ? 'Evento del canal: el sistema envió un menú interactivo al cliente.'
    : null;
}

export interface WorkingContextOptions {
  maxMessages?: number;
  /**
   * Texto del entrante actual que se va a adjuntar aparte, junto a su imagen
   * (Fase 6D.2F.5C.5).
   *
   * El caption ya está persistido cuando corre el turno, así que sin esto
   * aparecería DOS veces: una como fila del historial y otra pegada a su
   * imagen. Se descarta la del historial —no la otra— porque la que va con la
   * imagen es la que conserva la unidad que el cliente envió.
   *
   * Solo se descarta si es el ÚLTIMO mensaje proyectado del cliente y coincide
   * exactamente: nunca se borra un mensaje anterior que dijera lo mismo.
   */
  dropTrailingUserText?: string | null;
}

/**
 * Convierte el historial reciente en mensajes para el modelo.
 *
 * - Conserva el orden CRONOLÓGICO: sin él, el modelo lee la conversación al revés.
 * - Descarta lo que no tiene texto (un pin de GPS, un sticker, un audio sin
 *   transcripción). Nunca se sustituye por un marcador inventado: el modelo no
 *   debe creer que el cliente escribió "[LOCATION]".
 * - Se queda con los ÚLTIMOS `maxMessages`, no con los primeros: lo reciente es
 *   lo que da sentido al turno actual.
 *
 * ── Dos proyecciones distintas, y por qué ───────────────────────────────────
 *
 * Lo que alguien DIJO (`customer`, `ai`, `human`) viaja con su texto real: el
 * rol se proyecta desde `actor` y los dos salientes colapsan en `assistant`.
 * Un mensaje escrito a mano desde WhatsApp Business App llega así, que es justo
 * lo que el modelo necesita para no repetir lo que ya contestó una persona.
 *
 * Lo que el sistema HIZO (`automation`) no viaja con su texto. Se sustituye por
 * una línea de evento construida aquí, con rol `system`, porque no lo escribió
 * el asistente y ponerlo en su voz es lo que invita a imitarlo. El contenido
 * real de la fila ni se lee. Si la acción no está en la lista blanca, la fila
 * NO entra: fail-closed.
 *
 * El recorte se aplica DESPUÉS de proyectar, sobre lo que de verdad va a viajar.
 * Contar antes dejaría fuera mensajes reales para hacer sitio a filas que luego
 * se descartan.
 *
 * La base NO cambia: `agent_messages` sigue guardando el mensaje tal como lo
 * vio el cliente. Historial ≠ contexto, y esta es la diferencia.
 */
export function buildWorkingContext(
  messages: readonly ContextMessage[],
  options: WorkingContextOptions = {},
): AgentModelMessage[] {
  const max = options.maxMessages ?? CONTEXT_MAX_MESSAGES;
  if (max <= 0) return [];

  const projected = messages
    .map((m): AgentModelMessage | null => {
      // Un automatismo entra por lo que HIZO, no por lo que decía: su contenido
      // no se mira, así que tampoco se le exige tener texto.
      if (m.actor === 'automation') {
        const evento = automationEventLine(m.automationAction);
        return evento === null ? null : { role: 'system', content: evento };
      }
      // Del CLIENTE solo entra lo que es texto suyo de verdad: un pin de GPS, un
      // sticker, un audio o una reacción se omiten, y nunca se sustituyen por un
      // marcador inventado. Ver `isCustomerConversationalText`.
      if (m.actor === 'customer') {
        return isCustomerConversationalText(m) ? { role: 'user', content: m.content } : null;
      }
      // Salientes escritos por nosotros (`ai`, `human`): sin cambios. El texto
      // lo redactamos aquí, no el proveedor, y es lo que evita que el agente
      // repita lo que una persona ya contestó.
      return typeof m.content === 'string' && m.content.trim() !== ''
        ? { role: actorToModelRole(m.actor), content: m.content }
        : null;
    })
    .filter((m): m is AgentModelMessage => m !== null);

  const recortado = projected.slice(-max);

  // El caption que va a viajar pegado a su imagen se quita de la cola para no
  // decirlo dos veces. Se compara contra el ÚLTIMO proyectado y solo si es del
  // cliente: un mensaje anterior con el mismo texto es otro mensaje.
  const cola = recortado[recortado.length - 1];
  const duplicado =
    options.dropTrailingUserText != null &&
    cola !== undefined &&
    cola.role === 'user' &&
    cola.content === options.dropTrailingUserText;

  return duplicado ? recortado.slice(0, -1) : recortado;
}

// ── Contexto de SELECCIÓN DE ACCIÓN (Fase 6D.2F.5B.1) ───────────────────────

/**
 * Tope del contexto de decisión. Más corto que el de redacción a propósito:
 * elegir capacidad necesita el intercambio reciente, no la conversación entera.
 *
 * Doce y no seis porque el antecedente que resuelve una elipsis puede quedar
 * separado del entrante por varios mensajes del cliente y por eventos de canal,
 * y en esa ventana cabe holgadamente. Doce y no veinticuatro porque lo que se
 * gana a partir de ahí es historia, no referencia.
 */
export const SELECTION_CONTEXT_MAX_MESSAGES = 12;

/**
 * Lo que el contexto de decisión sabe decir de un saliente que escribió alguien.
 *
 * Se distingue la IA de una persona porque no significan lo mismo: que haya
 * contestado un humano es información conversacional real. Lo que NO viaja es
 * QUÉ dijeron.
 */
export function assistantEventLine(actor: AgentMessageActor): string | null {
  if (actor === 'ai') return 'Evento del canal: el asistente respondió al cliente.';
  if (actor === 'human') return 'Evento del canal: una persona del equipo respondió al cliente.';
  return null;
}

/** ¿Lo escribió alguien del lado del negocio —la IA o una persona? */
function isAssistantVoice(actor: AgentMessageActor): boolean {
  return actor === 'ai' || actor === 'human';
}

/**
 * Índice del ÚLTIMO saliente escrito (IA o persona). `-1` si no hay ninguno.
 *
 * Es el único cuyo texto sobrevive a la ronda de decisión. Ver
 * `buildSelectionContext`.
 */
function lastAssistantIndex(messages: readonly ContextMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (isAssistantVoice(m.actor) && typeof m.content === 'string' && m.content.trim() !== '') {
      return i;
    }
  }
  return -1;
}

export interface SelectionContextOptions {
  /**
   * Partes del entrante actual cuando lleva imagen (Fase 6D.2F.5C.5). Si vienen,
   * SUSTITUYEN al mensaje de texto final: decidir sin ver la foto ante "¿qué
   * hamburguesa es esta?" sería elegir capacidad a ciegas.
   */
  inboundParts?: string | readonly AgentModelContentPart[];
  /**
   * Texto REAL del entrante que abre el turno. OBLIGATORIO: la decisión es
   * sobre ESTE mensaje, y no puede depender de que la ventana de historial haya
   * llegado a incluirlo.
   */
  inboundText: string;
  maxMessages?: number;
}

/**
 * Ventana para la RONDA DE SELECCIÓN — una vista distinta de las mismas filas.
 *
 * ── Por qué no vale el contexto de redacción ────────────────────────────────
 *
 * El 16-08-2026, ante "Que opciones tiene ?", el turno terminó sin llamar a
 * ninguna herramienta y con esta frase: "Te paso el menú para que veas todas
 * las opciones y precios, tocá Ver menú para elegir". Es, palabra por palabra,
 * lo que la IA había dicho en un turno ANTERIOR en el que el menú sí se envió.
 *
 * En 4d5dade se dejó de proyectar el copy del CTA (`actor='automation'`), y con
 * razón. Pero un `actor='ai'` sigue viajando con su texto real —y debe hacerlo,
 * es lo que evita que el agente repita lo que ya contestó—, así que el objetivo
 * de la imitación simplemente se mudó: del copy del automatismo a la propia
 * frase de la IA. El turno que funcionó fabricó el material del turno que falló.
 *
 * La conclusión no es "pasar menos historial", es que DECIDIR y REDACTAR
 * necesitan cosas distintas:
 *
 *   · Para redactar, cómo se dijo antes es valioso: da continuidad y tono.
 *   · Para decidir qué capacidad hace falta AHORA, cómo se redactó antes no
 *     aporta nada — y sí ofrece una respuesta lista para copiar que ya salió
 *     bien una vez.
 *
 * ── Qué entra ───────────────────────────────────────────────────────────────
 *
 *   · Lo que dijo el CLIENTE, con su texto real. Es lo que se está decidiendo, y
 *     sin ello no se entienden "esa", "el otro" ni "y de tomar?".
 *   · Lo que HIZO el sistema, ya neutralizado (la misma línea de 4d5dade).
 *   · EL ÚLTIMO saliente escrito —de la IA o de una persona—, con su texto real.
 *   · Los salientes escritos ANTERIORES, como evento: que hubo respuesta y de
 *     quién, nunca con qué palabras.
 *   · El entrante actual, siempre el último y siempre presente.
 *
 * ── Por qué el último saliente SÍ conserva su texto ─────────────────────────
 *
 * Porque sin él hay mensajes que no significan nada por su cuenta:
 *
 *     asistente: "¿Querés que te pase el menú?"     cliente: "Sí"
 *     asistente: "¿Te explico cómo pagar?"          cliente: "Sí"
 *
 * Los dos "Sí" son idénticos. Neutralizar el antecedente los volvía
 * indistinguibles, y la decisión correcta es distinta en cada uno. Lo mismo con
 * "¿y esa cuánto cuesta?" después de nombrar un producto.
 *
 * UNO, y no los últimos tres: es la regla más pequeña que resuelve la elipsis.
 * Es determinista —posición, no contenido— y por tanto no hay ninguna búsqueda
 * de frases decidiendo qué texto es "relevante". Los anteriores siguen entrando
 * como evento, así que la estructura de la conversación se conserva entera; lo
 * que no se conserva es la prosa acumulada, que es lo que se puede imitar.
 *
 * ── Lo que esto NO arregla ──────────────────────────────────────────────────
 *
 * Si el último saliente resulta ser una frase que anunciaba el menú, esa frase
 * vuelve a estar delante del modelo. Hoy quedan cuatro así en producción, del
 * 16-08-2026. Deja de crecer —desde 5B.1 un `send_menu` confirmado no escribe
 * ninguna frase— pero las que ya existen siguen ahí, y esto es un límite real,
 * no un caso teórico. Se mide con el eval contra el modelo real, no se afirma.
 *
 * ── Y lo que se pierde, que se recupera después ─────────────────────────────
 *
 * Más allá del último, la prosa no viaja: tras dos o tres turnos, un "y el otro?"
 * puede quedar sin antecedente aquí. Suele dar igual —sea cual sea el producto,
 * la capacidad que hace falta es la misma— y redactar la respuesta sí recibe el
 * contexto normal completo.
 *
 * Esto NO cambia `agent_messages` ni el contexto de redacción. Es una vista más
 * sobre las mismas filas.
 */
export function buildSelectionContext(
  messages: readonly ContextMessage[],
  options: SelectionContextOptions,
): AgentModelMessage[] {
  const max = options.maxMessages ?? SELECTION_CONTEXT_MAX_MESSAGES;
  const visible = max <= 0 ? [] : messages;
  // Por POSICIÓN, nunca por contenido: aquí no hay nada que mire las palabras.
  const antecedente = lastAssistantIndex(visible);

  const projected = visible
    .map((m, i): AgentModelMessage | null => {
      if (m.actor === 'customer') {
        // Misma política que el contexto de redacción, y por la misma razón: si
        // las dos ventanas no coincidieran en qué cuenta como palabras del
        // cliente, la ronda de decisión podría elegir capacidad leyendo una
        // frase que Kapso redactó por una reacción.
        return isCustomerConversationalText(m) ? { role: 'user', content: m.content } : null;
      }
      // El último saliente escrito conserva su texto: es lo que resuelve "sí",
      // "dale" y "y esa cuánto cuesta?".
      if (i === antecedente) {
        return { role: 'assistant', content: m.content as string };
      }
      const evento =
        m.actor === 'automation'
          ? automationEventLine(m.automationAction)
          : assistantEventLine(m.actor);
      return evento === null ? null : { role: 'system', content: evento };
    })
    .filter((m): m is AgentModelMessage => m !== null)
    .slice(-max);

  // El entrante actual va SIEMPRE, y va último. Normalmente ya viene en el
  // historial —se persiste antes del turno— y entonces esto no añade nada. Pero
  // la decisión no puede depender de eso: si el recorte lo dejó fuera, o la
  // persistencia llegó tarde, el modelo estaría eligiendo sobre el mensaje
  // equivocado. Y equivocarse aquí no es un matiz de redacción: es mandar o no
  // mandar el menú.
  // Con imagen, el entrante viaja como PARTES y sustituye al texto: la foto es
  // parte de lo que se está decidiendo. Si el caption ya venía en el historial
  // se retira de la cola, para no repetirlo fuera de su imagen.
  if (options.inboundParts !== undefined) {
    const cola = projected[projected.length - 1];
    if (cola?.role === 'user' && cola.content === options.inboundText) projected.pop();
    projected.push({ role: 'user', content: options.inboundParts });
    return projected;
  }

  // Sin imagen: un entrante vacío no se inventa. Solo puede pasar con una foto
  // sin caption, y ese caso ya se fue por la rama de arriba.
  if (options.inboundText === '') return projected;

  const ultimo = projected[projected.length - 1];
  if (ultimo?.role !== 'user' || ultimo.content !== options.inboundText) {
    projected.push({ role: 'user', content: options.inboundText });
  }

  return projected;
}

/** Instante a partir del cual se lee historial, en ISO. */
export function contextWindowStart(now: string, hours: number = CONTEXT_WINDOW_HOURS): string {
  return new Date(new Date(now).getTime() - hours * 60 * 60 * 1000).toISOString();
}
