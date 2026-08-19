# `public/menu/` — fotos de los productos

Aquí van las **fotos individuales** de cada producto del menú.

> ⚠️ **Ahora mismo esta carpeta está vacía a propósito.** No se descargó ninguna
> imagen de internet. Mientras no existan las fotos, `/menu` dibuja un
> **placeholder propio** (gradiente CSS + emoji, según la categoría), sin pedir
> nada a la red y sin errores en consola.

## Cómo agregar una foto real

1. Copia el archivo a esta carpeta con **exactamente** el nombre de la tabla.
2. Abre [`src/lib/menu/catalog.ts`](../../src/lib/menu/catalog.ts), busca
   `PRODUCT_IMAGES` y cambia `src: null` por la ruta pública:

   ```ts
   la_fija: { src: '/menu/la-fija.webp', file: 'la-fija.webp', emoji: '🍔' },
   ```

3. Listo: la tarjeta pasa a mostrar la foto. Si el archivo falla al cargar, el
   componente vuelve solo al placeholder.

## Archivos esperados

| `code` (Supabase) | Producto | Archivo |
|---|---|---|
| `la_fija` | La Fija | `la-fija.webp` |
| `doble_o_nada` | Doble o Nada | `doble-o-nada.webp` |
| `hat_trick` | Hat Trick | `hat-trick.webp` |
| `lomito_jackpot` | Lomito Jackpot | `lomito-jackpot.webp` |
| `gaseosa_2l` | Gaseosa 2 L | `gaseosa.webp` |
| `gaseosa_personal` | Gaseosa personal | `gaseosa.webp` |
| `gaseosa_pequena` | Gaseosa pequeña | `gaseosa.webp` |
| `tocino` | Tocino | `tocino.webp` |
| `porcion_papas` | Porción de papas | `papas.webp` |

Las tres gaseosas comparten `gaseosa.webp` a propósito (mismo producto en
distinto tamaño). Si consigues fotos separadas, usa
`gaseosa-2l.webp`, `gaseosa-personal.webp` y `gaseosa-pequena.webp` y
actualiza también `file` en `PRODUCT_IMAGES`.

## Recomendaciones

- Formato **`.webp`**, cuadradas (1:1), ~800×800 px, menos de 150 KB.
  La tienda se abre dentro del navegador de WhatsApp, muchas veces con datos
  móviles: el peso importa.
- **No** uses la imagen general del menú (la del cartel con todos los precios)
  como foto de cada producto: se ve mal recortada y los precios de la foto
  quedarían desactualizados respecto a Supabase.
- El logo de portada del encabezado también puede vivir aquí
  (`logo.webp`); ver el comentario en
  [`MenuHeader.tsx`](../../src/components/menu/MenuHeader.tsx).
