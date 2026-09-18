'use client';

import Image from 'next/image';
import type { MenuItem } from '@/types';
// Formatter monetario de presentación compartido (puro): `Bs 45,00`. El valor en
// base sigue siendo BOB; esto solo cambia cómo se muestra.
import { formatMoney } from '@/lib/dashboard/format';
import { productDescription } from '@/lib/menu/catalog';
import { ProductImage } from './ProductImage';
import { QuantityControl } from './QuantityControl';

/**
 * Tarjeta de producto — rediseño fast-food "out of bounds" (EXPERIMENTAL, rama
 * `rediseno-menu-fastfood`, 17-09-2026. NO fusionada a `main`: se prueba en
 * localhost antes de decidir si reemplaza a la tarjeta clásica).
 *
 * ── Dos fotos distintas para dos casos distintos ─────────────────────────────
 *
 * `BREAKOUT_IMAGES` son recortes reales SIN fondo (ver `public/menu/README.md
 * #breakout`): flotan sobre la tarjeta con `object-contain` + `drop-shadow`,
 * sin ninguna caja ni color detrás — son la mitad de la gracia del efecto.
 *
 * El resto del catálogo (bebidas y extras, que siguen sin recorte propio) NO
 * tiene una foto así: forzarla a `object-contain` sobre una foto
 * CUADRADA con su propio fondo se vería como una caja recortada a la mitad, no
 * como un producto flotando. Esos siguen con `ProductImage` de siempre —foto
 * cuadrada o placeholder— en el mismo lugar, solo que sin el efecto de salirse
 * del borde.
 */
const BREAKOUT_IMAGES: Record<string, string> = {
  hamburguesa: '/menu/breakout/hamburguesa.webp',
  lomito: '/menu/breakout/lomito.webp',
  salchiburguer: '/menu/breakout/salchiburguer.webp',
  salchipapa: '/menu/breakout/salchipapa.webp',
  trancaburguer: '/menu/breakout/trancaburguer.webp',
  trancapecho: '/menu/breakout/trancapecho.webp',
};

