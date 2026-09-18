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

## `breakout/` — recortes con fondo transparente (EXPERIMENTAL, 17-09-2026)

Fotos SIN fondo (WebP con alfa, no cuadradas: cada una conserva la forma real
del plato) para la tarjeta "out of bounds" de la rama `rediseno-menu-fastfood`
— NO fusionada a `main`. No reemplazan a las de arriba: `ProductCard` las usa
como `src` que GANA a la del catálogo (mismo mecanismo que ya usan las
promociones), y solo para los `code` que tienen aquí su recorte. Todo lo demás
sigue con su foto cuadrada de siempre.

### El recorte se hace FUERA, con una herramienta de verdad

Las fotos llegaron primero como JPEG con un cuadriculado "de transparencia"
pintado en los propios píxeles (JPEG no admite canal alfa; quien las exportó
las aplanó). Se intentó quitar ese cuadriculado con un script propio, por
color: relleno por inundación desde el borde. **No alcanza, y no es cuestión
de afinarlo** — quedó documentado porque es un pozo en el que es fácil volver a
caer:

- Un plato BLANCO tiene casi la misma saturación que el gris del cuadriculado.
  El relleno cruzaba de uno al otro sin encontrar pared y se comía el plato
  entero en las tres fotos que lo tienen.
- Cerrar ese cruce con una apertura morfológica (erosionar la máscara antes de
  rellenar, dilatarla después) salvó los platos… y dejó islas de cuadriculado
  sin limpiar en la esquina de las dos fotos con tabla de madera, donde la
  tabla casi toca el borde.
- Cada ajuste arreglaba una foto y rompía otra. Un método que solo mira COLOR
  no puede distinguir "gris de fondo" de "objeto que es casi gris"; le falta la
  noción de qué es un plato.

Desde el 17-09-2026 el recorte se hace con **Photoroom** (cualquier herramienta
de segmentación sirve) y aquí solo se recorta el aire transparente sobrante y
se convierte a WebP con alfa. Ninguna heurística de color.

**Qué pedir al recortar una foto nueva:** fondo completamente transparente,
conservando el plato o la tabla (no solo la comida), exportado como **PNG con
canal alfa — nunca JPEG**, sin cuadriculado de "vista previa" en el archivo, y
con el lado más largo entre 1000 y 1500 px.

| `code` | Archivo | Origen | Recorte |
|---|---|---|---|
| `hamburguesa` | `hamburguesa.webp` | `hamburguesaSimple.jpg` (con tabla) | script (pendiente) |
| `lomito` | `lomito.webp` | `lomito...-Photoroom.png` | Photoroom ✅ |
| `salchiburguer` | `salchiburguer.webp` | `salchiburguer.jpg` | script (pendiente) |
| `salchipapa` | `salchipapa.webp` | `salchipapa...-Photoroom.png` | Photoroom ✅ |
| `trancaburguer` | `trancaburguer.webp` | `trancaburguer...-Photoroom.png` | Photoroom ✅ |
| `trancapecho` | `trancapecho.webp` | `trancapecho...-Photoroom.png` | Photoroom ✅ |

Las dos marcadas "script (pendiente)" salieron aceptables —tabla de madera, que
tiene color propio y el método de color sí distingue— pero conviene rehacerlas
con Photoroom cuando se pueda, por consistencia.

`hamburguesa-alt.webp`: la otra foto de hamburguesa que llegó (sin tabla), sin
usar — por si se prefiere a la de arriba. Ningún código la referencia.

Los seis platos ya tienen recorte. Sin recorte propio quedan las bebidas y los
extras: siguen con su foto cuadrada de siempre, dentro de su cajita redondeada.

**Al reemplazar un archivo de aquí, borrar `.next/dev/cache/images`.** Next
guarda cada tamaño optimizado por separado y la ruta no cambia, así que el
navegador puede seguir recibiendo la versión vieja durante horas. Costó una
ronda entera de "sigue mal" el 17-09-2026.
