# `public/menu/` — fotos de los productos

Aquí van las **fotos individuales** de cada producto del menú.

> Los diez productos del catálogo ya tienen foto. Para uno nuevo sin foto,
> dejar `src: null`: `/menu` dibuja un **placeholder propio** (gradiente CSS +
> emoji, según la categoría), sin pedir nada a la red y sin errores en consola.

Las fotos se generaron con `sharp` desde los originales del cliente: cuadradas
1:1 a 800×800, WebP calidad 80. El recorte es centrado salvo en `salchipapa`,
cuyo original trae el rótulo "SABOR ÚNICO" arriba y se recortó por debajo.

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
| `gaseosa_2l` | Gaseosa 2 L | `gaseosa-2l.webp` | ✅ |
| `gaseosa_personal` | Gaseosa personal | `gaseosa-personal.webp` | ✅ |
| `gaseosa_pequena` | Gaseosa pequeña | `gaseosa-peque.webp` | ✅ |
| `porcion_papas` | Porción de papa | `porcion-papas.webp` | ✅ |

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
