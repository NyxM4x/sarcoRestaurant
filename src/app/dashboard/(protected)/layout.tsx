import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentSessionRole, isDashboardAuthConfigured } from '@/lib/dashboard/auth';
import { canAccessAdmin, KITCHEN_HOME, LOGIN_PATH } from '@/lib/dashboard/session-role';
import { DashboardShell } from '@/components/dashboard/DashboardShell';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Panel — Don Zarco Orders',
};

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  // Fail-closed: sin configuración de acceso, nadie entra.
  if (!isDashboardAuthConfigured()) {
    return (
      <main className="mx-auto flex min-h-full max-w-lg flex-col items-center justify-center px-6 py-16 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Panel no disponible</h1>
        <p className="mt-2 text-sm text-zinc-500">
          El acceso interno no está configurado en el servidor. Define{' '}
          <code className="rounded bg-black/[0.06] px-1 dark:bg-white/10">DASHBOARD_SESSION_SECRET</code>{' '}
          y da de alta al menos un usuario en la tabla{' '}
          <code className="rounded bg-black/[0.06] px-1 dark:bg-white/10">dashboard_users</code>.
        </p>
        <Link href="/" className="mt-6 text-sm text-zinc-500 hover:underline">← Inicio</Link>
      </main>
    );
  }

  const role = await currentSessionRole();
  if (role === null) {
    redirect(LOGIN_PATH);
  }
  // El panel administrativo es del encargado. Un cocinero que llegue aqui
  // (enlace guardado, teclear la URL) vuelve a su tablero, no ve datos del panel.
  if (!canAccessAdmin(role)) {
    redirect(KITCHEN_HOME);
  }

  return <DashboardShell>{children}</DashboardShell>;
}
