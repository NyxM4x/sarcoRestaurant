import { describe, it, expect } from 'vitest';
import {
  extractCoordsFromMapsUrl,
  findMapsLink,
  isGoogleMapsUrl,
  isShortMapsLink,
  parsePlainCoords,
} from './maps-link';
import { metersBetween } from './quote-request';

/**
 * La URL real que devolvió Google al expandir un link del negocio
 * (`maps.app.goo.gl/5biYBaWPiPGPPcyB9`, medido el 01-09-2026).
 *
 * Se guarda literal, tal como llegó en la cabecera `Location`, porque el valor
 * de este test está justo en lo que tiene de incómoda: los tres pares de
 * coordenadas que trae NO coinciden.
 */
const URL_REAL =
  "https://www.google.com/maps/place/17%C2%B050'34.7%22S+63%C2%B010'44.9%22W/" +
  '@-17.8429809,-63.1817199,17z/data=!3m1!4b1!4m4!3m3!8m2!3d-17.8429809!4d-63.179145!18m1!1e1' +
  '?entry=tts&g_ep=EgoyMDI2MDgzMC4wIPu8ASoASAFQAw%3D%3D&skid=4e902b2e-3f90-44ec-a982-07e690267657';

/** El par del LUGAR, que es el bueno. */
const LUGAR = { lat: -17.8429809, lng: -63.179145 };
/** El par de la CÁMARA, que es el que engaña. */
const CAMARA = { lat: -17.8429809, lng: -63.1817199 };