export function ProductCard({
  item,
  quantity,
  onAdd,
  onRemove,
}: {
  item: MenuItem;
  quantity: number;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const description = productDescription(item.code);
  const available = item.is_active;
  const inCart = quantity > 0;
  const breakoutSrc = BREAKOUT_IMAGES[item.code];

  return (
    /*
     * `z-0` no es decoración: encierra el apilado de la tarjeta (17-09-2026).
     *
     * La foto flotante lleva `z-10` para montarse sobre el fondo de SU tarjeta.
     * Sin este `z-0`, ese 10 competía con el del encabezado de categoría —que
     * también es 10— en el mismo plano global, y al ganar el que va después en
     * el documento, las fotos pasaban por encima del título al desplazarse.
     *
     * Con `z-0` la tarjeta abre su propio plano: el `z-10` de la foto solo vale
     * PUERTAS ADENTRO, y la tarjeta entera queda por debajo del encabezado.
     *
     * ── El rojo NACE transparente, y eso se lleva la sombra y el borde ───────
     *
     * El degradado arranca en `red-900/0` —rojo con opacidad cero, no
     * `transparent`— y recién cierra hacia la derecha. Así el plato queda sobre
     * el fondo naranja de la página y el rojo aparece detrás del texto, como en
     * la carta que se tomó de referencia. Es `/0` y no `transparent` a
     * propósito: desvanecer hacia `transparent` mete un gris turbio en el medio
     * del degradado; hacia el mismo rojo con alfa 0, el desvanecido es limpio.
     *
     * Consecuencia que no se ve venir: la sombra (`shadow-lg`) y el borde
     * (`ring-1`) siguen el rectángulo COMPLETO, también donde ya no hay fondo.
     * Dibujaban el contorno de una tarjeta invisible flotando junto al plato.
     * Por eso el estado normal va sin ninguno de los dos; la profundidad la
     * pone la sombra de la propia foto.
     *
     * El aro dorado se queda solo para "esto está en tu carrito": ahí el
     * contorno completo es justamente la señal que se quiere.
     */
    <article
      className={`relative z-0 flex h-36 w-full items-center justify-end rounded-[2rem] bg-gradient-to-r from-red-900/0 from-10% via-red-900/90 via-45% to-red-700 pr-4 pl-24 transition-shadow sm:h-36 sm:pl-32 md:h-40 md:pl-36 ${
        inCart ? 'ring-2 ring-donzarco-gold' : ''
      } ${available ? '' : 'opacity-60 grayscale'}`}
    >
      {/*
       * Imagen flotante "out of bounds" — se sale por la izquierda.
       *
       * ── El -left-4 NO es decorativo: es el mismo número que el margen de
       *    la página (17-09-2026) ──────────────────────────────────────────
       *
       * La primera versión usaba `-left-8` (32px) con la foto a `w-44` (176px):
       * en un celular real, con el catálogo a una sola columna y el margen de
       * la página en `px-4` (16px, en `MenuStore`), esos 32px de salida
       * superaban el margen disponible. El resultado no era la foto
       * "saliéndose de la tarjeta" — era la foto saliéndose de la PANTALLA,
       * empujando scroll horizontal y tapando todo lo demás. Se veía en el
       * modo celular del navegador tan bien como en un teléfono real; no hacía
       * falta ninguno de los dos para encontrarlo.
       *
       * `-left-4` = 16px es EXACTAMENTE ese margen: la foto llega justo al
       * borde de la pantalla y nunca más allá, en cualquier tamaño. Lo que
       * crece con la pantalla es el TAMAÑO de la foto (h-24 → sm:h-32 →
       * md:h-36), nunca el desborde.
       */}
      {breakoutSrc ? (
        <>
          {/*
           * Halo de luz detrás del plato: el fondo rojo se "aclara" donde está
           * la comida, como en la carta del colega que se tomó de referencia.
           * Hace que el plato se despegue del rojo en vez de quedar hundido.
           *
           * Ocupa EXACTAMENTE la misma caja que la foto, ni un píxel más: la
           * suavidad la pone el desenfoque, que no cuenta para el ancho de la
           * página. Un halo más grande que la foto se saldría de la pantalla
           * por la izquierda y traería de vuelta el scroll horizontal.
           */}
          <span
            aria-hidden
            className="pointer-events-none absolute -left-4 top-1/2 h-24 w-24 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(255,180,70,0.75)_0%,rgba(255,120,30,0.35)_55%,transparent_78%)] blur-lg sm:h-32 sm:w-32 md:h-36 md:w-36"
          />
          <Image
            src={breakoutSrc}
            alt={item.name}
            width={400}
            height={400}
            sizes="(min-width: 768px) 144px, (min-width: 640px) 128px, 96px"
            className={`absolute -left-4 top-1/2 z-10 h-24 w-24 -translate-y-1/2 object-contain drop-shadow-2xl sm:h-32 sm:w-32 md:h-36 md:w-36 ${
              available ? '' : 'grayscale'
            }`}
          />
        </>
      ) : (
        <div className="absolute -left-4 top-1/2 z-10 -translate-y-1/2">
          <ProductImage
            item={item}
            unavailable={!available}
            className="h-20 w-20 rounded-2xl shadow-xl ring-4 ring-donzarco-gold sm:h-24 sm:w-24"
          />
        </div>
      )}

      <div className="flex w-full flex-col justify-center text-right">
        <h3 className="font-display line-clamp-2 text-xl leading-tight tracking-wide text-white uppercase italic drop-shadow-[0_2px_0_rgba(0,0,0,0.5)]">
          {item.name}
        </h3>

        {description ? (
          <p className="line-clamp-2 text-xs leading-tight text-white/80">{description}</p>
        ) : null}

        <div className="mt-1 flex items-center justify-end gap-2">
          <span className="font-display mt-1 text-2xl font-black text-yellow-400 tabular-nums">
            {formatMoney(item.price)}
          </span>

          {!available ? (
            /* La MISMA palabra que usa el panel al retirarlo
               (`MenuAvailability`) y la que dice el negocio por WhatsApp. Dos
               nombres para el mismo estado hacen dudar de si son dos estados. */
            <span className="rounded-full bg-black/40 px-3 py-1.5 text-xs font-semibold text-white/70 ring-1 ring-white/20">
              Agotado
            </span>
          ) : inCart ? (
            <QuantityControl
              name={item.name}
              quantity={quantity}
              onAdd={onAdd}
              onRemove={onRemove}
              size="sm"
              tone="inverse"
            />
          ) : (
            <button
              type="button"
              onClick={onAdd}
              aria-label={`Agregar ${item.name} al carrito`}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-lg font-bold text-white ring-1 ring-white/30 backdrop-blur-sm transition-transform active:scale-90"
            >
              +
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
