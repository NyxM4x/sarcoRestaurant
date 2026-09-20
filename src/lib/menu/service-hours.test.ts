import { describe, expect, it } from 'vitest';
import { serviceNoticeAt } from './service-hours';

/**
 * Las horas se escriben en UTC porque es lo que devuelve `Date.parse`, y al
 * lado va la hora boliviana que representan (UTC−4). Si alguna vez las dos
 * columnas dejan de cuadrar, el error está en el desfase y no en la franja.
 *
 * ── Las cuatro franjas, en el orden en que las vive un cliente ──────────────
 *
 *   03:50 → 04:15   puede que la plancha siga prendida: preguntamos
 *   04:15 → 18:30   cerrados
 *   18:30 → 19:00   abriendo, ya puedes ir armando
 *   19:00 → 03:50   sirviendo: ni una palabra
 *
 * Horario nuevo del 20-09-2026: el local pasó a abrir a las 19:00 y la gracia
 * del cierre se recortó de las 05:00 a las 04:15.
 *
 * Se tocan sin pisarse y sin dejar un minuto mudo entre las 03:50 y las 19:00.
 */
const enBolivia = (iso: string): number => Date.parse(iso);

describe('aviso de apertura (18:30–19:00)', () => {
  it('a las 18:29 todavía manda el cartel de cerrado', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-02T22:29:00.000Z'))?.kind).toBe('closed');
  });

  it('aparece a las 18:30 en punto', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-02T22:30:00.000Z'));
    expect(aviso?.kind).toBe('opening');
    expect(aviso?.title).toBe('Estamos abriendo');
  });

  it('sigue a las 18:45', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-02T22:45:00.000Z'))?.kind).toBe('opening');
  });

  it('dice que ya se puede ir armando el pedido', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-02T22:45:00.000Z'));
    expect(aviso?.body).toContain('19:00');
    expect(aviso?.body).toContain('armando');
  });

  it('desaparece a las 19:00 en punto: el local ya abrió', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-02T23:00:00.000Z'))).toBeNull();
  });

  it('a las 18:00 todavía NO: ahora se abre a las 19:00', () => {
    // El 20-09-2026 se propuso poner el aviso de 18:00 a 18:30, que dejaba la
    // media hora previa a abrir sin decir nada — justo cuando la gente entra.
    // Aquí se comprueba lo contrario: a las 18:00 sigue el cartel de cerrado.
    expect(serviceNoticeAt(enBolivia('2026-09-02T22:00:00.000Z'))?.kind).toBe('closed');
  });
});

describe('puede que la plancha siga prendida (03:50–04:15)', () => {
  it('no aparece a las 03:49: a esa hora se está sirviendo y punto', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-03T07:49:00.000Z'))).toBeNull();
  });

  it('aparece a las 03:50, diez minutos ANTES del cierre', () => {
    // Antes ahí había otro cartel ("atención fuera de horario") que decía casi
    // lo mismo con otras palabras. Dos carteles para la misma duda es uno de
    // más: el de las 03:55 y el de las 04:10 están en la misma situación.
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T07:50:00.000Z'));
    expect(aviso?.kind).toBe('after_hours');
    expect(aviso?.title).toBe('Puede que todavía alcancemos');
  });

  it('sigue en el cierre, a las 04:00 en punto', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T08:00:00.000Z'));
    expect(aviso?.kind).toBe('after_hours');
  });

  it('sigue a las 04:14, el último minuto de gracia', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-03T08:14:00.000Z'))?.kind).toBe('after_hours');
  });

  it('no promete: dice que se consulta', () => {
    // Ni "abierto" ni "cerrado". A esa hora lo único cierto es que alguien va a
    // preguntar si la plancha sigue prendida.
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T08:05:00.000Z'));
    expect(aviso?.body).toContain('consultamos');
    expect(aviso?.body).toContain('plancha');
    expect(aviso?.body).toContain('04:00');
  });

  it('a las 04:15 se acaba: ya no hay nada que preguntar', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-03T08:15:00.000Z'))?.kind).toBe('closed');
  });
});

