import { describe, it, expect } from 'vitest';
import { isLocalAddressRequest } from './local-address-intent';

/**
 * Las frases son REALES o del vocabulario cruceño recogido para esto: se pidió
 * expresamente cómo escribe alguien con apuro, de noche, sin tildes y con el
 * teclado del celular. No se inventaron desde un escritorio.
 */

describe('pregunta por la dirección — la forma interrogativa', () => {
  const SI = [
    'donde estan',
    'dnd estan',
    'donde es',
    'donde quedan',
    'dnd quedan',
    'donde atienden',
    'q direccion es',
    'en q parte estan',
    'por donde estan',
    'por donde se encuentran',
    'donde estan ubicados',
    'Dónde están ubicados?',
    'cerca de donde estan',
    'de q zona salen',
    'por donde es su boliche',
  ];

  for (const frase of SI) {
    it(`"${frase}"`, () => expect(isLocalAddressRequest(frase)).toBe(true));
  }
});

describe('pregunta por la dirección — pidiendo el dato', () => {
  const SI = [
    'direccion porfa',
    'su direccion',
    'cual es su direccion',
    'me pasas la direccion',
    'direccion del local',
    'ubi',
    'la ubi',
    'ubi porfa',
    'su ubi',
    'ubicacion',
    'la ubicacion',
    'me pasa la ubi',
    'pasame la ubi',
    'me pasas tu ubi',
    'pasame tu ubicacion',
    'manda ubicacion',
    'mandame la ubi',
    'me manda su ubicacion',
    'pasen ubicacion',
    'ubicacion del local',
    'Me pasa la ubicación',
  ];

  for (const frase of SI) {
    it(`"${frase}"`, () => expect(isLocalAddressRequest(frase)).toBe(true));
  }
});

describe('pregunta por la dirección — el léxico local', () => {
  // Anillos y zonas: así se ubica una dirección en Santa Cruz.
  const SI = [
    'q anillo es',
    'en q anillo estan',
    'por q anillo estan',
    'q zona es',
    'estan en el centro',
    'por el 4to anillo estan',
    'a q altura de la guardia',
    'por la doble via estan',
  ];

  for (const frase of SI) {
    it(`"${frase}"`, () => expect(isLocalAddressRequest(frase)).toBe(true));
  }
});

describe('pregunta por la dirección — va a ir al local', () => {
  // No nombra la dirección ni pregunta dónde, pero necesita saber adónde ir.
  const SI = [
    'para pasar a recoger',
    'se puede pasar a recoger',
    'donde paso a recoger',
    'donde paso a buscar',
    'quiero ir al local',
    'tienen local fisico',
    'se puede ir a comer ahi',
    'para ir donde es',
  ];

  for (const frase of SI) {
    it(`"${frase}"`, () => expect(isLocalAddressRequest(frase)).toBe(true));
  }
});

describe('pregunta por la dirección — sucursales', () => {
  // La respuesta es que hay un solo local, y eso también es contestar.
  const SI = [
    'tienen sucursal',
    'hay sucursal',
    'donde es su sucursal',
    'tienen otro local',
    'hay uno por el norte',
  ];

  for (const frase of SI) {
    it(`"${frase}"`, () => expect(isLocalAddressRequest(frase)).toBe(true));
  }
});

describe('LA TRAMPA — habla de SU ubicación, no de la nuestra', () => {
  /**
   * El falso positivo caro: contestarle la dirección del local a alguien que
   * está intentando mandar su GPS para que le cobren el envío. Ese pedido se
   * atasca.
   */
  const NO = [
    'ya te paso mi ubicacion',
    'no me sale la ubicacion',
    'como mando la ubicacion',
    'te mande mi ubi',
    'le pase la ubi',
    'mi direccion es',
    'aqui es mi ubicacion',
    'te estoy mandando la ubi',
    'a esta direccion me lo mandas',
    'mandamelo a esta ubicacion',
    'no da mi gps',
  ];

  for (const frase of NO) {
    it(`"${frase}" NO dispara`, () => expect(isLocalAddressRequest(frase)).toBe(false));
  }

  it('EL CASO QUE SE DIO POR IRRESOLUBLE: "hola ayer le mande mi direccion y nada"', () => {
    // `mande` es a la vez imperativo de usted y pasado sin tilde, así que el
    // verbo no puede desempatar. El POSESIVO sí: `mi direccion` es la del
    // cliente diga lo que diga el verbo. Ver `PROPIA`.
    expect(isLocalAddressRequest('hola ayer le mande mi direccion y nada')).toBe(false);
  });

  it('pero "su direccion" SÍ pregunta por la nuestra: en Bolivia `su` es de usted', () => {
    // Si `su` entrara en la guarda del posesivo, apagaría media familia.
    expect(isLocalAddressRequest('cual es su direccion')).toBe(true);
    expect(isLocalAddressRequest('me manda su ubicacion')).toBe(true);
  });
});

