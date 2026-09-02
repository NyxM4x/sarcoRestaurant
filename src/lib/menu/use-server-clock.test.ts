import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guardias sobre el reloj derivado.
 *
 * Se leen del código fuente, como el resto de las pruebas de componentes de
 * este proyecto: lo que hay que proteger aquí no es un cálculo —son tres
 * líneas— sino DE DÓNDE sale cada dato. La diferencia entre anclarse a la hora
 * del servidor y leer la del navegador no se ve en el resultado hasta que
 * alguien tiene el reloj mal puesto, y entonces ya es tarde.
 */
const source = readFileSync(
  fileURLToPath(new URL('./use-server-clock.ts', import.meta.url)),
  'utf8',
);

/**
 * El fuente SIN comentarios.
 *
 * Hace falta porque la cabecera explica largamente por qué NO se usa
 * `Date.now()`, y un guardia que busque esa cadena en el archivo entero
 * encontraría la explicación y fallaría. Lo que se protege es el código.
 */
const code = source
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

describe('el reloj se ancla al servidor', () => {
  it('el estado inicial es el instante del SERVIDOR, no el del navegador', () => {
    expect(source).toContain('useState(serverNow)');
  });

  it('nunca lee la fecha absoluta del navegador', () => {
    // Leerla aquí sería exactamente el fallo que este hook evita: la hora del
    // sistema del cliente decidiendo si una promoción está vigente.
    expect(code).not.toContain('Date.now()');
    expect(code).not.toContain('new Date(');
  });

  it('mide el transcurso con un reloj monotónico', () => {
    // No se ve afectado si el sistema ajusta la hora a mitad de la sesión; la
    // alternativa sumaría ese salto como si hubiera pasado el tiempo.
    expect(code).toContain('performance.now()');
  });

  it('el valor que devuelve es ancla + transcurso, no una lectura suelta', () => {
    expect(source).toContain('ancla.server + (performance.now() - ancla.perf)');
  });
});

describe('se mantiene al día', () => {
  it('recalcula periódicamente', () => {
    expect(source).toContain('setInterval');
  });

  it('y también al volver a la pestaña, sin esperar al siguiente tick', () => {
    expect(source).toContain("addEventListener('visibilitychange'");
  });

  it('limpia el temporizador y el listener al desmontar', () => {
    expect(source).toContain('clearInterval');
    expect(source).toContain("removeEventListener('visibilitychange'");
  });

  it('se reancla si el servidor manda un instante nuevo', () => {
    expect(source).toContain('[serverNow, tickMs]');
  });
});