describe('aviso de local cerrado (04:15–18:30)', () => {
  it('aparece a las 04:15 en punto', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T08:15:00.000Z'));
    expect(aviso?.kind).toBe('closed');
    expect(aviso?.title).toBe('Estamos cerrados');
  });

  it('releva al de la plancha SIN un minuto de por medio', () => {
    // El hueco de 04:15 a 04:30 que se propuso el 20-09-2026 dejaba el menú
    // —precios, fotos, botón de pedir— exactamente igual que a las diez de la
    // noche, con el local ya cerrado. Estos quince minutos son la prueba.
    for (let i = 0; i < 15; i += 1) {
      const t = enBolivia('2026-09-03T08:15:00.000Z') + i * 60_000;
      expect(serviceNoticeAt(t)?.kind, `minuto ${i} tras las 04:15`).toBe('closed');
    }
  });

  it('a media tarde sigue, que es cuando el menú engañaba', () => {
    // 15:00 Bolivia: precios, fotos y botón de pedir, sin una palabra de que no
    // hay nadie en la plancha.
    expect(serviceNoticeAt(enBolivia('2026-09-02T19:00:00.000Z'))?.kind).toBe('closed');
  });

  it('dice a qué hora se abre y qué puede hacer mientras tanto', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-02T19:00:00.000Z'));
    expect(aviso?.body).toContain('19:00');
    expect(aviso?.body).toContain('armado');
  });

  it('a las 18:30 deja paso al aviso de apertura, que dice algo mejor', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-02T22:30:00.000Z'))?.kind).toBe('opening');
  });
});

describe('con el local abierto no se muestra nada', () => {
  it('en plena noche de servicio no hay cartel', () => {
    // 21:00 Bolivia, con el local abierto y trabajando.
    expect(serviceNoticeAt(enBolivia('2026-09-03T01:00:00.000Z'))).toBeNull();
  });

  it('ni a la medianoche, ni a las 03:00', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-03T04:00:00.000Z'))).toBeNull();
    expect(serviceNoticeAt(enBolivia('2026-09-03T07:00:00.000Z'))).toBeNull();
  });

  it('el aviso de cierre ya no existe: nadie devuelve ese kind', () => {
    // Se fusionó con el de la plancha el 04-09-2026. Si volviera a aparecer,
    // serían dos carteles seguidos para la misma duda.
    const base = Date.parse('2026-09-02T04:00:00.000Z');
    for (let i = 0; i < 24 * 60; i += 1) {
      expect(serviceNoticeAt(base + i * 60_000)?.kind, `minuto ${i}`).not.toBe('closing');
    }
  });

  it('barrido de las 24 horas: tres franjas, y ninguna se pisa', () => {
    const conAviso: string[] = [];
    // Un minuto cada vez, arrancando en 00:00 Bolivia.
    const base = Date.parse('2026-09-02T04:00:00.000Z');
    for (let i = 0; i < 24 * 60; i += 1) {
      const aviso = serviceNoticeAt(base + i * 60_000);
      if (aviso !== null) conAviso.push(aviso.kind);
    }

    expect(conAviso.filter((k) => k === 'after_hours')).toHaveLength(25); // 03:50–04:15
    expect(conAviso.filter((k) => k === 'closed')).toHaveLength(855); // 04:15–18:30
    expect(conAviso.filter((k) => k === 'opening')).toHaveLength(30); // 18:30–19:00
    expect(conAviso).toHaveLength(910);
  });

  it('desde las 03:50 hasta las 19:00 no queda ni un minuto mudo', () => {
    // 15 horas y 10 minutos seguidos con algo que decirle al cliente. Este es
    // el test que cazaría cualquier hueco entre franjas, venga de donde venga.
    const base = Date.parse('2026-09-02T07:50:00.000Z'); // 03:50 Bolivia
    for (let i = 0; i < 910; i += 1) {
      expect(serviceNoticeAt(base + i * 60_000), `minuto ${i}`).not.toBeNull();
    }
  });

  it('y a las 19:00 en punto vuelve el silencio', () => {
    const base = Date.parse('2026-09-02T07:50:00.000Z'); // 03:50 Bolivia
    expect(serviceNoticeAt(base + 910 * 60_000)).toBeNull();
  });
});
