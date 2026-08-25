import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const componentsDir = fileURLToPath(new URL('../../components/dashboard', import.meta.url));
const componentFiles = readdirSync(componentsDir).filter((f) => f.endsWith('.tsx'));
const componentSrc = (f: string) => readFileSync(`${componentsDir}/${f}`, 'utf8');

describe('seguridad — service_role nunca en el cliente', () => {
  it('14. ningún componente del dashboard importa el cliente service_role ni la clave', () => {
    for (const f of componentFiles) {
      const src = componentSrc(f);
      expect(src, f).not.toContain('@/lib/supabase/server');
      expect(src, f).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(src, f).not.toContain('@/lib/dashboard/data-source');
    }
  });

  it('14. los componentes cliente no importan módulos server-only (auth/data-source)', () => {
    for (const f of componentFiles) {
      const src = componentSrc(f);
      if (!src.includes("'use client'")) continue;
      expect(src, f).not.toContain('@/lib/dashboard/auth');
    }
  });

  it('los módulos server-only declaran server-only y usan service_role solo ahí', () => {
    expect(read('./data-source.ts')).toContain("import 'server-only'");
    expect(read('./auth.ts')).toContain("import 'server-only'");
  });
});

describe('seguridad — sin NEXT_PUBLIC', () => {
  it('15. ni los componentes ni la lógica del dashboard usan NEXT_PUBLIC_', () => {
    for (const f of componentFiles) expect(componentSrc(f), f).not.toContain('NEXT_PUBLIC');
    expect(read('./data-source.ts')).not.toContain('NEXT_PUBLIC');
    expect(read('./auth.ts')).not.toContain('NEXT_PUBLIC');
  });

  it('15. las variables del dashboard en env.ts no son NEXT_PUBLIC_', () => {
    const env = read('../env/env.ts');
    expect(env).toContain('DASHBOARD_SESSION_SECRET');
    expect(env).not.toMatch(/NEXT_PUBLIC_DASHBOARD/);
    // Las credenciales ya no viven en el entorno: estan en `dashboard_users`.
    expect(env).not.toContain('DASHBOARD_PASSWORD');
    expect(env).not.toContain('KITCHEN_PASSWORD');
  });
});

