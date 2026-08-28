import { describe, it, expect } from 'vitest';
import { isMenuLoop, MENU_LOOP_THRESHOLD, MENU_LOOP_WINDOW_MINUTES } from './menu-loop';

describe('cliente atascado — se cuenta, no se interpreta', () => {
  /**
   * Es el fallo más caro de esta migración porque es SILENCIOSO: el cliente no
   * se queja, recibe el botón una y otra vez, y deja de pedir. Pero deja una
   * huella contable, y contarla no cuesta ni un token.
   */
  it('por debajo del umbral no avisa: puede estar mirando', () => {
    for (let n = 0; n < MENU_LOOP_THRESHOLD; n += 1) {
      expect(isMenuLoop({ sends: n, hasOrder: false }), `${n} envíos`).toBe(false);
    }
  });

  it('al llegar al umbral sin pedido, avisa', () => {
    expect(isMenuLoop({ sends: MENU_LOOP_THRESHOLD, hasOrder: false })).toBe(true);
    expect(isMenuLoop({ sends: MENU_LOOP_THRESHOLD + 5, hasOrder: false })).toBe(true);
  });

  it('un pedido creado lo descarta entero, por muchos menús que haya', () => {
    // Quien ya pidió una vez sabe usar el menú. Si lo vuelve a pedir es porque
    // quiere otra cosa, y despertar a alguien por eso es gastar la alerta en un
    // buen cliente.
    expect(isMenuLoop({ sends: 9, hasOrder: true })).toBe(false);
  });

  it('la ventana cubre una conversación, no una jornada', () => {
    // Tres menús a lo largo de una noche entera son tres visitas distintas; tres
    // en tres cuartos de hora son alguien peleándose con la pantalla.
    expect(MENU_LOOP_WINDOW_MINUTES).toBeLessThanOrEqual(60);
  });
});
