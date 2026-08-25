import { redirect } from 'next/navigation';
import { currentSessionRole, isDashboardAuthConfigured } from '@/lib/dashboard/auth';
import { landingPathForRole } from '@/lib/dashboard/session-role';
import { LoginForm } from '@/components/dashboard/LoginForm';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Ingresar — Don Zarco Orders',
};

export default async function LoginPage() {
  const configured = isDashboardAuthConfigured();
  // Ya autenticado: cada rol aterriza donde trabaja.
  const role = configured ? await currentSessionRole() : null;
  if (role !== null) {
    redirect(landingPathForRole(role));
  }
  return (
    <main className="mx-auto flex min-h-full max-w-lg flex-1 items-center justify-center px-6 py-16">
      <LoginForm configured={configured} />
    </main>
  );
}
