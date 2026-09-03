import { describe, it, expect } from 'vitest';
import { isGreetingOnly, isMenuIntent, normalizeIntentText } from './menu-intent';

describe('normalizeIntentText', () => {
  it('minimiza, quita tildes y colapsa espacios', () => {
    expect(normalizeIntentText('  Menú   ')).toBe('menu');
    expect(normalizeIntentText('QUÉ   TIENEN')).toBe('que tienen');
    expect(normalizeIntentText('Ver\tProductos')).toBe('ver productos');
  });
});

describe('isMenuIntent — activa', () => {
  const positives = [
    'menu',
    'menú',
    'MENU',
    'Menú',
    'carta',
    'pedir',
    'ordenar',
    'ver menu',
    'ver menú',
    'ver carta',
    'ver productos',
    'quiero pedir',
    'quiero pedir una doble o nada',
    'quiero hacer un pedido',
    'quiero ordenar',
    'quiero comprar',
    'quiero un pedido',
    'hacer pedido',
    'hacer un pedido',
    'que tienen',
    'qué tienen',
  ];
  for (const t of positives) {
    it(`"${t}" → true`, () => expect(isMenuIntent(t)).toBe(true));
  }
});

describe('isMenuIntent — NO activa (irrelevantes)', () => {
  const negatives = [
    'hola',
    'buenas',
    'gracias',
    'precio',
    'comentario', // contiene "menu"? no; pero prueba substring ingenuo
    'mensaje',
    'quiero saber el horario',
    '',
    '   ',
  ];
  for (const t of negatives) {
    it(`"${t}" → false`, () => expect(isMenuIntent(t)).toBe(false));
  }

  it('substring de "menu"/"pedir" no activa (comentario, pedirle prestado)', () => {
    expect(isMenuIntent('comentario')).toBe(false);
    expect(isMenuIntent('pedirle prestado')).toBe(false);
    expect(isMenuIntent('mensaje nuevo')).toBe(false);
  });

  it('entradas no-string → false', () => {
    expect(isMenuIntent(null)).toBe(false);
    expect(isMenuIntent(undefined)).toBe(false);
  });
});

describe('isMenuIntent — negaciones (evaluadas antes que la intención)', () => {
  const negations = [
    'no quiero pedir',
    'ya no quiero pedir',
    'no quiero ordenar',
    'ya no quiero ordenar',
    'no quiero comprar',
    'todavía no quiero pedir',
    'aun no quiero pedir',
    'aún no quiero pedir',
  ];
  for (const t of negations) {
    it(`"${t}" → false`, () => expect(isMenuIntent(t)).toBe(false));
  }

  it('la palabra "no" dentro de otra intención no bloquea (numero)', () => {
    expect(normalizeIntentText('numero')).toBe('numero');
    expect(isMenuIntent('quiero pedir el numero 2')).toBe(true);
  });
});

describe('isMenuIntent — necesidad de menú con negación de ACCESO → true (6D.2E.final)', () => {
  const needs = [
    'no encuentro el menú',
    'no encuentro la carta',
    'no veo el menú',
    'no veo la carta',
    'no me aparece el menú',
    'no me sale el menú',
    'no puedo ver el menú',
    'no puedo abrir la carta',
  ];
  for (const t of needs) {
    it(`"${t}" → true (el cliente necesita el menú)`, () => expect(isMenuIntent(t)).toBe(true));
  }

  it('declinar un pedido sigue en false (no se confunde con necesidad de acceso)', () => {
    for (const t of [
      'no quiero pedir',
      'no quiero ordenar',
      'ya no quiero comprar',
      'todavía no quiero hacer un pedido',
    ]) {
      expect(isMenuIntent(t), t).toBe(false);
    }
  });

  it('"no" con acceso frustrado pero SIN sustantivo de menú → false', () => {
    expect(isMenuIntent('no encuentro nada')).toBe(false);
    expect(isMenuIntent('no veo bien')).toBe(false);
  });
});

