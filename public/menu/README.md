# `public/menu/` — fotos de los productos

Aquí van las **fotos individuales** de cada producto del menú.

> Los quince productos del catálogo ya tienen foto. Para uno nuevo sin foto,
> dejar `src: null`: `/menu` dibuja un **placeholder propio** (gradiente CSS +
> emoji, según la categoría), sin pedir nada a la red y sin errores en consola.

Las fotos se generaron con `sharp` desde los originales del cliente: cuadradas
1:1 a 800×800, WebP calidad 80, con recorte centrado.

Los **seis platos** se rehicieron el 04-09-2026 con fotos nuevas del local.
Llegaron verticales (9:16, 720×1280 y 900×1600, hasta 181 KB) y se normalizaron
al mismo 800×800 que el resto: sin eso, la vitrina mezclaba proporciones y cada
tarjeta pesaba el triple. El recorte es **centrado** y no el de saliencia de
`sharp` (`strategy.attention`), que se probó y cortaba el pan de arriba en
cuatro de las seis. Quedaron entre 33 y 48 KB.

## Cómo agregar una foto real

1. Copia el archivo a esta carpeta con **exactamente** el nombre de la tabla.
2. Abre [`src/lib/menu/catalog.ts`](../../src/lib/menu/catalog.ts), busca
   `PRODUCT_IMAGES` y cambia `src: null` por la ruta pública:

   ```ts
   trancapecho: { src: '/menu/trancapecho.webp', file: 'trancapecho.webp', emoji: '🥪' },
   ```

3. Listo: la tarjeta pasa a mostrar la foto. Si el archivo falla al cargar, el
   componente vuelve solo al placeholder.

## Archivos esperados

| `code` (Supabase) | Producto | Archivo | ¿Existe? |
|---|---|---|---|
| `trancaburguer` | Trancaburguer | `trancaburguer.webp` | ✅ |
| `trancapecho` | Trancapecho | `trancapecho.webp` | ✅ |
| `salchiburguer` | Salchiburguer | `salchiburguer.webp` | ✅ |
| `hamburguesa` | Hamburguesa | `hamburguesa.webp` | ✅ |
| `lomito` | Lomito | `lomito.webp` | ✅ |
| `salchipapa` | Salchipapa | `salchipapa.webp` | ✅ |
| `soda_peque` | Soda Peque | `soda-peque.webp` | ✅ |
| `soda_mini` | Soda Mini | `soda-mini.webp` | ✅ |
| `vaso_maracuya` | Vaso grande de maracuyá | `vaso-maracuya.webp` | ✅ |
| `vaso_limonada` | Vaso grande de limonada | `vaso-limonada.webp` | ✅ |
| `vaso_lima` | Vaso grande de lima | `vaso-lima.webp` | ✅ |
| `vaso_pina` | Vaso grande de piña | `vaso-pina.webp` | ✅ |
| `porcion_papas` | Porción de papa | `porcion-papas.webp` | ✅ |

Retirados del menú en 0030, con su foto todavía aquí por si vuelven:
`gaseosa-2l.webp`, `gaseosa-personal.webp`.

## Promociones

Un combo NO necesita foto propia: si `promotions.image_url` está vacío, la
tarjeta usa la del **componente protagonista** —plato antes que extra, extra
antes que bebida, y a igualdad el más caro—, así que "2 lomitos goleadores"
sale con la foto del lomito sin que nadie suba nada.

Para darle una foto propia, déjala aquí y escribe su ruta (`/menu/archivo.webp`)
en `image_url`. También admite un `https://` externo; cualquier otra cosa se
ignora y se cae al componente (ver `isAllowedImageUrl`).

## Recomendaciones

- Formato **`.webp`**, cuadradas (1:1), ~800×800 px, menos de 150 KB.
  La tienda se abre dentro del navegador de WhatsApp, muchas veces con datos
  móviles: el peso importa.
- **No** uses la imagen general del menú (la del cartel con todos los precios)
  como foto de cada producto: se ve mal recortada y los precios de la foto
  quedarían desactualizados respecto a Supabase.
- El logo de marca vive en [`public/brand/logo-don-zarco.png`](../brand/); ver
  el comentario en
  [`MenuHeader.tsx`](../../src/components/menu/MenuHeader.tsx).
