import { describe, it, expect } from 'vitest';
import {
  ADMIN_HOME,
  KITCHEN_HOME,
  canAccessAdmin,
  canAccessKitchen,
  canReviewPayments,
  landingPathForRole,
} from './session-role';
import {
  createSessionToken,
  readSessionRole,
  verifySessionToken,
  SESSION_ROLES,
} from './session-token';
import { createHmac } from 'node:crypto';

const SECRET = 'a'.repeat(40);
const NOW = Date.parse('2026-08-22T12:00:00Z');

describe('rol — qué puede ver cada uno', () => {
  it('cada rol aterriza donde trabaja', () => {
    expect(landingPathForRole('admin')).toBe(ADMIN_HOME);
    expect(landingPathForRole('kitchen')).toBe(KITCHEN_HOME);
  });

  it('el panel administrativo es exclusivo del encargado', () => {
    expect(canAccessAdmin('admin')).toBe(true);
    expect(canAccessAdmin('kitchen')).toBe(false);
  });

  it('la cocina la ven los dos (el encargado a veces mira el tablero)', () => {
    expect(canAccessKitchen('kitchen')).toBe(true);
    expect(canAccessKitchen('admin')).toBe(true);
  });
});

describe('rol — la cookie no se puede editar para ascender', () => {
  it('un token de cocinero NO se convierte en admin cambiando el rol a mano', () => {
    const token = createSessionToken(SECRET, NOW, 60_000, 'kitchen');
    expect(readSessionRole(token, SECRET, NOW)).toBe('kitchen');

    // El atacante reescribe el rol conservando la firma original.
    const [exp, , sig] = token.split('.');
    const falsificado = `${exp}.admin.${sig}`;
    expect(readSessionRole(falsificado, SECRET, NOW)).toBeNull();
    expect(verifySessionToken(falsificado, SECRET, NOW)).toBe(false);
  });

  it('tampoco vale recortar la cookie al formato antiguo para pasar por admin', () => {
    const token = createSessionToken(SECRET, NOW, 60_000, 'kitchen');
    const [exp, , sig] = token.split('.');
    // El formato legacy firma solo la expiración: esta firma no cuadra ahí.
    expect(readSessionRole(`${exp}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it('un rol inventado se rechaza aunque venga firmado con el secreto correcto', () => {
    const exp = NOW + 60_000;
    const sig = createHmac('sha256', SECRET).update(`${exp}.superadmin`, 'utf8').digest('hex');
    expect(readSessionRole(`${exp}.superadmin.${sig}`, SECRET, NOW)).toBeNull();
    expect(readSessionRole(`${exp}..${sig}`, SECRET, NOW)).toBeNull();
  });

  it('cada rol solo verifica con su propia firma', () => {
    for (const role of SESSION_ROLES) {
      const token = createSessionToken(SECRET, NOW, 60_000, role);
      expect(readSessionRole(token, SECRET, NOW)).toBe(role);
      expect(readSessionRole(token, 'b'.repeat(40), NOW)).toBeNull();
    }
  });
});

describe('rol — retrocompatibilidad de las sesiones antiguas', () => {
  const legacyToken = (expMs: number) =>
    `${expMs}.${createHmac('sha256', SECRET).update(String(expMs), 'utf8').digest('hex')}`;

  it('una sesión emitida antes de los roles sigue valiendo como admin', () => {
    const token = legacyToken(NOW + 60_000);
    expect(readSessionRole(token, SECRET, NOW)).toBe('admin');
    expect(verifySessionToken(token, SECRET, NOW)).toBe(true);
    expect(canAccessAdmin(readSessionRole(token, SECRET, NOW)!)).toBe(true);
  });

  it('pero caduca igual que siempre', () => {
    const token = legacyToken(NOW - 1);
    expect(readSessionRole(token, SECRET, NOW)).toBeNull();
  });

  it('el token nuevo también caduca y no sobrevive al vencimiento', () => {
    const token = createSessionToken(SECRET, NOW, 1_000, 'kitchen');
    expect(readSessionRole(token, SECRET, NOW + 500)).toBe('kitchen');
    expect(readSessionRole(token, SECRET, NOW + 2_000)).toBeNull();
  });
});

describe('quién puede revisar pagos', () => {
  /**
   * Este permiso existe porque antes NO existía.
   *
   * La acción de revisión y el endpoint del archivo se protegían con
   * `hasValidSession()`, que devuelve `true` para cualquier rol. En la práctica
   * cocina ya podía decidir pagos y abrir comprobantes; lo único que se lo
   * impedía era que la interfaz no le entregara los UUID — y un identificador
   * que no se enseña no es un control de acceso.
   *
   * Ahora el permiso se concede a propósito y se lee en un solo sitio.
   */
  it('el encargado puede', () => {
    expect(canReviewPayments('admin')).toBe(true);
  });

  it('cocina también: es quien tiene el ticket delante cuando hay que decidir', () => {
    // No se empieza a cocinar un pedido sin pagar, y esperar a que el encargado
    // lo mire desde otra pantalla es lo que frenaba la plancha.
    expect(canReviewPayments('kitchen')).toBe(true);
  });

  it('es un permiso APARTE de entrar al panel de administración', () => {
    // Que cocina pueda revisar un pago no la convierte en encargada: sigue sin
    // poder entrar a `/dashboard`, ver el resto de pedidos ni cambiar precios.
    expect(canAccessAdmin('kitchen')).toBe(false);
    expect(canReviewPayments('kitchen')).toBe(true);
  });
});