describe('menú — cómo escribe la gente de verdad', () => {
  it('los signos de interrogación no impiden abrir el menú', () => {
    // "¿Menú?" es la forma MÁS natural de preguntar por la carta. Antes no
    // coincidía con nada: el cliente escribía justo lo que había que escribir y
    // no le llegaba nada.
    for (const t of ['¿menú?', 'menu?', 'Menú.', '¿Carta?', 'menu!', '¿Qué tienen?']) {
      expect(isMenuIntent(t), t).toBe(true);
    }
  });

  it('un saludo delante no rompe la intención', () => {
    // En WhatsApp casi todo el mundo saluda antes de pedir.
    for (const t of [
      'Hola, quiero pedir',
      'hola quiero pedir',
      'Buenas noches, quiero hacer un pedido',
      'Buenas, menú',
      'Hey, ver carta',
      'Disculpe, quiero ordenar',
    ]) {
      expect(isMenuIntent(t), t).toBe(true);
    }
  });

  it('las negaciones siguen SIN abrir el menú, con saludo o sin él', () => {
    // Quitar el saludo no puede convertir un rechazo en una petición: lo que
    // queda ("no quiero pedir") tampoco empieza por ninguna frase de intención.
    for (const t of [
      'no quiero pedir',
      'Hola, no quiero pedir',
      'Buenas noches, ya no quiero ordenar',
      'todavía no quiero hacer un pedido',
    ]) {
      expect(isMenuIntent(t), t).toBe(false);
    }
  });

  it('un saludo a secas NO es intención de menú — pero sí de saludo', () => {
    // Saludar no es pedir el menú, y este detector sigue diciendo que no.
    // Desde el 03-09-2026 quien solo saluda TAMBIÉN recibe el botón, pero por
    // `isGreetingOnly` y con otro motivo en el ledger: nadie pidió nada.
    for (const t of ['hola', 'Hola', 'buenas noches', 'hey', '¿hola?']) {
      expect(isMenuIntent(t), t).toBe(false);
      expect(isGreetingOnly(t), t).toBe(true);
    }
  });

  it('se retiran saludos ENCADENADOS, pero esto no es una búsqueda de subcadena', () => {
    // Desde el 29-08-2026 se retiran varios saludos seguidos: nadie saluda con
    // una sola palabra, y "hola buenas tardes disculpe quiero pedir" es un
    // cliente queriendo pedir, no un caso raro.
    expect(isMenuIntent('hola buenas tardes disculpe quiero pedir')).toBe(true);

    // Lo que NO cambia, y es la razón de ser del detector: se retiran PREFIJOS
    // de una lista cerrada, nunca palabras hasta que algo encaje. La intención
    // mencionada en mitad de la frase sigue sin abrir el menú.
    expect(isMenuIntent('mi hermano dijo que quiero pedir')).toBe(false);
  });
});

