import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BUSINESS_HOURS, BUSINESS_MAPS_URL } from './facts';
import { DON_ZARCO_MAX_OUTPUT_TOKENS, DON_ZARCO_SYSTEM_PROMPT } from './prompt';

/**
 * Business Adapter — reglas grounded (Fase 6D.2F.4.1).
 *
 * IMPORTANTE sobre qué prueban estos tests y qué NO.
 *
 * Un modelo falso responde lo que el test le diga, así que con él es imposible
 * demostrar que el modelo REAL no inventa. Afirmar lo contrario sería un test
 * decorativo. Aquí solo se prueba lo que sí es determinista: que las reglas
 * existen en el prompt, que no se cuela ningún dato de negocio inventado dentro
 * de él, y que la comprensión flexible no se ha degradado a una lista de
 * palabras clave.
 *
 * El comportamiento semántico se mide con el eval set contra el modelo real
 * (`docs/agent-eval-grounded.md`), que NO se ejecuta desde `npm test`.
 */

describe('prompt — hechos con respaldo', () => {
  it('prohíbe inventar los datos duros del negocio', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /No inventes productos, precios, promociones ni tiempos de entrega/,
    );
  });

  it('el horario entra desde facts.ts, pero no autoriza a decir si está abierto', () => {
    // El horario dejó de ser un dato prohibido: tiene una fuente única
    // (`./facts.ts`) y es la pregunta más frecuente del chat. Lo que sigue
    // prohibido es la INFERENCIA — el agente no tiene reloj ni sabe de
    // feriados, así que dar el horario nunca equivale a decir "estamos
    // abiertos".
    expect(DON_ZARCO_SYSTEM_PROMPT).toContain(BUSINESS_HOURS);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Lo que NO puedes es decir si están abiertos AHORA/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/No tienes reloj ni sabes de feriados/);
  });

  it('los pedidos no se arman por chat y el delivery lo cotiza el sistema', () => {
    // El agente solo tiene send_menu / get_menu_items / answer_directly: no
    // puede registrar un pedido ni calcular un envío. El prompt lo dice con
    // todas las letras para que no lo intente.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Los pedidos NO se arman por chat contigo/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/no lo anotes ni lo confirmes/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/nunca das un monto de envío/);
  });

  it('manda consultar la herramienta en vez de contestar de memoria (6D.2F.5B)', () => {
    // Ya NO dice "no tienes el menú delante": desde 5B sí lo tiene, vía tool.
    // Lo que se le exige ahora es que lo consulte cada vez.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/usa get_menu_items/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/No contestes de\s+memoria/);
    expect(DON_ZARCO_SYSTEM_PROMPT).not.toMatch(/No tienes delante el menú/);
  });

  it('el resultado fresco de la tool gana a lo dicho antes', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /Lo que devuelve la herramienta manda sobre cualquier cosa dicha antes/,
    );
  });

  it('la tool del menú no trae ingredientes, y el prompt lo dice', () => {
    // El dato ausente se declara EXPLÍCITAMENTE: si no, el modelo lo deduce
    // del nombre, que es exactamente lo prohibido.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /get_menu_items NO trae ingredientes, alérgenos ni atributos dietéticos/,
    );
  });

  it('no puede decir que envió el menú si el envío no salió', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Mira el resultado antes de hablar/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Solo si dice que se envió/);
  });

  it('ya no se contradice a sí mismo sobre el envío del menú', () => {
    // Hasta esta corrección el prompt daba las dos órdenes a la vez: "puedes
    // decir que lo mandaste si el resultado lo confirma" y, más abajo, "no
    // digas que enviaste el menú". Con tools, la segunda quedó falsa.
    expect(DON_ZARCO_SYSTEM_PROMPT).not.toMatch(/No digas que enviaste el menú/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /Del menú solo puedes decir que se lo mandaste si llamaste a send_menu/,
    );
    // Lo que sigue sin poder afirmar, porque no tiene forma de hacerlo. El
    // enlace de Maps es la única excepción, y lo es porque va escrito DENTRO
    // del mensaje: no requiere ninguna capacidad que el agente no tenga.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/No digas que enviaste un QR ni una ubicación de WhatsApp/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toContain(BUSINESS_MAPS_URL);
  });

  it('la descripción es copy de vitrina, no una ficha técnica', () => {
    // Se acepta repetirla —el cliente ya la lee en la web— pero no concluir
    // nada de ella. Sin esta línea, "Doble carne, doble queso" acabaría
    // respondiendo a "¿tienen algo vegetariano?".
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/copy de vitrina/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/puedes repetirlo tal cual/);
    for (const conclusion of [
      'vegetariano',
      'vegano',
      'sin carne',
      'sin gluten',
      'libre de alérgenos',
      'seguro para una alergia',
    ]) {
      expect(DON_ZARCO_SYSTEM_PROMPT, conclusion).toContain(conclusion);
    }
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/lo que no menciona no es lo que no lleva/);
  });

  it('NO contiene precios ni catálogo, y sus cifras se escriben en palabras', () => {
    // Guarda contra la tentación de "ayudar" pegando el menú aquí. Un dato
    // dentro del prompt parecería grounded sin serlo, y quedaría congelado en
    // el commit mientras el negocio cambia. Los precios siguen viniendo SOLO
    // de get_menu_items.
    //
    // El enlace de Maps se excluye del barrido: es un identificador opaco, no
    // un dato que el modelo pueda leer como cantidad.
    const texto = DON_ZARCO_SYSTEM_PROMPT.replaceAll(BUSINESS_MAPS_URL, '');
    expect(DON_ZARCO_SYSTEM_PROMPT).not.toMatch(/\bBs\.?\s*\d/i);
    expect(texto).not.toMatch(/\d+[.,]\d{2}/);
    expect(DON_ZARCO_SYSTEM_PROMPT).not.toMatch(/\d+\s*(bs|bolivianos)\b/i);
    // Ninguna cifra suelta: en el texto los números van en palabras.
    expect(texto).not.toMatch(/\d/);
  });
});

