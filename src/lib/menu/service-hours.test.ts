import { describe, expect, it } from 'vitest';
import { serviceNoticeAt } from './service-hours';

/**
 * Las horas se escriben en UTC porque es lo que devuelve `Date.parse`, y al
 * lado va la hora boliviana que representan (UTC−4). Si alguna vez las dos
 * columnas dejan de cuadrar, el error está en el desfase y no en la franja.
 */
const enBolivia = (iso: string): number => Date.parse(iso);

describe('aviso de apertura (17:30–18:00)', () => {
  it('no aparece a las 17:29', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-02T21:29:00.000Z'))).toBeNull();
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
    expect(aviso?.body).toContain('armando tu pedido');
  });

  it('desaparece a las 18:00 en punto: el local ya abrió', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-02T22:00:00.000Z'))).toBeNull();
  });
});

describe('aviso de cierre (03:50–04:15)', () => {
  it('no aparece a las 03:49', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-03T07:49:00.000Z'))).toBeNull();
  });

  it('aparece a las 03:50 en punto', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T07:50:00.000Z'));
    expect(aviso?.kind).toBe('closing');
    expect(aviso?.title).toBe('Atención fuera de horario');
  });

  it('menciona las 04:00 y no promete que se vaya a preparar', () => {
    const aviso = serviceNoticeAt(enBolivia('2026-09-03T08:05:00.000Z'));
    expect(aviso?.body).toContain('04:00');
    expect(aviso?.body).toContain('consultaremos');
  });

  it('sigue a las 04:14', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-03T08:14:00.000Z'))?.kind).toBe('closing');
  });

  it('desaparece a las 04:15', () => {
    expect(serviceNoticeAt(enBolivia('2026-09-03T08:15:00.000Z'))).toBeNull();
  });
});

describe('el resto del día no muestra nada', () => {
  it('en plena noche de servicio no hay cartel', () => {
    // 21:00 Bolivia, con el local abierto y trabajando.
    expect(serviceNoticeAt(enBolivia('2026-09-03T01:00:00.000Z'))).toBeNull();
  });

  it('de madrugada cerrada tampoco', () => {
    // 06:00 Bolivia.
    expect(serviceNoticeAt(enBolivia('2026-09-03T10:00:00.000Z'))).toBeNull();
  });

  it('ni a media tarde', () => {
    // 15:00 Bolivia.
    expect(serviceNoticeAt(enBolivia('2026-09-02T19:00:00.000Z'))).toBeNull();
  });

  it('barrido de las 24 horas: solo dos franjas producen aviso', () => {
    const conAviso: string[] = [];
    // Un minuto cada vez, arrancando en 00:00 Bolivia.
    const base = Date.parse('2026-09-02T04:00:00.000Z');
    for (let i = 0; i < 24 * 60; i += 1) {
      const aviso = serviceNoticeAt(base + i * 60_000);
      if (aviso !== null) conAviso.push(aviso.kind);
    }
    // 30 minutos de apertura + 25 de cierre.
    expect(conAviso.filter((k) => k === 'opening')).toHaveLength(30);
    expect(conAviso.filter((k) => k === 'closing')).toHaveLength(25);
    expect(conAviso).toHaveLength(55);
  });
});