describe('seguridad — el dashboard no altera notificaciones ni alertas', () => {
  it('20. el adaptador de datos solo LEE order_notifications (nunca update/insert/delete)', () => {
    const src = read('./data-source.ts');
    // Cada referencia a order_notifications debe ir seguida solo de .select.
    expect(src).toContain("from('order_notifications')");
    expect(src).not.toMatch(/order_notifications'\)[\s\S]{0,80}\.(update|insert|delete|upsert)\(/);
    // La única escritura permitida es sobre orders.status.
    expect(src).toMatch(/from\('orders'\)\s*\.update\(\{ status/);
  });

  it('20. la Server Action de cambio de estado no accede a notificaciones ni a Telegram/Kapso', () => {
    const actions = read('../../app/dashboard/actions.ts');
    // No accede a la tabla de notificaciones ni importa transporte de alertas/WhatsApp.
    expect(actions).not.toMatch(/from\(\s*['"]order_notifications['"]/);
    expect(actions).not.toMatch(/@\/lib\/alerts|createTelegramAlertSender|sendMessage|@\/lib\/kapso/);
  });
});

describe('accesibilidad y responsive', () => {
  it('19. el shell define layout responsive (sidebar de escritorio + menú móvil)', () => {
    const shell = componentSrc('DashboardShell.tsx');
    expect(shell).toMatch(/lg:/); // breakpoints de escritorio
    expect(shell).toContain('Abrir menú'); // toggle móvil
  });

  it('el badge de estado no comunica solo con color (incluye la etiqueta)', () => {
    const badge = componentSrc('StatusBadge.tsx');
    expect(badge).toContain('meta.label');
  });
});

describe('presentación 6A.2', () => {
  it('la lista usa el formatter Bs centralizado (nunca "BOB " literal)', () => {
    const list = componentSrc('OrderList.tsx');
    expect(list).toContain('formatMoney');
    for (const f of componentFiles) expect(componentSrc(f), f).not.toContain('BOB ');
  });

  it('la tarjeta ofrece acción contextual respetando las transiciones existentes', () => {
    const list = componentSrc('OrderList.tsx');
    expect(list).toContain('primaryActionFor');
    // La acción rápida usa la Server Action existente (no crea transiciones nuevas).
    expect(componentSrc('OrdersDashboard.tsx')).toContain('updateOrderStatusAction');
  });

  it('el estado vacío tiene título y explicación', () => {
    const list = componentSrc('OrderList.tsx');
    expect(list).toContain('No hay pedidos');
    expect(list).toContain('No encontramos pedidos');
  });

  it('las tarjetas de resumen usan el lenguaje operativo 6C (sin "Confirmados")', () => {
    const cards = componentSrc('SummaryCards.tsx');
    for (const label of ['Pedidos de hoy', 'En preparación', 'En camino / Listos', 'Entregados']) {
      expect(cards).toContain(label);
    }
    expect(cards).not.toContain('Confirmados');
  });

  it('los nombres de cliente se normalizan visualmente en lista y detalle', () => {
    expect(componentSrc('OrderList.tsx')).toContain('formatCustomerName');
    expect(componentSrc('OrderDetailPanel.tsx')).toContain('formatCustomerName');
  });
});

describe('microajustes 6A.3', () => {
  it('el drawer usa una única región scrollable y el footer no se superpone al contenido', () => {
    const panel = componentSrc('OrderDetailPanel.tsx');
    // El contenedor raíz no scrollea; solo el área de contenido (evita doble scrollbar).
    expect(panel).toMatch(/<aside[^>]*flex[^>]*flex-col[^>]*overflow-hidden/);
    expect(panel).toMatch(/min-h-0 flex-1 overflow-y-auto[^"]*pb-8/);
    // El footer deja de ser sticky: es un hermano flex fijo que nunca tapa el contenido.
    expect(panel).not.toContain('sticky bottom-0');
    expect(panel).toMatch(/<footer[^>]*shrink-0/);
  });

  it('las Summary Cards usan iconos SVG monocromáticos accesibles (sin emojis)', () => {
    const cards = componentSrc('SummaryCards.tsx');
    // Ya no hay emojis.
    for (const emoji of ['📋', '🕒', '🕐', '🍳', '✅', '🎉']) {
      expect(cards).not.toContain(emoji);
    }
    // Iconos SVG decorativos con currentColor y ocultos a lectores de pantalla.
    expect(cards).toContain('<svg');
    expect(cards).toContain('stroke="currentColor"');
    expect(cards).toContain('aria-hidden="true"');
    expect(cards).toContain('focusable="false"');
    // Se conserva la barra de color y las etapas operativas.
    expect(cards).toMatch(/absolute inset-y-0 left-0 w-1/);
    for (const label of ['Pedidos de hoy', 'En preparación', 'En camino / Listos', 'Entregados']) {
      expect(cards).toContain(label);
    }
  });

  it('el detalle operativo aplica el formatter visual de teléfono', () => {
    const panel = componentSrc('OrderDetailPanel.tsx');
    expect(panel).toContain('formatPhone');
    expect(panel).toMatch(/formatPhone\(detail\.contactPhone\)/);
  });

  it('el header se compacta en móvil sin perder información (restaura tamaños en escritorio)', () => {
    const header = componentSrc('DashboardHeader.tsx');
    expect(header).toMatch(/text-xl[^"]*sm:text-2xl/); // título más pequeño en móvil
    expect(header).toContain('Pedidos');
    expect(header).toContain('Actualizar');
    expect(header).toMatch(/Actualizado|Sin actualizar/);
  });
});
