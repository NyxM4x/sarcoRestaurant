import { describe, expect, it } from 'vitest';
import { isPickupSwitchRequest, PICKUP_SWITCH_MAX_LENGTH } from './pickup-switch-intent';

/**
 * EL DETECTOR MÁS ESTRICTO DEL WEBHOOK (04-09-2026).
 *
 * Reconocerlo mal deja a un cliente esperando en su casa una moto que nadie
 * mandó, así que la mitad de estos tests son frases que NO deben disparar.
 */
describe('pide recogerlo él mismo', () => {
  it('la conversación real que lo motivó', () => {
    // Llegó partido en dos mensajes: "Podría" / "Pasar yo a recogerlo".
    expect(isPickupSwitchRequest('Podría')).toBe(false);
    expect(isPickupSwitchRequest('Pasar yo a recogerlo')).toBe(true);
  });

  it('las formas en que se dice', () => {
    expect(isPickupSwitchRequest('podría pasar a recogerlo')).toBe(true);
    expect(isPickupSwitchRequest('yo lo recojo')).toBe(true);
    expect(isPickupSwitchRequest('voy a recogerlo')).toBe(true);
    expect(isPickupSwitchRequest('paso a recoger')).toBe(true);
    expect(isPickupSwitchRequest('prefiero recoger')).toBe(true);
    expect(isPickupSwitchRequest('quiero recojo')).toBe(true);
    expect(isPickupSwitchRequest('puedo retirarlo')).toBe(true);
    expect(isPickupSwitchRequest('a que hora puedo recogerlo')).toBe(true);
  });

  it('lo recoge otro, pero tampoco sale a reparto', () => {
    expect(isPickupSwitchRequest('lo recoge mi hermano')).toBe(true);
    expect(isPickupSwitchRequest('vamos a recogerlo nosotros')).toBe(true);
  });

  it('"para llevar" se basta sola: no nombra a nadie y lo dice todo', () => {
    expect(isPickupSwitchRequest('para llevar')).toBe(true);
    expect(isPickupSwitchRequest('es para llevar')).toBe(true);
    expect(isPickupSwitchRequest('me lo llevo')).toBe(true);
    expect(isPickupSwitchRequest('paso por el local')).toBe(true);
  });
});

describe('lo que NO puede convertir un pedido — el lado caro', () => {
  it('pedir que se lo manden, aunque diga "para llevar"', () => {
    // El envase para llevárselo a otro sitio NO es un recojo, y quien lo pide
    // lo dice en la primera palabra.
    expect(isPickupSwitchRequest('mandalo para llevar')).toBe(false);
    expect(isPickupSwitchRequest('mandame para llevar')).toBe(false);
    expect(isPickupSwitchRequest('envienlo para llevar')).toBe(false);
    expect(isPickupSwitchRequest('traelo para llevar')).toBe(false);
  });

  it('una negación lo descarta entero, esté donde esté', () => {
    expect(isPickupSwitchRequest('no puedo pasar a recogerlo')).toBe(false);
    expect(isPickupSwitchRequest('ya no voy a recogerlo')).toBe(false);
  });

  it('el verbo sin el cliente detrás no decide nada', () => {
    expect(isPickupSwitchRequest('quien lo va a recoger')).toBe(false);
    expect(isPickupSwitchRequest('recoger')).toBe(false);
  });

  it('dinero y repartidor: los dos contextos donde "recoger" es otra cosa', () => {
    expect(isPickupSwitchRequest('pueden recoger el pago?')).toBe(false);
    expect(isPickupSwitchRequest('cuando lo recoge el motorizado')).toBe(false);
    expect(isPickupSwitchRequest('el repartidor ya salio?')).toBe(false);
  });

  it('los mensajes de siempre siguen sin disparar', () => {
    expect(isPickupSwitchRequest('hola')).toBe(false);
    expect(isPickupSwitchRequest('Qr para que me lo preparen')).toBe(false);
    expect(isPickupSwitchRequest('cuanto seria')).toBe(false);
    expect(isPickupSwitchRequest('puedo aumentar')).toBe(false);
    expect(isPickupSwitchRequest(null)).toBe(false);
    expect(isPickupSwitchRequest('   ')).toBe(false);
  });

  it('una parrafada no convierte nada', () => {
    const largo =
      'hola buenas noches disculpe la molestia queria saber si de casualidad podria pasar a recogerlo';
    expect(largo.length).toBeGreaterThan(PICKUP_SWITCH_MAX_LENGTH);
    expect(isPickupSwitchRequest(largo)).toBe(false);
  });
});