describe('isMenuIntent — el saludo encadenado (29-08-2026)', () => {
  it('los dos mensajes reales que NO se reconocían', () => {
    // Se retiraba UN saludo y se paraba, así que quedaba "zarco como va quiero
    // pedir" y "buenas queria pedir": ninguno empieza por una frase de
    // intención, y los dos acababan en el modelo.
    expect(isMenuIntent('Hola Zarco cómo va quiero pedir')).toBe(true);
    expect(isMenuIntent('Hola buenas quería pedir')).toBe(true);
  });

  it('el vocativo del negocio cuenta como saludo', () => {
    for (const texto of [
      'Zarco quiero pedir',
      'don zarco quiero ordenar',
      'que dice zarco quiero pedir',
      'hola buenas noches don zarco quiero pedir',
    ]) {
      expect(isMenuIntent(texto), texto).toBe(true);
    }
  });

  it('encadenar saludos NO convierte esto en una búsqueda de subcadena', () => {
    // Se retiran PREFIJOS de una lista cerrada, no palabras hasta que algo
    // encaje. Una frase que menciona la intención en medio sigue sin activar.
    expect(isMenuIntent('mi amigo dijo que aca se puede pedir')).toBe(false);
    expect(isMenuIntent('no quiero pedir todavia')).toBe(false);
    expect(isMenuIntent('hola zarco como va, gracias por todo')).toBe(false);
  });

  it('un saludo a secas no es PEDIR el menú (lo atiende isGreetingOnly)', () => {
    // Saludar no es pedir el menú, y por eso sigue en false aquí. Lo que
    // comparten es el desenlace —los dos acaban en el CTA— no el significado:
    // mezclarlos haría que `explicit_request` marcara en el ledger peticiones
    // que nadie hizo. Ver `isGreetingOnly` más abajo.
    expect(isMenuIntent('hola')).toBe(false);
    expect(isMenuIntent('hola buenas')).toBe(false);
    expect(isMenuIntent('hola zarco como va')).toBe(false);
  });

  it('el pedido dictado con producto y cantidad abre el menú', () => {
    // "Quisiera un trança pecho" (03-09-2026): el cliente saltó el verbo
    // "pedir" y nombró la cosa. Cayó en el modelo justo después de que la
    // cotización del envío lo mandara a un menú que nunca vio.
    for (const texto of [
      'Quisiera un trança pecho',
      'quiero una hamburguesa',
      'dame dos lomitos',
      'hola buenas noches quisiera una salchipapa',
      'mandame 2 trancapechos',
    ]) {
      expect(isMenuIntent(texto), texto).toBe(true);
    }
  });

  it('una cantidad seguida de algo que no es un producto NO abre el menú', () => {
    // Encajan palabra por palabra con el patrón y ninguna es un pedido. La de
    // `persona` es la que más importa: mandarle el menú a quien pide hablar
    // con alguien es el peor momento posible para un botón.
    for (const texto of [
      'quiero un momento',
      'necesito una persona',
      'quisiera una consulta',
      'dame un minuto',
      'quiero una respuesta',
    ]) {
      expect(isMenuIntent(texto), texto).toBe(false);
    }
  });

  it('sin cantidad, nombrar un producto no basta', () => {
    // "Quiero lomito" es una intención de pedir cualquiera; lo que hace
    // inequívoco al dictado es la cantidad. Y sin ella entrarían frases como
    // "quiero saber el horario", que empiezan igual.
    expect(isMenuIntent('quiero lomito')).toBe(false);
    expect(isMenuIntent('quiero saber el horario')).toBe(false);
    expect(isMenuIntent('necesito hablar con alguien')).toBe(false);
  });
});

describe('isGreetingOnly — el mensaje que es SOLO un saludo', () => {
  it('reconoce el saludo pelado, encadenado o no', () => {
    // 03-09-2026: "Hola" a secas terminaba en el modelo, que contestaba "¿en
    // qué puedo ayudarte?" — otra pregunta y ningún camino. Es casi siempre el
    // primer contacto, y lo que necesita es el horario y una puerta.
    for (const texto of [
      'Hola',
      'hola',
      'Buenas',
      'Buenas noches',
      'holi',
      'hola buenas',
      'Hola buenas noches don Zarco',
      'que tal',
      '¿Hola?',
    ]) {
      expect(isGreetingOnly(texto), texto).toBe(true);
    }
  });

  it('un saludo con algo pegado NO es solo saludo', () => {
    // Lo que va detrás es la pregunta de verdad, y esa la contesta quien
    // corresponda: el modelo, el detector de menú o el de envío.
    for (const texto of [
      'hola estan abiertos?',
      'hola quiero pedir',
      'buenas cuanto sale el envio',
      'hola zarco como va, gracias por todo',
      'hola quisiera un trancapecho',
    ]) {
      expect(isGreetingOnly(texto), texto).toBe(false);
    }
  });

  it('vacío, nulo y no-texto son false', () => {
    expect(isGreetingOnly('')).toBe(false);
    expect(isGreetingOnly('   ')).toBe(false);
    expect(isGreetingOnly(null)).toBe(false);
    expect(isGreetingOnly(undefined)).toBe(false);
  });
});
