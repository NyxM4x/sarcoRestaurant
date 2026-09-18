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
  porcion_papas: '/menu/breakout/porcion-papas.webp',
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
     * ── El rojo se ABRE y deja la comida sobre el fondo (18-09-2026) ────────
     *
     * Esto costó tres intentos, y el error de fondo fue leer mal la carta de
     * referencia: la zona clara detrás de la comida NO es una luz sobre el
     * rojo, es el FONDO DE LA PÁGINA. El contenedor rojo se desvanece hacia la
     * izquierda y a la altura de la mitad del plato ya no existe. Eso es lo
     * que deja la comida respirar: el rojo sostiene el texto y se aparta de la
     * foto, en vez de pasar por detrás de ella.
     *
     * De ahí las posiciones del degradado: transparente hasta el 20% —donde
     * cae el centro de la foto—, cierra hacia el 50% y de ahí a la derecha es
     * rojo firme, detrás del nombre y el precio.
     *
     * Es `red-600/0` y no `transparent`: desvanecer hacia `transparent` mete
     * un gris turbio en medio del degradado, porque el navegador interpola
     * pasando por un color neutro. Hacia el mismo rojo con alfa 0, limpio.
     *
     * Y por eso esta tarjeta NO lleva sombra ni borde en su estado normal: los
     * dos siguen el rectángulo completo, también donde ya no hay fondo, y
     * dibujaban el contorno de una tarjeta invisible junto al plato. La
     * profundidad la pone la sombra de la propia foto.
     *
     * Rojo `red-600 → red-700` y no el `donzarco-red` del logo (#e8481f):
     * aquel es un rojo anaranjado y sobre un fondo naranja se emparentaba con
     * él en vez de destacar. El de la referencia es un rojo franco.
     *
     * El aro dorado sigue siendo solo "esto está en tu carrito".
     */
    <article
      className={`relative z-0 flex h-36 w-full items-center justify-end rounded-[2rem] bg-gradient-to-r from-red-600/0 from-20% via-red-600 via-50% to-red-700 pr-4 pl-36 transition-shadow sm:h-40 sm:pl-40 md:h-44 md:pl-44 ${
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
       * crece con la pantalla es el TAMAÑO de la foto (h-40 → sm:h-44 →
       * md:h-48), nunca el desborde.
       *
       * La foto es MÁS ALTA que la tarjeta a propósito (17-09-2026): 160px
       * contra 144px en celular. Ese sobresalir arriba y abajo es lo que la
       * despega del fondo; con la foto contenida dentro, la tarjeta parecía
       * una lista con miniaturas.
       */}
      {breakoutSrc ? (
        <>
          {/*
           * Aquí hubo un "halo" —un degradado claro detrás de la comida— y se
           * quitó el 18-09-2026. Era una lectura equivocada de la carta de
           * referencia: lo claro detrás del plato no es una luz sobre el rojo,
           * es el fondo de la página, que se ve porque el contenedor rojo se
           * abre (ver el degradado del `<article>`). Con el rojo abriéndose, un
           * halo encima solo ensuciaba la zona que tiene que quedar limpia.
           */}
          <Image
            src={breakoutSrc}
            alt={item.name}
            width={400}
            height={400}
            sizes="(min-width: 768px) 192px, (min-width: 640px) 176px, 160px"
            className={`absolute -left-4 top-1/2 z-10 h-40 w-40 -translate-y-1/2 object-contain drop-shadow-2xl sm:h-44 sm:w-44 md:h-48 md:w-48 ${
              available ? '' : 'grayscale'
            }`}
          />
        </>
      ) : (
        <div className="absolute -left-4 top-1/2 z-10 -translate-y-1/2">
          <ProductImage
            item={item}
            unavailable={!available}
            className="h-28 w-28 rounded-2xl shadow-xl ring-4 ring-donzarco-gold sm:h-32 sm:w-32"
          />
        </div>
      )}

      <div className="flex w-full flex-col justify-center text-right">
        {/*
         * `pr-1` no es aire decorativo: es lo que evita que se coma la última
         * letra (17-09-2026).
         *
         * `line-clamp-2` recorta lo que se desborde, y la cursiva inclina cada
         * glifo hacia la derecha: con el texto pegado al borde, la panza de la
         * última letra caía justo fuera de la caja y se cortaba. Se veía
         * "TRANCAPECHC" en vez de "TRANCAPECHO". El respiro va a la derecha
         * porque es el lado hacia el que se inclina la cursiva.
         */}
        <h3 className="font-display line-clamp-2 pr-1 text-xl leading-tight tracking-wide text-white uppercase italic drop-shadow-[0_2px_0_rgba(0,0,0,0.5)]">
          {item.name}
        </h3>

        {description ? (
          <p className="line-clamp-2 text-xs leading-tight text-white/80">{description}</p>
        ) : null}

        <div className="mt-1 flex items-center justify-end gap-2">
          {/*
           * La PLATA no va en la display (18-09-2026).
           *
           * En Bangers el 7 es casi un 1: la porción de papa a Bs 7 se leía
           * "Bs 1". No es un problema de ese precio, es del glifo — cualquier
           * cifra con 7 lo tiene, y los totales lo llevan todo el tiempo (un
           * pedido de Bs 71 leído como Bs 11 es una discusión en la puerta).
           *
           * Tampoco va en la sans de siempre: se probó y quedaba formal, de
           * otra carta. Va en `font-price` (Luckiest Guy): mantiene el golpe de
           * comida rápida con los dígitos sin ambigüedad. `tabular-nums` deja
           * todos del mismo ancho, así los precios se alinean entre tarjetas.
           */}
          <span className="font-price mt-1 text-2xl tracking-wide text-yellow-400 tabular-nums">
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
            /*
             * Naranja, no el vidrio translúcido de antes (18-09-2026): sobre el
             * rojo opaco, un botón translúcido se veía como una mancha del
             * mismo color. El naranja es el único acento cálido que se separa
             * del rojo sin salirse de la paleta, y el "+" en blanco puro es lo
             * que se ve primero. Es la acción principal de la tarjeta: tiene
             * que gritar dónde tocar.
             */
            <button
              type="button"
              onClick={onAdd}
              aria-label={`Agregar ${item.name} al carrito`}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xl font-bold text-white shadow-lg shadow-black/30 ring-2 ring-white/25 transition-transform active:scale-90"
            >
              +
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