describe('prompt — explorar vs. preguntar un dato', () => {
  /**
   * Lo que se prueba aquí es que la REGLA viaja en el prompt, no que el modelo
   * la obedezca: eso solo lo puede demostrar el modelo real. Un fake model
   * contestaría lo que el test le dictara.
   */
  it('el criterio es CUÁNTOS productos habría que nombrar, no la formulación', () => {
    // La versión anterior separaba "explorar" de "preguntar un dato", y
    // "¿qué hamburguesas tienen?" cae en los dos lados. Contar productos sí
    // tiene una respuesta única.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/cuenta cuántos productos tendrías que/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /VARIOS productos, una categoría entera o "lo que hay" ⇒ send_menu/,
    );
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/UNO o DOS productos concretos ⇒ get_menu_items/);
  });

  it('nombra las preguntas de categoría que fallaron en Production', () => {
    // "q hamburguesas tienen?" se contestó enumerando el catálogo (incidente
    // heredado del catálogo anterior). Estas
    // formulaciones quedan resueltas explícitamente del lado del menú.
    for (const pregunta of [
      'qué tienen?',
      'qué trancapechos',
      'qué bebidas manejan?',
      'qué opciones hay?',
      'qué puedo pedir?',
    ]) {
      expect(DON_ZARCO_SYSTEM_PROMPT, pregunta).toContain(pregunta);
    }
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/MANDANDO el menú, no escribiéndolo/);
  });

  it('la regla anti-enumeración es explícita y se puede autoaplicar', () => {
    // Redactada como algo que el modelo puede comprobar sobre su propio
    // borrador: "si te descubres enumerando, elegiste mal".
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/REGLA DURA: nunca reescribas el catálogo/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /Si te descubres\s+enumerando productos, la respuesta correcta era mandar el menú/,
    );
  });

  it('una categoría no cuenta como pregunta puntual, aunque lo parezca', () => {
    // El error concreto que la versión anterior inducía: "qué extras hay"
    // estaba puesto como EJEMPLO de dato concreto, y el modelo generalizó a
    // "qué hamburguesas hay".
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /Preguntar por una categoría NO es una pregunta puntual/,
    );
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/"qué extras hay" o "qué bebidas tienen"/);
  });

  it('el modelo no puede volver puntual una pregunta amplia eligiendo él', () => {
    // El hueco que dejaba "cuenta cuántos productos nombrarías": el modelo
    // decide cuántos nombra, así que podría contestar "qué hamburguesas
    // tienen?" mencionando dos y declararla puntual. Quien acota es el
    // cliente, no él.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Los productos los acota el CLIENTE, no/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /sigue siendo el menú aunque solo pensaras nombrar dos/,
    );
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Si el\s+cliente no dijo cuáles, no los eliges tú/);
  });

  it('la decisión sigue siendo semántica, no una lista de frases', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /cuántos productos tendría que nombrar la respuesta, no las/,
    );
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/con faltas o a medias/);
  });

  it('prohíbe el turno que manda el CTA y encima lista todo', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/No hagas las dos a la vez/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/no lo enumeres además en\s+texto/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/no mandes el menú entero en vez de\s+contestarlo/);
  });

  it('YA NO sugiere ninguna frase para acompañar al CTA (6D.2F.5B.1)', () => {
    // Describía un momento que dejó de existir: un `send_menu` confirmado cierra
    // el turno en silencio y no hay redacción después. Mientras siguiera aquí,
    // era la plantilla exacta del CTA falso del 16-08-2026 —escrita por
    // nosotros— disponible en la ventana de cualquier otra redacción.
    expect(DON_ZARCO_SYSTEM_PROMPT).not.toMatch(/una frase corta que empuje al botón/);
    expect(DON_ZARCO_SYSTEM_PROMPT).not.toMatch(/te paso el menú/i);
    expect(DON_ZARCO_SYSTEM_PROMPT).not.toMatch(/tocá Ver/i);
    expect(DON_ZARCO_SYSTEM_PROMPT).not.toMatch(/quedarte callado también vale/i);
  });

  it('pero sigue prohibiendo afirmar un envío sin confirmación', () => {
    // Esto es lo que NO se quitó, y es lo que importa cuando el despacho falla:
    // ahí sí hay ronda de redacción, y ahí sí puede mentir.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Solo si dice que se envió puedes decir/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Sin esa confirmación, no lo digas/);
  });

  it('prohíbe la coletilla exacta que apareció en Production', () => {
    // La respuesta real terminó en "¿Querés que te cuente precios o algo más?",
    // que después de mandar el menú deshace justo lo que se acaba de hacer.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /ni preguntar si quiere que le cuentes los precios/,
    );
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/volver a ofrecerlos deshace lo que acabas de/);
  });

  it('el dato concreto sigue exigiendo la herramienta: el grounding no se afloja', () => {
    // El ajuste es de UX. Si el agente afirma un precio, sigue teniendo que
    // haberlo consultado.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/get_menu_items, y contestas ese dato/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/No contestes de\s+memoria/);
  });
});

