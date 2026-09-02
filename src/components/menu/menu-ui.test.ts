import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Tests de PRESENTACIÓN del menú (Fase 6B.1R). El entorno de test es `node`
 * (sin DOM), así que —igual que en el dashboard— se verifican por lectura del
 * fuente: son barreras contra regresiones visuales/estructurales, no un render.
 * NO tocan la lógica de carrito/checkout ni escriben en ningún sitio.
 */
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const comp = (name: string) => src(`./${name}.tsx`);

const DISPLAY_MONEY = ['ProductCard', 'CartButton', 'CartPanel', 'OrderSuccess', 'CheckoutPanel'];

describe('6B.1R — moneda Bs en la presentación del menú', () => {
  it('los componentes de vitrina usan formatMoney (Bs 45,00), no formatBs', () => {
    for (const c of DISPLAY_MONEY) {
      const s = comp(c);
      expect(s, c).toContain('formatMoney');
      expect(s, c).not.toContain('formatBs');
    }
  });
});

describe('6B.1R — ProductCard', () => {
  it('muestra nombre, precio y acción de agregar', () => {
    const s = comp('ProductCard');
    expect(s).toContain('{item.name}');
    expect(s).toContain('formatMoney(item.price)');
    expect(s).toContain('Agregar');
    expect(s).toContain('aria-label={`Agregar ${item.name} al carrito`}');
  });

  it('controla nombres y descripciones largas con line-clamp', () => {
    const s = comp('ProductCard');
    expect(s).toMatch(/line-clamp-2[^"]*font-semibold/); // nombre
    expect(s).toMatch(/line-clamp-2 text-sm/); // descripción
  });

  it('un producto no disponible no ofrece CTA activo', () => {
    const s = comp('ProductCard');
    expect(s).toContain('item.is_active');
    expect(s).toContain('No disponible');
    // La disponibilidad decide antes que "Agregar"/QuantityControl.
    expect(s).toMatch(/!available\s*\?[\s\S]*No disponible/);
  });
});

describe('6B.1R — ProductImage / fallback', () => {
  it('dibuja un placeholder deliberado (emoji) cuando no hay foto', () => {
    const s = comp('ProductImage');
    expect(s).toContain('image.emoji');
    // Solo se pide una imagen si de verdad hay una. `elegida` es la del
    // catálogo, o la propia de una promoción cuando la trae.
    expect(s).toContain('elegida !== null');
    expect(s).toContain('showPhoto');
  });

  it('queda listo para fotos reales locales vía next/image', () => {
    const s = comp('ProductImage');
    expect(s).toContain("import Image from 'next/image'");
    expect(s).toContain('src={elegida as string}');
    // Accesibilidad: el alt describe LO QUE SE VE. Una promoción pasa su
    // propio nombre, porque la foto es la de su producto principal y decir el
    // nombre del producto describiría mal la tarjeta.
    expect(s).toContain('alt={alt ?? item.name}');
    expect(s).toContain('onError'); // si la foto falla, vuelve al placeholder
  });

  it('la foto propia de una promoción gana a la del catálogo', () => {
    const s = comp('ProductImage');
    expect(s).toContain('src ?? image.src');
  });

  it('atenúa la imagen cuando el producto no está disponible', () => {
    expect(comp('ProductImage')).toContain('grayscale');
  });
});

describe('6B.1R — carrito sticky (CartButton)', () => {
  it('muestra cantidad de productos y total', () => {
    const s = comp('CartButton');
    expect(s).toContain('productos');
    expect(s).toContain('{units}');
    expect(s).toContain('formatMoney(total)');
  });

  it('respeta la safe-area inferior y es fijo al pie', () => {
    const s = comp('CartButton');
    expect(s).toContain('env(safe-area-inset-bottom)');
    expect(s).toContain('fixed inset-x-0 bottom-0');
  });

  it('el catálogo deja espacio para que la barra no tape el último producto', () => {
    // MenuStore mantiene padding inferior generoso en la lista.
    expect(comp('MenuStore')).toMatch(/pb-40|pb-44|pb-48/);
  });
});

describe('6B.1R — safe-area en hojas inferiores', () => {
  it('carrito, checkout y éxito respetan la safe-area', () => {
    for (const c of ['CartPanel', 'CheckoutPanel', 'OrderSuccess']) {
      expect(comp(c), c).toContain('env(safe-area-inset-bottom)');
    }
  });
});

/** Quita comentarios de bloque y de línea para escanear solo lo renderizable. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('6B.1R — header sin datos inventados', () => {
  it('no muestra estado abierto/cerrado, horarios, promos ni descuentos', () => {
    const s = stripComments(comp('MenuHeader'));
    for (const fake of [
      'Recibiendo pedidos',
      'Abierto',
      'Cerrado',
      'horario',
      'descuento',
      'promoción',
      'Promo',
      'minutos',
    ]) {
      expect(s, fake).not.toContain(fake);
    }
    expect(s).toContain('Don Zarco'); // sí conserva la marca
  });
});

describe('6B.1R — categorías reales en la barra', () => {
  it('CategoryTabs se alimenta del catálogo real (sin etiquetas hardcodeadas falsas)', () => {
    const s = comp('CategoryTabs');
    expect(s).toContain('CATEGORY_TABS');
    for (const fake of ['Combos', 'Papas', 'Promos']) {
      expect(s, fake).not.toContain(`>${fake}<`);
    }
  });
});

describe('6B.1R — accesibilidad básica', () => {
  it('los controles de cantidad tienen aria-label en + y −', () => {
    const s = comp('QuantityControl');
    expect(s).toMatch(/Agregar una unidad de|Quitar/);
    expect((s.match(/aria-label=/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('las hojas inferiores son diálogos accesibles', () => {
    for (const c of ['CartPanel', 'CheckoutPanel', 'OrderSuccess']) {
      const s = comp(c);
      expect(s, c).toContain('role="dialog"');
      expect(s, c).toContain('aria-modal="true"');
    }
  });

  it('las pestañas de categoría exponen semántica de tablist', () => {
    const s = comp('CategoryTabs');
    expect(s).toContain('role="tablist"');
    expect(s).toContain('role="tab"');
    expect(s).toContain('aria-selected');
  });
});

describe('6B.1R — checkout: lógica intacta (solo presentación)', () => {
  it('CheckoutPanel sigue siendo controlado por el reducer, sin fetch propio', () => {
    const s = comp('CheckoutPanel');
    // Conserva los campos y acciones del flujo existente.
    for (const field of ['customer_name', 'delivery_type', 'notes']) {
      expect(s, field).toContain(field);
    }
    expect(s).toContain('onSubmit');
    expect(s).toContain('onRetry');
    // No introduce peticiones ni acceso a datos desde la vista.
    expect(s).not.toMatch(/\bfetch\(/);
    expect(s).not.toContain('@/lib/supabase');
    expect(s).not.toContain('submitOrder');
  });

  it('MenuStore mantiene el cableado de envío idempotente existente', () => {
    const s = comp('MenuStore');
    expect(s).toContain('submitOrder');
    expect(s).toContain('checkoutReducer');
    expect(s).toContain('inFlight'); // guarda anti doble envío
  });
});

describe('6B.1R — seguridad: el servidor sigue siendo autoridad de precio', () => {
  it('el cliente solo envía code + quantity (nunca precio)', () => {
    // El carrito arma las líneas para el checkout sin precio.
    expect(comp('MenuStore')).toMatch(/code:\s*line\.product_code,\s*[\r\n\s]*quantity:\s*line\.quantity/);
  });

  it('la orquestación server-side recalcula precios reales desde la base', () => {
    const wc = src('../../lib/orders/web-checkout.ts');
    // El payload hacia la RPC es {code, quantity}: sin precio del cliente.
    expect(wc).toMatch(/p_items_json:\s*Array<\{\s*code:\s*string;\s*quantity:\s*number\s*\}>/);
    // La RPC lee los precios reales y calcula subtotal/total en el servidor.
    expect(wc).toContain('create_order_web');
    expect(wc).toMatch(/precios reales/);
  });

  it('ningún componente del menú expone service_role ni secretos', () => {
    for (const c of [
      'MenuHeader',
      'MenuStore',
      'ProductCard',
      'ProductImage',
      'CartButton',
      'CartPanel',
      'CheckoutPanel',
      'OrderSuccess',
      'CategoryTabs',
      'QuantityControl',
      'SearchBar',
    ]) {
      const s = comp(c);
      expect(s, c).not.toContain('SERVICE_ROLE');
      expect(s, c).not.toContain('@/lib/supabase/server');
      expect(s, c).not.toContain('NEXT_PUBLIC');
    }
  });
});

describe('6B.2A — CartPanel responsive (bottom-sheet móvil / drawer desktop)', () => {
  it('en móvil sigue siendo una hoja inferior', () => {
    const s = comp('CartPanel');
    expect(s).toContain('justify-end'); // anclada abajo
    expect(s).toContain('rounded-t-3xl'); // esquinas superiores redondeadas
    expect(s).toContain('max-h-[85vh]'); // altura de hoja
  });

  it('desde lg: es un drawer lateral derecho de altura completa', () => {
    const s = comp('CartPanel');
    expect(s).toContain('lg:flex-row'); // el contenedor pasa a fila (drawer a la derecha)
    expect(s).toContain('lg:justify-end');
    expect(s).toContain('lg:h-full'); // altura completa
    expect(s).toContain('lg:rounded-l-3xl'); // se redondea solo el lado izquierdo
    expect(s).toContain('lg:max-h-none'); // anula el tope de hoja en desktop
  });

  it('el drawer tiene ancho acotado (~520px) y max-width razonable', () => {
    const s = comp('CartPanel');
    expect(s).toContain('lg:w-[520px]');
    expect(s).toContain('lg:max-w-[92vw]');
  });

  it('el contenido del carrito tiene scroll interno', () => {
    expect(comp('CartPanel')).toMatch(/flex-1[^"]*overflow-y-auto/);
  });
});

describe('6B.2A — catálogo responsive (grid)', () => {
  it('móvil = 1 columna, tablet = 2, desktop amplio = 3', () => {
    const s = comp('MenuStore');
    expect(s).toContain('grid-cols-1');
    expect(s).toContain('sm:grid-cols-2');
    expect(s).toContain('xl:grid-cols-3');
  });

  it('mantiene un ancho máximo razonable centrado', () => {
    expect(comp('MenuStore')).toContain('max-w-5xl');
  });

  it('ProductCard no cambia su lógica (sin fetch ni acceso a datos)', () => {
    const s = comp('ProductCard');
    expect(s).toContain('formatMoney(item.price)');
    expect(s).toContain('item.is_active');
    expect(s).not.toMatch(/\bfetch\(/);
    expect(s).not.toContain('@/lib/supabase');
  });
});

describe('6B.2A — sticky y sesión intactos', () => {
  it('la barra de búsqueda + categorías sigue sticky con fondo propio', () => {
    const s = comp('MenuStore');
    expect(s).toMatch(/sticky top-0[^"]*bg-donzarco-surface/);
    expect(s).toContain('<SearchBar');
    expect(s).toContain('<CategoryTabs');
  });

  it('el CartButton sigue respetando la safe-area inferior', () => {
    expect(comp('CartButton')).toContain('env(safe-area-inset-bottom)');
  });

  it('sin sesión, el checkout continúa bloqueado con el aviso de WhatsApp', () => {
    const s = comp('MenuStore');
    expect(s).toContain('Abre el menú desde WhatsApp');
    expect(s).toContain('canCheckout');
    expect(s).toContain('hasSession');
  });
});
