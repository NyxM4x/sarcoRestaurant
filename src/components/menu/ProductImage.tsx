'use client';

import Image from 'next/image';
import { useState } from 'react';
import type { MenuItem } from '@/types';
import { productImage } from '@/lib/menu/catalog';

const TONES: Record<MenuItem['category'], string> = {
  plato: 'from-amber-100 to-amber-300',
  bebida: 'from-sky-100 to-sky-300',
  extra: 'from-orange-100 to-orange-300',
};

/**
 * Foto del producto, con placeholder propio DELIBERADO (gradiente por categoría
 * + emoji en un disco esmerilado, sin red). No parece un error de imagen rota.
 *
 * Mientras `productImage(item).src` sea `null` no se pide ninguna imagen. Cuando
 * existan fotos reales basta con copiarlas a `public/menu/` y asignar `src` por
 * `code` en `PRODUCT_IMAGES` (ver `public/menu/README.md`): este componente las
 * usará automáticamente. Si una foto real falla al cargar, cae al placeholder.
 */
export function ProductImage({
  item,
  className = '',
  sizes = '(max-width: 640px) 40vw, 200px',
  unavailable = false,
}: {
  item: MenuItem;
  className?: string;
  sizes?: string;
  /** Atenúa la imagen cuando el producto no está disponible (presentación). */
  unavailable?: boolean;
}) {
  const image = productImage(item);
  const [failed, setFailed] = useState(false);
  const showPhoto = image.src !== null && !failed;

  return (
    <div
      className={`relative overflow-hidden bg-gradient-to-br ${TONES[item.category]} ${
        unavailable ? 'grayscale' : ''
      } ${className}`}
    >
      {showPhoto ? (
        <Image
          src={image.src as string}
          alt={item.name}
          fill
          sizes={sizes}
          className="object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
          <span className="flex h-[62%] w-[62%] items-center justify-center rounded-full bg-white/45 text-3xl shadow-inner ring-1 ring-white/60 select-none">
            {image.emoji}
          </span>
        </span>
      )}
    </div>
  );
}