describe('extractCoordsFromMapsUrl — el link real del negocio', () => {
  it('lee el LUGAR, no el centro de la cámara', () => {
    // El fallo que este test existe para impedir. El par de la cámara es el más
    // visible —sale en la barra del navegador— y el más fácil de agarrar con un
    // regex apresurado.
    const res = extractCoordsFromMapsUrl(URL_REAL);

    expect(res).not.toBeNull();
    expect(res!.source).toBe('place');
    expect(res!.coords.lat).toBeCloseTo(LUGAR.lat, 6);
    expect(res!.coords.lng).toBeCloseTo(LUGAR.lng, 6);
  });

  it('y la diferencia con la cámara son 272 metros, no un redondeo', () => {
    // La medida que justifica todo el orden de la cascada. Si algún día alguien
    // "simplifica" el extractor a un solo regex de `@`, este número lo delata.
    const distancia = metersBetween(LUGAR, CAMARA);

    expect(distancia).toBeGreaterThan(250);
    expect(distancia).toBeLessThan(300);
  });

  it('el DMS del path apunta al mismo sitio que el lugar (~1 m)', () => {
    // Los dos son el lugar; se diferencian en los decimales que caben en un
    // DMS. Por eso el DMS es un respaldo legítimo y la cámara no.
    const soloDms = URL_REAL.replace(/data=[^?]*/, '').replace(/@[^/]*\//, '');
    const res = extractCoordsFromMapsUrl(soloDms);

    expect(res!.source).toBe('dms');
    expect(metersBetween(res!.coords, LUGAR)).toBeLessThan(5);
  });

  it('sin lugar ni DMS, la cámara sirve como último recurso', () => {
    const res = extractCoordsFromMapsUrl('https://www.google.com/maps/@-17.8429809,-63.1817199,17z');

    expect(res!.source).toBe('camera');
    expect(res!.coords.lng).toBeCloseTo(CAMARA.lng, 6);
  });
});

describe('extractCoordsFromMapsUrl — otros formatos', () => {
  it('`?q=lat,lng` gana a todo lo demás: son coordenadas explícitas', () => {
    const res = extractCoordsFromMapsUrl(
      'https://www.google.com/maps/search/?api=1&query=-17.7834,-63.1821',
    );
    expect(res).toEqual({ coords: { lat: -17.7834, lng: -63.1821 }, source: 'query' });
  });

  it('maps.google.com/?q= también', () => {
    const res = extractCoordsFromMapsUrl('https://maps.google.com/?q=-17.7834,-63.1821');
    expect(res!.source).toBe('query');
  });

  it('un link de RUTA no se lee: eso no es "aquí vivo"', () => {
    // Dos puntos y un trayecto. Adivinar cuál de los dos es la casa sería
    // inventarse la dirección de alguien.
    const res = extractCoordsFromMapsUrl(
      'https://www.google.com/maps/dir/-17.78,-63.18/-17.84,-63.17/data=!3m1!4b1!3d-17.84!4d-63.17',
    );
    expect(res).toBeNull();
  });

  it('un host que NO es Google no se lee, aunque traiga coordenadas', () => {
    const res = extractCoordsFromMapsUrl('https://maps.evil.com/@-17.84,-63.18,17z');
    expect(res).toBeNull();
  });

  it('coordenadas fuera de rango no son coordenadas', () => {
    const res = extractCoordsFromMapsUrl('https://www.google.com/maps/@999,-63.18,17z');
    expect(res).toBeNull();
  });
});

describe('el link que comparte "tu ubicacion" y NO trae el punto', () => {
  /**
   * El fallo real del 01-09-2026, con el link que mandó el negocio
   * (`maps.app.goo.gl/EdpqyyUHJW2iQR8w6`). Google lo expande a esto:
   */
  const SIN_PUNTO =
    'https://maps.google.com?q=Av+Santos+Dumont,+Santa+Cruz+de+la+Sierra' +
    '&ftid=0x93f1ea1cbec3efe5:0xf4d403845c2d52b7&entry=gps&shh=CAE&g_st=ic';

  it('devuelve null en vez de inventarse un punto', () => {
    /*
      Hay DOS clases de link corto:

        · compartir un LUGAR del buscador  → /maps/place/…!3d…!4d…  → hay punto
        · compartir "TU UBICACIÓN" desde la app → ?q=<calle>&ftid=… → no hay

      En el segundo, Google comparte el NOMBRE DE LA CALLE y un identificador
      suyo. Ni el User-Agent ni seguir el segundo salto cambian eso: se probó.
    */
    expect(extractCoordsFromMapsUrl(SIN_PUNTO)).toBeNull();
  });

  it('el `ftid` hexadecimal NO se confunde con coordenadas', () => {
    // `0x93f1ea1cbec3efe5:0xf4d403845c2d52b7` está lleno de dígitos y puntos
    // suspendidos de letras. Un extractor descuidado saca números de ahí.
    const res = extractCoordsFromMapsUrl(SIN_PUNTO);
    expect(res).toBeNull();
  });

  it('y el nombre de la calle tampoco se lee como coordenadas escritas', () => {
    expect(parsePlainCoords(SIN_PUNTO)).toBeNull();
  });
});

describe('isGoogleMapsUrl — la allowlist', () => {
  it.each([
    'https://maps.app.goo.gl/5biYBaWPiPGPPcyB9',
    'https://goo.gl/maps/abc123',
    'https://www.google.com/maps/place/x/@-17.8,-63.1,17z',
    'https://maps.google.com/?q=-17.8,-63.1',
  ])('acepta %s', (url) => {
    expect(isGoogleMapsUrl(url)).toBe(true);
  });

  it.each([
    // El ataque que un `endsWith('google.com')` dejaría pasar.
    'https://google.com.atacante.net/maps/@-17.8,-63.1,17z',
    'https://maps.app.goo.gl.evil.io/abc',
    'https://evil.com/maps/@-17.8,-63.1,17z',
    // Protocolos que no son una petición HTTP.
    'file:///etc/passwd',
    'ftp://google.com/maps',
    // Un dominio de Google que no es Maps.
    'https://www.google.com/search?q=hamburguesas',
  ])('rechaza %s', (url) => {
    expect(isGoogleMapsUrl(url)).toBe(false);
  });
});

describe('findMapsLink — el link dentro del mensaje', () => {
  it('encuentra el link aunque venga con texto alrededor', () => {
    const found = findMapsLink('hola, aquí vivo https://maps.app.goo.gl/5biYBaWPiPGPPcyB9 gracias');
    expect(found).toBe('https://maps.app.goo.gl/5biYBaWPiPGPPcyB9');
  });

  it('no se come la puntuación de la frase', () => {
    // "mi casa es <link>." — ese punto final no es parte de la URL, y con él
    // pegado el link no resuelve.
    const found = findMapsLink('mi casa es https://maps.app.goo.gl/5biYBaWPiPGPPcyB9.');
    expect(found).toBe('https://maps.app.goo.gl/5biYBaWPiPGPPcyB9');
  });

  it('ignora links que no son de Maps', () => {
    expect(findMapsLink('mirá esto https://facebook.com/algo')).toBeNull();
  });

  it('un mensaje sin links es un mensaje sin links', () => {
    expect(findMapsLink('hola quiero pedir dos hamburguesas')).toBeNull();
    expect(findMapsLink('')).toBeNull();
    expect(findMapsLink(null)).toBeNull();
  });
});

describe('isShortMapsLink', () => {
  it('el link corto hay que expandirlo', () => {
    expect(isShortMapsLink('https://maps.app.goo.gl/5biYBaWPiPGPPcyB9')).toBe(true);
  });

  it('el largo ya se puede leer, no hay que pedir nada', () => {
    expect(isShortMapsLink(URL_REAL)).toBe(false);
  });
});

describe('parsePlainCoords — coordenadas escritas, sin red', () => {
  it('el formato que copia y pega quien abre el pin en Maps', () => {
    const res = parsePlainCoords('Lat: -17.842973709106, Long: -63.179229736328');
    expect(res).toEqual({ lat: -17.842973709106, lng: -63.179229736328 });
  });

  it('el par pelado también', () => {
    expect(parsePlainCoords('-17.842973, -63.179229')).toEqual({
      lat: -17.842973,
      lng: -63.179229,
    });
  });

  it('un pedido con números NO son coordenadas', () => {
    // El falso positivo caro: si esto se activara, quien pide dos hamburguesas
    // recibiría una tarifa de envío. Por eso se exigen decimales en los dos.
    expect(parsePlainCoords('pedime 2, 3 hamburguesas')).toBeNull();
    expect(parsePlainCoords('son 25 bs, 30 con envío')).toBeNull();
  });

  it('un solo número tampoco', () => {
    expect(parsePlainCoords('estoy a -17.84 de acá')).toBeNull();
  });

  it('fuera de rango no pasa', () => {
    expect(parsePlainCoords('999.5, -63.18')).toBeNull();
  });
});