describe('otros falsos positivos que había que cerrar', () => {
  it('pedir el QR no es pedir la dirección, aunque hable de recoger', () => {
    // "pasame el qr que le voy a decir a mi hermano que pase a recoger" cumple
    // pedir + ir al local, y pide otra cosa completamente.
    expect(
      isLocalAddressRequest('pasame el qr que le voy a decir a mi hermano que pase a recoger'),
    ).toBe(false);
    expect(isLocalAddressRequest('me pasas el numero de cuenta')).toBe(false);
  });

  it('el menú y los productos no disparan nada', () => {
    for (const frase of ['pasame el menu', 'que tienen', 'cuanto cuesta el trancapecho']) {
      expect(isLocalAddressRequest(frase), frase).toBe(false);
    }
  });

  it('la pregunta del ENVÍO tiene su propio detector y no es esta', () => {
    // `isDeliveryQuoteIntent` la atiende antes, y su respuesta es otra: pedirle
    // la ubicación al cliente.
    for (const frase of ['cuanto sale el envio', 'cuanto cobran por el delivery']) {
      expect(isLocalAddressRequest(frase), frase).toBe(false);
    }
  });

  it('un saludo pelado no pregunta nada', () => {
    for (const frase of ['hola', 'buenas', 'buenas tardes', 'holaa']) {
      expect(isLocalAddressRequest(frase), frase).toBe(false);
    }
  });

  it('una frase larga con `zona` suelta no basta', () => {
    // `LUGAR` a secas solo dispara en mensajes cortos: en una frase larga puede
    // ser cualquier cosa.
    expect(isLocalAddressRequest('me gusta esa zona pero prefiero otra cosa')).toBe(false);
  });
});

describe('entradas que no son texto', () => {
  it('null, undefined y vacío no disparan', () => {
    expect(isLocalAddressRequest(null)).toBe(false);
    expect(isLocalAddressRequest(undefined)).toBe(false);
    expect(isLocalAddressRequest('')).toBe(false);
    expect(isLocalAddressRequest('   ')).toBe(false);
  });
});

describe('no le roba mensajes a los detectores que ya existen', () => {
  /**
   * Este detector va al FINAL de la cascada, así que en producción nunca vería
   * estas frases: las atienden antes sus dueños. La comprobación es de diseño —
   * si empezara a reconocerlas, significaría que sus familias se desbordaron y
   * el día que cambie el orden de las guardas se llevaría por delante otro
   * flujo.
   */

  it('las frases del menú siguen siendo del menú', () => {
    const menu = [
      'quiero pedir',
      'mandame la carta',
      'menu porfa',
      'quiero hacer un pedido',
      'que tienen',
      'a cuanto el trancapecho',
      'estan abiertos',
      'ya estan atendiendo',
    ];
    for (const frase of menu) {
      expect(isLocalAddressRequest(frase), frase).toBe(false);
    }
  });

  it('las frases del ENVÍO siguen siendo del envío', () => {
    // `isDeliveryQuoteIntent` las atiende, y su respuesta es la contraria:
    // pedirle al cliente SU ubicación.
    const envio = [
      'cuanto sale el envio',
      'cuanto me cobran el delivery',
      'cuanto sale que me lo traigan',
      'aqui cuanto cobra',
      'cuanto me saldria delivery aqui',
      'hacen delivery',
    ];
    for (const frase of envio) {
      expect(isLocalAddressRequest(frase), frase).toBe(false);
    }
  });

  it('el CONFIRMO y el CANCELAR del efectivo no se tocan', () => {
    for (const frase of ['confirmo', 'CONFIRMO', 'cancelar', 'cancelar pedido']) {
      expect(isLocalAddressRequest(frase), frase).toBe(false);
    }
  });
});