describe('prompt — recomendaciones subjetivas', () => {
  it('nombra una por una las etiquetas que no puede repartir', () => {
    for (const etiqueta of [
      'la más rica',
      'la mejor',
      'la favorita',
      'la más vendida',
      'que más llena',
      'la más saludable',
      'la más picante',
      'la ideal para dos',
    ]) {
      expect(DON_ZARCO_SYSTEM_PROMPT, etiqueta).toContain(etiqueta);
    }
  });

  it('da la salida concreta en vez de dejarla a la improvisación', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toContain(
      'No podría recomendarte una en específico, ¡pero todas están buenísimas! 😋',
    );
  });

  it('el cliente no puede levantar la regla insistiendo', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/elegí cualquiera|decime una aunque no sepas/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Que te lo pidan no lo vuelve\s+cierto/);
  });
});

describe('prompt — composición del producto', () => {
  it('el nombre no autoriza a deducir los ingredientes', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toContain('El nombre no dice qué lleva');
    expect(DON_ZARCO_SYSTEM_PROMPT).toContain('Veggie Burger');
  });

  it('una lista incompleta no prueba una ausencia', () => {
    // El error lógico más fácil de cometer: "no aparece, luego no lleva".
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /no aparezca en una lista no prueba que no esté/,
    );
  });
});

describe('prompt — alérgenos: la regla más estricta', () => {
  it('nombra las condiciones que jamás puede afirmar', () => {
    for (const claim of ['libre de gluten', 'apto para celíacos', 'libre de maní', 'libre de lácteos']) {
      expect(DON_ZARCO_SYSTEM_PROMPT, claim).toContain(claim);
    }
  });

  it('prohíbe deducir seguridad alimentaria desde los ingredientes', () => {
    // Una lista de ingredientes no dice nada del contacto en cocina.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Tampoco lo deduzcas de una lista de ingredientes/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/los\s+alimentos se cruzan/);
  });

  it('entrega la frase exacta para responder', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toContain(
      'No puedo confirmarte que sea seguro para esa alergia',
    );
  });
});

