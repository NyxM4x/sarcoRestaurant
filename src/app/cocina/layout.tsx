import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentSessionRole, isDashboardAuthConfigured } from '@/lib/dashboard/auth';
import { canAccessKitchen, LOGIN_PATH } from '@/lib/dashboard/session-role';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Cocina — Don Zarco Orders',
};

/**
 * Pantalla de cocina a pantalla completa: sin el shell de navegacion del panel
 * administrativo. Acceso para `kitchen` y tambien `admin` (el encargado a veces
 * mira el tablero). Fail-closed: sin configuracion, cerrado.
 */
export default async function KitchenLayout({ children }: { children: React.ReactNode }) {
  if (!isDashboardAuthConfigured()) {
    return (
      <main className="mx-auto flex min-h-full max-w-lg flex-col items-center justify-center px-6 py-16 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Cocina no disponible</h1>
        <p className="mt-2 text-sm text-zinc-500">
          El acceso interno no está configurado en el servidor.
        </p>
        <Link href="/" className="mt-6 text-sm text-zinc-500 hover:underline">← Inicio</Link>
      </main>
    );
  }

  const role = await currentSessionRole();
  if (role === null || !canAccessKitchen(role)) {
    redirect(LOGIN_PATH);
  }

  return children;
}
