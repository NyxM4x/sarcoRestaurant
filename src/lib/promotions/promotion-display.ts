import { BOLIVIA_UTC_OFFSET_MS } from '@/lib/orders/business-day';
import type { MenuCategory } from '@/types';
import type { PromotionComponent, PromotionStatus } from './promotion';

/**
 * Cómo se PINTA una promoción — módulo PURO.
 *
 * Composición, vigencia e imagen. Separado de `./promotion` porque aquello
 * decide si un combo se puede vender —una regla de negocio que también aplica el
 * servidor— y esto solo decide qué letras y qué foto ve el cliente.
 *
 * Las tres funciones tienen algo en común: DERIVAN de los datos reales. Ninguna
 * acepta un texto escrito a mano. Una composición tecleada se desincroniza del
 * combo el día que se le cambia una cantidad, y una fecha escrita a mano miente
 * en cuanto alguien mueve el vencimiento desde el panel.
 */

// ── Estado, en palabras ─────────────────────────────────────────────────────

/**
 * Cómo se nombra cada estado en el panel.
 *
 * Van SIEMPRE con su texto, nunca solo con un color: quien no distingue el
 * verde del ámbar tiene el mismo derecho a saber si su promoción está en la
 * calle. El color acompaña, no informa.
 *
 * `incomplete` se llama "Incompleta" y no "Sin productos" porque también
 * cubre el combo de una sola unidad, que sí tiene producto pero no es un combo.
 */
const STATUS_LABELS: Record<PromotionStatus, string> = {
  available: 'Activa',
  disabled: 'Apagada',
  scheduled: 'Programada',
  expired: 'Vencida',
  component_unavailable: 'No disponible',
  incomplete: 'Incompleta',
  no_savings: 'Sin ahorro',
};

export function statusLabel(status: PromotionStatus): string {
  return STATUS_LABELS[status];
}

/**
 * Qué hay que hacer para que se venda. `null` si no hay nada que arreglar.
 *
 * Un estado a secas deja al encargado mirando la palabra "Incompleta" sin saber
 * qué le falta. Esto es la diferencia entre un diagnóstico y un reproche.
 */
const STATUS_HINTS: Partial<Record<PromotionStatus, string>> = {
  disabled: 'Enciéndela para que aparezca en el menú.',
  scheduled: 'Empezará sola en la fecha de inicio.',
  expired: 'Cambia la fecha de vencimiento para volver a publicarla.',
  component_unavailable: 'Uno de sus productos está agotado. Vuelve a activarlo en el menú.',
  incomplete: 'Necesita al menos dos unidades en total.',
  no_savings: 'El precio ya no está por debajo del normal. Bájalo o revisa los productos.',
};

export function statusHint(status: PromotionStatus): string | null {
  return STATUS_HINTS[status] ?? null;
}

// ── Composición ─────────────────────────────────────────────────────────────

/**
 * "2× Soda Peque + 2× Lomito + 2× Porción de papa".
 *
 * Se genera SIEMPRE desde los componentes reales. En la tarjeta se recorta a dos
 * líneas por CSS, pero el texto completo viaja entero para quien lo lea con un
 * lector de pantalla: recortar el dato en origen dejaría a esa persona sin saber
 * qué incluye el combo.
 *
 * El orden es el de los componentes tal como llegan —el del catálogo, por
 * `sort_order`— y no alfabético: así el combo se lee en el mismo orden en que
 * los productos aparecen más abajo en el menú.
 */
export function composeSummary(components: PromotionComponent[]): string {
  return components.map((c) => `${c.quantity}× ${c.name}`).join(' + ');
}

// ── Vigencia ────────────────────────────────────────────────────────────────

/**
 * Etiqueta del vencimiento, en la zona del negocio.
 *
 *   · hoy      → "Termina hoy 23:31"
 *   · mañana   → "Termina mañana 23:31"
 *   · más allá → "Hasta el 06/09"
 *
 * `null` cuando no hay vencimiento, y quien pinta debe OMITIR el elemento en vez
 * de dejar un hueco: una tarjeta con un espacio reservado para algo que no
 * existe se ve rota, no vacía.
 *
 * La comparación es por día de calendario boliviano, no por "faltan menos de 24
 * horas": a las 23:00 de hoy, algo que vence a las 00:30 vence MAÑANA aunque
 * falte hora y media. Es como lo diría una persona.
 */
export function expiryLabel(endsAt: string | null, now: number): string | null {
  if (endsAt === null) return null;
  const fin = Date.parse(endsAt);
  if (Number.isNaN(fin)) return null;

  const diaFin = boliviaDayNumber(fin);
  const diaHoy = boliviaDayNumber(now);

  if (diaFin === diaHoy) return `Termina hoy ${boliviaTime(fin)}`;
  if (diaFin === diaHoy + 1) return `Termina mañana ${boliviaTime(fin)}`;
  return `Hasta el ${boliviaDate(fin)}`;
}

/**
 * Día de calendario boliviano como número entero de días desde la época.
 *
 * Se resta el desfase fijo de Bolivia (UTC−4) en vez de usar `Intl`: el país no
 * tiene horario de verano, así que el desfase es constante y esto no depende de
 * que el entorno traiga la base de datos de zonas horarias. Es el mismo
 * criterio, y la misma constante, que `orders/business-day.ts`.
 */
function boliviaDayNumber(ms: number): number {
  return Math.floor((ms - BOLIVIA_UTC_OFFSET_MS) / 86_400_000);
}

