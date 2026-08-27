import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toKitchenTickets, type RawKitchenOrderRow } from './ticket-view';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const componentsDir = fileURLToPath(new URL('../../components/kitchen', import.meta.url));
const componentFiles = readdirSync(componentsDir).filter((f) => f.endsWith('.tsx'));
const componentSrc = (f: string) => readFileSync(`${componentsDir}/${f}`, 'utf8');

describe('seguridad — el service_role jamás llega al navegador', () => {
  it('ningún componente de la cocina importa el cliente service_role ni la clave', () => {
    expect(componentFiles.length).toBeGreaterThan(0);
    for (const f of componentFiles) {
      const src = componentSrc(f);
      expect(src, f).not.toContain('@/lib/supabase/server');
      expect(src, f).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(src, f).not.toContain('@/lib/kitchen/data-source');
      expect(src, f).not.toContain('@/lib/dashboard/data-source');
    }
  });

  it('los componentes cliente no importan módulos server-only (auth / data-source / env)', () => {
    for (const f of componentFiles) {
      const src = componentSrc(f);
      if (!src.includes("'use client'")) continue;
      expect(src, f).not.toContain('@/lib/dashboard/auth');
      expect(src, f).not.toContain('@/lib/env/env');
    }
  });

  it('el adaptador de datos de cocina declara server-only', () => {
    expect(read('./data-source.ts')).toContain("import 'server-only'");
  });

  it('ni los componentes ni la lógica de cocina usan NEXT_PUBLIC_', () => {
    for (const f of componentFiles) expect(componentSrc(f), f).not.toContain('NEXT_PUBLIC');
    expect(read('./data-source.ts')).not.toContain('NEXT_PUBLIC');
    expect(read('./tickets-repository.ts')).not.toContain('NEXT_PUBLIC');
    expect(read('../env/env.ts')).not.toMatch(/NEXT_PUBLIC_KITCHEN/);
  });
});

describe('seguridad — el ticket no transporta datos que la cocina no necesita', () => {
  const row: RawKitchenOrderRow = {
    id: 'uuid-interno',
    order_number: 'ORD-000001',
    status: 'confirmed',
    delivery_type: 'delivery',
    notes: 'Tocar el timbre',
    created_at: '2026-08-22T12:00:00.000Z',
    confirmed_at: '2026-08-22T12:05:00.000Z',
    updated_at: '2026-08-22T12:05:00.000Z',
  };

  it('el ticket serializado no lleva teléfono, dirección ni desglose de importes', () => {
    const [ticket] = toKitchenTickets(
      [row],
      [{ order_id: 'uuid-interno', product_name_snapshot: 'Trancapecho', quantity: 2 }],
    );
    const json = JSON.stringify(ticket);
    for (const prohibido of [
      'phone',
      'customer_phone',
      'address',
      'delivery_address',
      'latitude',
      'longitude',
      // El desglose sigue fuera: solo viaja el TOTAL, que es lo único con lo que
      // se contrasta un comprobante. Ni subtotal, ni costo de envío.
      'subtotal',
      'price',
      'currency',
      'payment_method',
    ]) {
      expect(json.toLowerCase(), prohibido).not.toContain(prohibido);
    }
  });

  it('el TOTAL sí viaja, y es el único importe que lo hace', () => {
    // Cambio deliberado del contrato: desde que cocina revisa los comprobantes,
    // el total es una herramienta de trabajo. Sin él, mirar un comprobante no es
    // validarlo — se aceptaría un pago de Bs 20 para un pedido de Bs 64.
    const [ticket] = toKitchenTickets([{ ...row, total_amount: '64.00' }], []);
    expect(ticket.total).toBe(64);
  });

  it('un total ilegible cae a 0, nunca a NaN', () => {
    // `NaN` se pinta como "NaN" y parece un fallo de la pantalla; un 0 es
    // visiblemente raro y no engaña a nadie.
    const [ticket] = toKitchenTickets([{ ...row, total_amount: 'no-es-un-numero' }], []);
    expect(ticket.total).toBe(0);
    const [sinDato] = toKitchenTickets([{ ...row, total_amount: null }], []);
    expect(sinDato.total).toBe(0);
  });

  it('el ticket tampoco expone el UUID interno del pedido', () => {
    const [ticket] = toKitchenTickets([row], []);
    expect(JSON.stringify(ticket)).not.toContain('uuid-interno');
    // La lista es cerrada A PROPÓSITO: si alguien añade un campo al ticket, este
    // test falla y obliga a justificarlo. Así se añadieron `total` y `payment`.
    expect(Object.keys(ticket).sort()).toEqual([
      'completedAt',
      'deliveryType',
      'enteredAt',
      'lines',
      'notes',
      'orderNumber',
      'payment',
      'stage',
      'total',
    ]);
  });

  it('la consulta ni siquiera PIDE esas columnas a la base', () => {
    const src = read('./data-source.ts');
    const columnas = /const KITCHEN_ORDER_COLUMNS =\s*([\s\S]*?);/.exec(src)?.[1] ?? '';
    // `total_amount` salió de la lista de prohibidas: ahora se pide, y por una
    // razón concreta. Todo lo demás sigue sin pedirse, que es lo que hace que
    // no pueda filtrarse aunque alguien intentara pintarlo.
    expect(columnas).not.toMatch(
      /customer_phone|delivery_address|delivery_latitude|delivery_longitude|subtotal_amount|delivery_amount|payment_method|currency/,
    );
    expect(columnas).toContain('total_amount');
    // Y solo se piden producto y cantidad de cada línea, nunca precios.
    expect(src).toContain("select('order_id,product_name_snapshot,quantity')");
    expect(src).not.toContain('unit_price_snapshot');
  });
});

