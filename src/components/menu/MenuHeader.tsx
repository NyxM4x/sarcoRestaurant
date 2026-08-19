import Image from 'next/image';

/**
 * Encabezado comercial de la tienda (hero compacto, identidad La Fija).
 * Server Component sin interactividad.
 *
 * Usa el logo oficial (`public/brand/la-fija-logo.webp`) y una geometría de
 * cancha muy sutil (líneas finas en SVG a baja opacidad). No muestra estado
 * abierto/cerrado, horarios, tiempos de entrega, descuentos ni promociones:
 * esos datos no existen en el modelo y no deben inventarse.
 */
export function MenuHeader() {
  return (
    <header className="relative overflow-hidden border-b border-lafija-gold/30 bg-lafija-green-dark px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-5 text-white">
      {/* Motivo de cancha discreto: línea de medio campo + círculo central. */}
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full text-white/[0.06]"
        viewBox="0 0 400 160"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <line x1="300" y1="0" x2="300" y2="160" />
        <circle cx="300" cy="80" r="46" />
        <circle cx="300" cy="80" r="2.5" fill="currentColor" stroke="none" />
        <path d="M400 22 A 42 42 0 0 0 358 64" />
      </svg>

      {/* Contenido centrado en desktop para alinear con el catálogo. */}
      <div className="relative mx-auto flex max-w-5xl items-center gap-4">
        <h1 className="sr-only">La Fija</h1>
        <Image
          src="/brand/logo-la-fija-redondo-transparente.webp"
          alt="La Fija"
          width={1254}
          height={1254}
          priority
          className="h-14 w-auto shrink-0 drop-shadow-sm sm:h-16"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white/90">
            Hamburguesas a la parrilla · Santa Cruz
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-white/70">
            Arma tu carrito y termina el pedido por WhatsApp.
          </p>
        </div>
      </div>
    </header>
  );
}
