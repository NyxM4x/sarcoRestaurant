import { describe, it, expect } from 'vitest';
import { classifyMenuCtaContext } from './cta-context';
import { menuCtaBodyText } from '@/lib/kapso/messages';

describe('classifyMenuCtaContext — de qué venía hablando el cliente', () => {
  it('preguntar un precio', () => {
    for (const texto of [
      'cuanto cuesta el trancapecho',
      'que precio tienen las hamburguesas',
      'cuanto salen los lomitos',
      'a cuanto la salchipapa',
    ]) {
      expect(classifyMenuCtaContext(texto), texto).toBe('price');
    }
  });

  it('preguntar por el envío gana sobre el precio', () => {
    // "Cuánto sale el envío" es COSTE y ENVÍO a la vez, y lo que de verdad
    // pregunta es el envío. Contestarle "los precios están dentro" sería
    // contestar a otra pregunta.
    for (const texto of [
      'cuanto sale el envio',
      'cuanto cuesta el delivery',
      'aqui cuanto cobra',
      'cuanto me sale a mi casa',
    ]) {
      expect(classifyMenuCtaContext(texto), texto).toBe('delivery');
    }
  });

  it('dictar el pedido', () => {
    // El cliente que todavía pide como se pedía antes. Es el que más necesita
    // que el botón le explique por qué ahora le conviene armarlo él.
    for (const texto of [
      '2 lomitos quería',
      'quiero 3 trancapechos',
      'mandame 2 hamburguesas y una coca',
      'Si Envíeme 2 lomitos',
    ]) {
      expect(classifyMenuCtaContext(texto), texto).toBe('dictated');
    }
  });

  it('dictar el pedido con la cantidad en LETRA', () => {
    // "Quisiera un trança pecho" (03-09-2026): el cliente saltó el verbo
    // "pedir" y nombró la cosa. Es el mismo dictado, escrito como se escribe.
    for (const texto of [
      'quisiera un trança pecho',
      'quiero una hamburguesa',
      'dame dos lomitos por favor',
      'hola buenas quisiera una salchipapa',
    ]) {
      expect(classifyMenuCtaContext(texto), texto).toBe('dictated');
    }
  });

  it('un saludo pelado es su propio contexto', () => {
    // Casi siempre es el primer contacto, y lo que le sirve es el horario y una
    // puerta. Ver `isGreetingOnly`.
    for (const texto of ['hola', 'Buenas noches', 'hola buenas', 'Hey, buenas tardes']) {
      expect(classifyMenuCtaContext(texto), texto).toBe('greeting');
    }
  });

  it('una intención normal no encaja en ninguno: manda el texto del motivo', () => {
    for (const texto of ['quiero pedir', 'menu', 'que tienen?', '', null]) {
      expect(classifyMenuCtaContext(texto), String(texto)).toBeNull();
    }
  });

  it('sin cantidad no es un pedido dictado', () => {
    // "Quiero lomito" es una intención de pedir cualquiera y ya la cubre el
    // texto normal. Lo que hace inequívoco al dictado es la cantidad.
    expect(classifyMenuCtaContext('quiero lomito')).toBeNull();
  });

  it('una cantidad seguida de algo que no es un producto tampoco lo es', () => {
    // "Quiero un momento" encaja palabra por palabra con el patrón del dictado
    // y no es un pedido. La de `persona` es la que más importa: mandarle el
    // menú a quien pide hablar con alguien es el peor momento para un botón.
    for (const texto of [
      'quiero un momento',
      'necesito una persona',
      'quisiera una consulta',
      'dame un minuto',
    ]) {
      expect(classifyMenuCtaContext(texto), texto).not.toBe('dictated');
    }
  });
});

describe('menuCtaBodyText — el botón contesta lo que preguntaron', () => {
  it('cada contexto dice algo distinto, y al grano', () => {
    const precio = menuCtaBodyText('agent_suggestion', 'price');
    const envio = menuCtaBodyText('agent_suggestion', 'delivery');
    const dictado = menuCtaBodyText('agent_suggestion', 'dictated');

    expect(precio).toMatch(/precios/i);
    expect(envio).toMatch(/env[íi]o/i);
    expect(dictado).toMatch(/arm[áa]lo|arm[áa]|vos mismo/i);
    expect(new Set([precio, envio, dictado]).size).toBe(3);
  });

  it('el del envío NO da un monto: depende de la ubicación', () => {
    // La regla de siempre: el importe lo manda el sistema tras la ubicación.
    expect(menuCtaBodyText('agent_suggestion', 'delivery')).not.toMatch(/\bBs\b|\d+\s*bs/i);
  });

  it('el del pedido dictado explica la VENTAJA, no la regla', () => {
    // "No puedo" o "no está permitido" suenan a muro. A un cliente que lleva
    // años dictando su pedido, un muro lo pierde; una razón lo convence.
    const texto = menuCtaBodyText('agent_suggestion', 'dictated');
    expect(texto).not.toMatch(/no puedo|no está permitido|no se puede|el sistema no/i);
  });

  it('un reenvío ignora el contexto: el problema no fue de comprensión', () => {
    // A quien dice "no me llegó" no se le vuelve a explicar cómo se pide, por
    // muy bien clasificada que esté su frase anterior.
    const conContexto = menuCtaBodyText('explicit_resend', 'price');
    expect(conContexto).toBe(menuCtaBodyText('explicit_resend'));
    expect(conContexto).toMatch(/de nuevo/i);
  });

  it('sin contexto se comporta exactamente como antes', () => {
    for (const reason of ['explicit_request', 'agent_suggestion', 'qa_trigger'] as const) {
      expect(menuCtaBodyText(reason, null)).toBe(menuCtaBodyText(reason));
    }
  });

  it('ninguna variante afirma que el pedido ya esté hecho', () => {
    for (const c of ['price', 'delivery', 'dictated'] as const) {
      const texto = menuCtaBodyText('agent_suggestion', c);
      expect(texto, c).not.toMatch(/tu pedido (ya|est[áa]|qued[óo])|anotad|confirmad/i);
    }
  });
});
