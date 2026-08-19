'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logoutAction } from '@/app/dashboard/actions';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  soon?: boolean;
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Pedidos', icon: '🧾' },
  { href: '/dashboard/menu', label: 'Menú', icon: '🍔', soon: true },
  { href: '/dashboard/configuracion', label: 'Configuración', icon: '⚙️' },
];

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-1 flex-col gap-1 px-3">
      {NAV.map((item) => {
        const active = pathname === item.href;
        if (item.soon) {
          return (
            <span
              key={item.href}
              className="flex cursor-default items-center justify-between rounded-lg px-3 py-2 text-sm text-zinc-400 dark:text-zinc-600"
              aria-disabled="true"
            >
              <span className="flex items-center gap-3"><span aria-hidden className="opacity-60">{item.icon}</span>{item.label}</span>
              <span className="rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-zinc-400 ring-1 ring-inset ring-black/5 dark:text-zinc-600 dark:ring-white/10">Pronto</span>
            </span>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
              active
                ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                : 'text-zinc-600 hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.06]'
            }`}
          >
            <span aria-hidden>{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-5 py-5">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-zinc-900 text-sm font-bold text-white shadow-sm dark:bg-white dark:text-zinc-900">LF</span>
      <span className="flex flex-col leading-tight">
        <span className="text-base font-semibold tracking-tight">La Fija</span>
        <span className="text-[11px] text-zinc-400">Panel operativo</span>
      </span>
    </div>
  );
}

function LogoutButton() {
  return (
    <form action={logoutAction} className="px-3 pb-4">
      <button
        type="submit"
        className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-black/[0.04] dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/[0.06]"
      >
        Cerrar sesión
      </button>
    </form>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-full">
      {/* Sidebar de escritorio */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-black/[0.07] bg-white dark:border-white/10 dark:bg-zinc-950 lg:flex">
        <Brand />
        <NavLinks pathname={pathname} />
        <LogoutButton />
      </aside>

      {/* Barra superior móvil */}
      <div className="sticky top-0 z-20 flex items-center justify-between border-b border-black/[0.07] bg-white/90 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-zinc-950/90 lg:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Abrir menú" className="rounded-lg p-2 text-zinc-600 hover:bg-black/5 dark:text-zinc-300 dark:hover:bg-white/10">☰</button>
        <span className="text-sm font-semibold">La Fija</span>
        <span className="w-9" />
      </div>

      {/* Drawer móvil */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Cerrar menú" className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="relative flex h-full w-64 flex-col border-r border-black/10 bg-white dark:border-white/10 dark:bg-zinc-950">
            <Brand />
            <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
            <LogoutButton />
          </div>
        </div>
      )}

      <main className="lg:pl-60">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
