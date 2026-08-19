export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Configuración — Don Zarco Orders',
};

/**
 * Configuración — placeholder honesto (Fase 6A.1). No inventa funciones: solo
 * enumera lo que llegará en fases posteriores.
 */
export default function ConfiguracionPage() {
  const upcoming = [
    'Gestión del menú (productos, precios, disponibilidad)',
    'Datos del restaurante y horarios',
    'Usuarios y roles del panel',
    'Preferencias de notificaciones',
  ];
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Configuración</h1>
      <p className="mt-1 text-sm text-zinc-500">Estas opciones estarán disponibles próximamente.</p>

      <ul className="mt-6 space-y-2">
        {upcoming.map((item) => (
          <li
            key={item}
            className="flex items-center justify-between rounded-xl border border-black/[0.07] bg-white px-4 py-3 text-sm dark:border-white/10 dark:bg-zinc-900"
          >
            <span className="text-zinc-700 dark:text-zinc-200">{item}</span>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800">
              Próximamente
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
