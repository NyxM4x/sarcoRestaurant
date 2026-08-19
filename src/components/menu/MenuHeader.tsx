import Image from 'next/image';

/**
 * Encabezado comercial de la tienda (hero compacto, identidad Don Zarco).
 * Server Component sin interactividad.
 *
 * Usa el logo oficial (`public/brand/logo-don-zarco.png`) y un motivo radial
 * muy sutil (rayos en SVG a baja opacidad), en línea con el aro naranja del
 * emblema. No muestra estado abierto/cerrado, horarios, tiempos de entrega,
 * descuentos ni promociones: esos datos no existen en el modelo y no deben
 * inventarse.
 */
export function MenuHeader() {
  return (
    <header className="relative overflow-hidden border-b border-donzarco-gold/30 bg-donzarco-red-dark px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-5 text-white">
      {/* Motivo discreto: rayos radiales + aro, como el emblema. */}
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full text-white/[0.06]"
        viewBox="0 0 400 160"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <circle cx="300" cy="80" r="46" />
        <circle cx="300" cy="80" r="62" />
        <line x1="300" y1="0" x2="300" y2="18" />
        <line x1="300" y1="142" x2="300" y2="160" />
        <line x1="222" y1="80" x2="238" y2="80" />
        <line x1="362" y1="80" x2="378" y2="80" />
      </svg>

      {/* Contenido centrado en desktop para alinear con el catálogo. */}
      <div className="relative mx-auto flex max-w-5xl items-center gap-4">
        <h1 className="sr-only">Don Zarco</h1>
        <Image
          src="/brand/logo-don-zarco.png"
          alt="Don Zarco"
          width={1254}
          height={1254}
          priority
          className="h-16 w-16 shrink-0 rounded-xl object-contain ring-1 ring-donzarco-gold/40 drop-shadow-sm sm:h-20 sm:w-20"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white/90">
            Trancapecho cochabambino · Santa Cruz
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-white/70">
            Arma tu carrito y termina el pedido por WhatsApp.
          </p>
        </div>
      </div>
    </header>
  );
}