describe('prompt — cuando no sabe', () => {
  it('prefiere decirlo antes que rellenar el hueco', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toContain('No tengo esa información para confirmártelo');
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/No rellenes el hueco/);
  });

  it('pide ofrecer una salida real, no dejar al cliente en el aire', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/ofrece algo que sí exista/);
  });
});

describe('prompt — no promete un traspaso que no existe', () => {
  it('ya no ofrece "que un compañero conteste"', () => {
    // No hay tool que transfiera la conversación ni que avise a nadie. Ofrecerlo
    // era invitar al modelo a afirmar un handoff que nunca ocurrió.
    expect(DON_ZARCO_SYSTEM_PROMPT).not.toContain('que un compañero conteste');
  });

  it('prohíbe explícitamente dar el aviso por hecho', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/No digas que avisaste a alguien/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/nunca que ya la avisaste/);
  });

  it('deja escrita la fórmula que sí es cierta', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toContain(
      'Eso tendría que confirmártelo una persona del',
    );
  });

  it('el cierre tampoco promete plazos ni aviso', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(
      /sin prometer\s+plazos y sin dar por hecho que ya la avisaste/,
    );
  });
});

describe('prompt — la memoria no es fuente de verdad', () => {
  it('separa entender el contexto de tomarlo como dato', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/La conversación no es una fuente de datos/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/lo que TÚ dijiste antes no es una fuente autoritativa/);
  });

  it('cierra el bucle: una afirmación previa sin respaldo no se recicla como dato', () => {
    // Es la protección contra que una alucinación se consolide al volver a
    // entrar por el contexto turno tras turno.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/no se volvió verdad por estar escrito/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/no lo repitas como dato/);
  });
});

describe('prompt — la comprensión sigue siendo flexible', () => {
  it('pide entender a la primera cómo escribe la gente', () => {
    for (const ejemplo of ['q tienen?', 'menu xfa', 'mandme la carta', 'cual ta mas rica?']) {
      expect(DON_ZARCO_SYSTEM_PROMPT, ejemplo).toContain(ejemplo);
    }
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/sin pedirle a nadie que lo repita mejor/);
  });

  it('dice explícitamente dónde acaba la flexibilidad', () => {
    // La frase que evita que "sé estricto" se lea como "sé cortante".
    expect(DON_ZARCO_SYSTEM_PROMPT).toContain(
      'Ser flexible es para ENTENDER. Al AFIRMAR hechos eres estricto.',
    );
  });

  it('resuelve referencias conversacionales sin listas de palabras clave', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/a qué se refiere un "esta" o un "el otro"/);
  });
});

describe('prompt — tono y emoji', () => {
  it('permite UN emoji ocasional y prohíbe la cadena y la viñeta', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Como mucho UN emoji por mensaje/);
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Nunca varios\s+seguidos, nunca como viñeta/);
    // Y que no sea obligatorio: sin esto el modelo lo mete en todas.
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/la mayoría de tus\s+respuestas no lleva ninguno/);
  });

  it('el propio prompt predica con el ejemplo: un solo emoji en todo el texto', () => {
    const emojis = DON_ZARCO_SYSTEM_PROMPT.match(/\p{Extended_Pictographic}/gu) ?? [];
    expect(emojis).toEqual(['😋']);
  });

  it('sigue prohibiendo markdown y viñetas en la respuesta', () => {
    expect(DON_ZARCO_SYSTEM_PROMPT).toMatch(/Sin markdown y sin listas con viñetas/);
  });
});

describe('prompt — el Business Adapter sigue siendo solo texto', () => {
  it('solo importa los datos del negocio: no sabe cómo se ejecuta un turno', () => {
    // La separación con Agent Core no es un comentario, es una propiedad.
    //
    // El prompt dejó de ser un literal sin imports el día que el horario y la
    // ubicación pasaron a tener una fuente única. La invariante que importa no
    // era "cero imports", sino que el Business Adapter NO alcance la máquina:
    // solo puede leer de su propio módulo de datos, que también es texto puro.
    const source = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8');

    const imports = source.match(/^\s*import\s.+$/gm) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain("from './facts'");

    expect(source).not.toContain('@/lib/agent/core');
    expect(source).not.toContain('@/lib/menu');
    expect(source).not.toContain('supabase');
  });

  it('el techo de salida sigue siendo el de WhatsApp', () => {
    expect(DON_ZARCO_MAX_OUTPUT_TOKENS).toBe(300);
    expect(DON_ZARCO_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(400);
  });
});
