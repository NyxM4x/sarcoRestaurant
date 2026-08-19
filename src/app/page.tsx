import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-6 py-24 text-center dark:bg-black">
      <span className="text-4xl" aria-hidden>
        ⚽
      </span>
      <h1 className="text-3xl font-semibold tracking-tight">La Fija Orders</h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        Sistema de pedidos por WhatsApp. Este es el panel interno del
        restaurante La Fija.
      </p>
      <Link
        href="/dashboard"
        className="rounded-full bg-foreground px-6 py-3 text-sm font-medium text-background transition-colors hover:opacity-90"
      >
        Ir al dashboard
      </Link>
      <p className="text-xs text-zinc-400">Fase 1 — Base (scaffolding)</p>
    </main>
  );
}
