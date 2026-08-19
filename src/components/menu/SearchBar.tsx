'use client';

/** Buscador local: filtra por nombre y descripción sin llamar al servidor. */
export function SearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <span
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-zinc-400"
        aria-hidden
      >
        🔍
      </span>
      <input
        type="search"
        inputMode="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Buscar hamburguesa, bebida…"
        aria-label="Buscar en el menú"
        className="w-full rounded-full border border-zinc-200 bg-white py-3 pr-4 pl-10 text-base text-zinc-900 placeholder:text-zinc-400 focus:border-lafija-green-dark focus:ring-2 focus:ring-lafija-green-dark/20 focus:outline-none"
      />
    </div>
  );
}