/** "23:31" en hora boliviana. */
function boliviaTime(ms: number): string {
  const d = new Date(ms - BOLIVIA_UTC_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** "06/09" en fecha boliviana. */
function boliviaDate(ms: number): string {
  const d = new Date(ms - BOLIVIA_UTC_OFFSET_MS);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

// ── El formulario del panel escribe en hora del negocio ─────────────────────

/**
 * Un `<input type="datetime-local">` habla la hora LOCAL DEL NAVEGADOR, no la
 * del restaurante. Si el encargado abre el panel desde otro huso —de viaje, o
 * con el celular mal configurado— "hasta las 23:31" significaría otra cosa, y
 * la promoción se apagaría a una hora que nadie eligió.
 *
 * Estas dos funciones fijan la interpretación: lo que se teclea en el
 * formulario ES hora de Bolivia, siempre, y se guarda en UTC. La conversión es
 * explícita y en un solo sitio, que es lo contrario de convertir en silencio.
 */

/** "2026-09-06T23:31" (hora boliviana) → ISO en UTC. `null` si está vacío. */
export function businessLocalToIso(value: string | null): string | null {
  if (value === null) return null;
  const limpio = value.trim();
  if (limpio === '') return null;

  // El formato se COMPRUEBA antes de parsear, y no se delega en `Date.parse`.
  // Ese es laxo hasta lo peligroso: `Date.parse('el viernes:00Z')` no falla —
  // devuelve el 1 de enero del 2000— y una promoción habría quedado vencida
  // desde hace veintiséis años sin que nadie viera un error.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(limpio)) return null;

  // Se lee como si fuera UTC y se SUMA el desfase: las 23:31 bolivianas son las
  // 03:31 UTC del día siguiente.
  const conSegundos = limpio.length === 16 ? `${limpio}:00` : limpio;
  const comoUtc = Date.parse(`${conSegundos}Z`);
  if (Number.isNaN(comoUtc)) return null;
  return new Date(comoUtc + BOLIVIA_UTC_OFFSET_MS).toISOString();
}

/** ISO en UTC → "2026-09-06T23:31" para rellenar el input. */
export function isoToBusinessLocal(iso: string | null): string {
  if (iso === null) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';

  const d = new Date(ms - BOLIVIA_UTC_OFFSET_MS);
  const yyyy = d.getUTCFullYear();
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
}

// ── Imagen ──────────────────────────────────────────────────────────────────

/**
 * Qué componente REPRESENTA al combo.
 *
 * Orden: plato → extra → bebida; a igualdad de categoría, el más caro; y el
 * código como desempate final para que la elección sea determinista.
 *
 * El desempate importa más de lo que parece. Sin él, "2 lomitos goleadores"
 * podía acabar ilustrado con una botella de gaseosa solo porque llegaba primero
 * en el array, y la tarjeta del combo de lomitos mostraba una soda. Con esto, la
 * foto es siempre la del producto que da nombre al combo.
 *
 * Determinista también entre renders: la misma promoción elige el mismo
 * componente en el menú, en el carrito y en cualquier resumen, sin coordinarlos.
 */
const CATEGORY_RANK: Record<MenuCategory, number> = {
  plato: 0,
  extra: 1,
  bebida: 2,
};

export function heroComponent(components: PromotionComponent[]): PromotionComponent | null {
  if (components.length === 0) return null;
  return [...components].sort(compareByProminence)[0];
}

function compareByProminence(a: PromotionComponent, b: PromotionComponent): number {
  const rango = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
  if (rango !== 0) return rango;
  if (a.unitPrice !== b.unitPrice) return b.unitPrice - a.unitPrice;
  return a.code.localeCompare(b.code);
}

/**
 * De dónde sale la foto de la promoción, en orden:
 *
 *   1. su propia `image_url`, si es una URL permitida;
 *   2. la foto del componente protagonista;
 *   3. el placeholder.
 *
 * Devuelve el CÓDIGO del producto del que tomar la foto, no la ruta: quien pinta
 * ya sabe resolver un código con `productImage` del catálogo, y duplicar aquí
 * ese mapa lo dejaría desincronizado en cuanto se añadiera una foto.
 *
 * La MISMA resolución se usa en la tarjeta del menú, en el carrito y en
 * cualquier miniatura. Un placeholder en el carrito para algo que en el menú sí
 * tenía foto parece un error de carga.
 */
export type PromotionImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'component'; code: string; category: MenuCategory }
  | { kind: 'placeholder' };

export function resolvePromotionImage(
  imageUrl: string | null,
  components: PromotionComponent[],
): PromotionImageSource {
  if (isAllowedImageUrl(imageUrl)) return { kind: 'url', url: imageUrl.trim() };

  const hero = heroComponent(components);
  if (hero !== null) return { kind: 'component', code: hero.code, category: hero.category };

  return { kind: 'placeholder' };
}

/**
 * ¿Es una URL de imagen que se puede pintar sin abrir un agujero?
 *
 * Solo rutas propias (`/algo`) o `https://`. Se rechazan `javascript:`, `data:`
 * y `http://` sin cifrar. Es una comprobación de campo, no de red: la URL viene
 * de la base, la escribió una persona del negocio, y aun así no se pinta a
 * ciegas — es exactamente la misma cautela que `isValidProofStorageKey`.
 */
export function isAllowedImageUrl(value: string | null): value is string {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  if (url === '' || url.length > 500) return false;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  return url.startsWith('https://');
}