describe('seguridad — la cocina no altera notificaciones ni alertas', () => {
  it('el adaptador solo escribe orders.status y jamás toca order_notifications', () => {
    const src = read('./data-source.ts');
    // Ni consulta ni escritura: la tabla no se toca (las menciones en los
    // comentarios explican justamente eso, por eso se busca el uso real).
    expect(src).not.toMatch(/from\(\s*['"]order_notifications['"]/);
    expect(src).toMatch(/from\('orders'\)\s*\.update\(\{ status/);
  });

  it('la Server Action de cocina no importa Telegram, Kapso ni alertas', () => {
    const actions = read('../../app/cocina/actions.ts');
    expect(actions).not.toMatch(/from\(\s*['"]order_notifications['"]/);
    expect(actions).not.toMatch(/@\/lib\/alerts|createTelegramAlertSender|@\/lib\/kapso/);
  });

  it('la cocina NO reutiliza la máquina de estados del encargado', () => {
    // Los retrocesos del KDS viven en su propio módulo; `status.ts` no se toca.
    expect(read('./kds-status.ts')).not.toContain('@/lib/dashboard/status');
    expect(read('./tickets-repository.ts')).not.toContain('@/lib/dashboard/status');
    // La Server Action del encargado no se importa (el comentario del módulo
    // explica por qué: rechazaría los retrocesos legítimos del KDS).
    expect(read('../../app/cocina/actions.ts')).not.toMatch(
      /^import\b[^;]*updateOrderStatusAction/m,
    );
  });
});

describe('pantalla de cocina — accesibilidad y toque', () => {
  it('el color nunca comunica solo: la tarjeta acompaña con texto', () => {
    const card = componentSrc('KitchenTicketCard.tsx');
    expect(card).toContain('Atrasado');
    expect(card).toContain('STAGE_LABELS');
    expect(card).toContain('aria-hidden="true"');
  });

  it('los botones primarios son objetivos táctiles grandes (>= 56 px)', () => {
    const card = componentSrc('KitchenTicketCard.tsx');
    expect(card).toMatch(/h-16 flex-1/); // botón gigante de avance: 64 px
    expect(card).toMatch(/h-16 w-16/); // basurero cuadrado: 64 px
  });

  it('un solo reloj compartido alimenta todos los temporizadores', () => {
    const screen = componentSrc('KitchenBoardScreen.tsx');
    expect((screen.match(/setInterval\(/g) ?? []).length).toBe(1);
    // Las tarjetas reciben el instante, no lo calculan por su cuenta: ni un
    // temporizador por tarjeta ni lecturas propias del reloj.
    const card = componentSrc('KitchenTicketCard.tsx');
    expect(card).not.toMatch(/setInterval\(/);
    expect(card).not.toMatch(/Date\.now\(\)/);
  });

  it('el primer render parte del reloj del servidor (sin desajuste de hidratación)', () => {
    expect(componentSrc('KitchenBoardScreen.tsx')).toContain('useState<number>(serverNow)');
  });

  it('el grid desborda en horizontal y solo scrollea la lista de productos', () => {
    const screen = componentSrc('KitchenBoardScreen.tsx');
    expect(screen).toContain('overflow-x-auto');
    expect(screen).toContain('inline-flex h-full flex-col flex-wrap');
    const card = componentSrc('KitchenTicketCard.tsx');
    expect(card).toContain('max-h-full');
    expect((card.match(/overflow-y-auto/g) ?? []).length).toBe(1);
  });
});

describe('seguridad — revisar pagos se autoriza por ROL, no por tener sesión', () => {
  /**
   * Estos tests leen el código fuente porque lo que hay que garantizar no es un
   * resultado sino una FORMA: que estas dos superficies no vuelvan a protegerse
   * con `hasValidSession()`.
   *
   * Esa función devuelve `true` para cualquier rol. Mientras la usaron, cocina ya
   * podía decidir pagos y abrir comprobantes de clientes; lo único que se lo
   * impedía era que la interfaz no le entregara los UUID. Un identificador que no
   * se enseña no es un control de acceso: basta conocerlo para saltárselo.
   *
   * Hoy cocina PUEDE hacer ambas cosas —se decidió así— pero porque
   * `canReviewPayments` lo concede, no porque nadie mire el rol. La diferencia
   * importa el día que se decida lo contrario: entonces bastará cambiar una
   * línea, en vez de descubrir que la puerta llevaba meses abierta.
   */
  const proofEndpoint = read('../../app/api/dashboard/proofs/file/route.ts');
  const dashboardActions = read('../../app/dashboard/actions.ts');

  it('el endpoint del comprobante comprueba el rol', () => {
    expect(proofEndpoint).toContain('canReviewPayments');
    expect(proofEndpoint).toContain('currentSessionRole');
    // Y ya no se apoya en "hay sesión, luego pasa".
    expect(proofEndpoint).not.toContain('hasValidSession');
  });

  it('la acción de revisión comprueba el rol', () => {
    expect(dashboardActions).toContain('canReviewPayments');
    // El bloque de la acción de pagos no puede volver a `hasValidSession`.
    const bloque =
      /export async function reviewPaymentAttemptAction[\s\S]*?\n}/.exec(dashboardActions)?.[0] ?? '';
    expect(bloque).toContain('canReviewPayments');
    expect(bloque).not.toContain('hasValidSession');
  });

  it('el permiso se comprueba en SERVIDOR, no en el componente', () => {
    // La tarjeta pinta los botones; quien autoriza es la Server Action. Si el
    // permiso viviera en el cliente, bastaría abrir las herramientas del
    // navegador para concedérselo uno mismo.
    for (const f of componentFiles) {
      expect(componentSrc(f), f).not.toContain('canReviewPayments');
    }
  });

  it('el KDS nunca recibe la ruta del archivo, solo su id', () => {
    // El comprobante se pide por el endpoint autenticado con el id del proof.
    // `storage_key` no sale de la base de datos hacia el navegador.
    const src = read('./data-source.ts');
    const columnas = /const KITCHEN_PROOF_COLUMNS =\s*([\s\S]*?);/.exec(src)?.[1] ?? '';
    expect(columnas).not.toContain('storage_key');
    expect(columnas).not.toContain('storage_namespace');
  });
});
