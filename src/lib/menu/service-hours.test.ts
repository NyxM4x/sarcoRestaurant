import { describe, expect, it } from 'vitest';
import { serviceNoticeAt } from './service-hours';

/**
 * Las horas se escriben en UTC porque es lo que devuelve `Date.parse`, y al
 * lado va la hora boliviana que representan (UTC−4). Si alguna vez las dos
 * columnas dejan de cuadrar, el error está en el desfase y no en la franja.
 *
 * ── Las cuatro franjas, en el orden en que las vive un cliente ──────────────
 *
 *   03:50 → 04:00   estamos por cerrar
 *   04:00 → 05:00   puede que la plancha siga prendida: preguntamos
 *   05:00 → 17:30   cerrados
 *   17:30 → 18:00   abriendo, ya puedes ir armando
 *
 * Se tocan sin pisarse y sin dejar un minuto mudo entre las 03:50 y las 18:00.
 */
const enBolivia = (iso: string): number => Date.parse(iso);

describe('aviso de apertura (17:30–18:00)', () => {
  it('a las 17:29 todavía manda el cartel de cerrado', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-02T21:29:00.000Z'))?.kind).toBe('closed');
  });

  it('aparece a las 17:30 en punto', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-02T21:30:00.000Z'));
    expect(aviso?.kind).toBe('opening');
    expect(aviso?.title).toBe('Estamos abriendo');
  });

  it('sigue a las 17:45', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-02T21:45:00.000Z'))?.kind).toBe('opening');
  });

  it('dice que ya se puede ir armando el pedido', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-02T21:45:00.000Z'));
    expect(aviso?.body).toContain('18:00');
    expect(aviso?.body).toContain('armando');
  });

  it('desaparece a las 18:00 en punto: el local ya abrió', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-02T22:00:00.000Z'))).toBeNull();
  });
});

describe('aviso de cierre (03:50–04:00)', () => {
  it('no aparece a las 03:49', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-03T07:49:00.000Z'))).toBeNull();
  });

  it('aparece a las 03:50 en punto', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T07:50:00.000Z'));
    expect(aviso?.kind).toBe('closing');
  });

  it('menciona las 04:00 y no promete que se vaya a preparar', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T07:50:00.000Z'));
    expect(aviso?.body).toContain('04:00');
    expect(aviso?.body).not.toContain('prepararemos');
  });

  it('a las 04:00 deja paso a la franja de la plancha', () => {
    // Antes seguía hasta las 04:15 diciendo lo mismo. Ahora el cierre acaba EN
    // el cierre, y lo que sigue es otra promesa distinta.
    expect(serviceNoticeAt(enBolivia('2026-09-03T08:00:00.000Z'))?.kind).toBe('after_hours');
  });
});

describe('puede que la plancha siga prendida (04:00–05:00)', () => {
  it('aparece a las 04:00 en punto', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T08:00:00.000Z'));
    expect(aviso?.kind).toBe('after_hours');
    expect(aviso?.title).toBe('Puede que todavía alcancemos');
  });

  it('sigue a las 04:45', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-03T08:45:00.000Z'))?.kind).toBe('after_hours');
  });

  it('no promete: dice que se consulta', () => {
    // Ni "abierto" ni "cerrado". A esa hora lo único cierto es que alguien va a
    // preguntar si la plancha sigue prendida.
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T08:30:00.000Z'));
    expect(aviso?.body).toContain('consultamos');
    expect(aviso?.body).toContain('plancha');
  });

  it('a las 05:00 se acaba: ya no hay nada que preguntar', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-03T09:00:00.000Z'))?.kind).toBe('closed');
  });
});

describe('aviso de local cerrado (05:00–17:30)', () => {
  it('aparece a las 05:00 en punto', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T09:00:00.000Z'));
    expect(aviso?.kind).toBe('closed');
    expect(aviso?.title).toBe('Estamos cerrados');
  });

  it('a media tarde sigue, que es cuando el menú engañaba', () => {
    // 15:00 Bolivia: precios, fotos y botón de pedir, sin una palabra de que no
    // hay nadie en la plancha.
    expect(serviceNoticeAt(enBolivia('2026-09-02T19:00:00.000Z'))?.kind).toBe('closed');
  });

  it('dice a qué hora se abre y qué puede hacer mientras tanto', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-02T19:00:00.000Z'));
    expect(aviso?.body).toContain('18:00');
    expect(aviso?.body).toContain('armado');
  });

  it('a las 17:30 deja paso al aviso de apertura, que dice algo mejor', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-02T21:30:00.000Z'))?.kind).toBe('opening');
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

  it('barrido de las 24 horas: cuatro franjas, y ninguna se pisa', () => {
    const conAviso: string[] = [];
    // Un minuto cada vez, arrancando en 00:00 Bolivia.
    const base = Date.parse('2026-09-02T04:00:00.000Z');
    for (let i = 0; i < 24 * 60; i += 1) {
      const aviso = serviceNoticeAt(base + i * 60_000);
      if (aviso !== null) conAviso.push(aviso.kind);
    }

    expect(conAviso.filter((k) => k === 'closing')).toHaveLength(10); // 03:50–04:00
    expect(conAviso.filter((k) => k === 'after_hours')).toHaveLength(60); // 04:00–05:00
    expect(conAviso.filter((k) => k === 'closed')).toHaveLength(750); // 05:00–17:30
    expect(conAviso.filter((k) => k === 'opening')).toHaveLength(30); // 17:30–18:00
    expect(conAviso).toHaveLength(850);
  });

  it('desde las 03:50 hasta las 18:00 no queda ni un minuto mudo', () => {
    // 14 horas y 10 minutos seguidos con algo que decirle al cliente.
    const base = Date.parse('2026-09-02T07:50:00.000Z'); // 03:50 Bolivia
    for (let i = 0; i < 850; i += 1) {
      expect(serviceNoticeAt(base + i * 60_000), `minuto ${i}`).not.toBeNull();
    }
  });
});
