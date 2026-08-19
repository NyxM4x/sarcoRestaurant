'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from '@/app/dashboard/actions';

const initial: LoginState = { error: null };

export function LoginForm({ configured }: { configured: boolean }) {
  const [state, formAction, pending] = useActionState(loginAction, initial);

  return (
    <form action={formAction} className="w-full max-w-sm rounded-2xl border border-black/[0.07] bg-white p-8 shadow-sm dark:border-white/10 dark:bg-zinc-900">
      <div className="mb-6 flex flex-col items-center gap-2">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-zinc-900 text-base font-bold text-white dark:bg-white dark:text-zinc-900">DZ</span>
        <h1 className="text-lg font-semibold tracking-tight">Don Zarco · Panel</h1>
        <p className="text-sm text-zinc-500">Acceso interno del restaurante</p>
      </div>

      {!configured && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          El acceso aún no está configurado en el servidor.
        </p>
      )}

      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200" htmlFor="password">
        Contraseña
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        disabled={!configured || pending}
        className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-400 focus:outline-none disabled:opacity-50 dark:border-white/15 dark:bg-zinc-950"
      />

      {state.error === 'invalid' && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">Contraseña incorrecta.</p>
      )}
      {state.error === 'not_configured' && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">El acceso no está configurado.</p>
      )}

      <button
        type="submit"
        disabled={!configured || pending}
        className="mt-5 w-full rounded-lg bg-zinc-900 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? 'Ingresando…' : 'Ingresar'}
      </button>
    </form>
  );
}
