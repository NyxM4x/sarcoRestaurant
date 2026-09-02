import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { MenuItem } from '@/types';
import { createMenuRepository } from '@/lib/menu';
import { createPromotionsRepository } from '@/lib/promotions/repository';
import type { Promotion } from '@/lib/promotions/promotion';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import { createMenuSessionRepository } from '@/lib/menu/session-repository';
import { hashMenuSessionToken } from '@/lib/menu/session-token';
import { MenuHeader } from '@/components/menu/MenuHeader';
import { MenuStore } from '@/components/menu/MenuStore';
import { ServiceNoticeBanner } from '@/components/menu/ServiceNoticeBanner';

export const metadata: Metadata = {
  title: 'Don Zarco — Menú',
  description: 'Menú de Don Zarco: platos, bebidas y extras. Pide por WhatsApp.',
};

export const viewport: Viewport = {
  themeColor: '#0b3d2e',
};

/**
 * GET /menu — catálogo visual móvil.
 *
 * Server Component: lee los productos activos de Supabase (fuente de verdad de
 * nombres y precios, IDEA.md §3 §9) y los pasa al cliente. Todavía NO crea
 * pedidos ni llama a Kapso: el carrito vive solo en el navegador.
 *
 * Fase 5.2B: valida sesión segura si está presente en ?session=TOKEN.
 * Sin sesión, el menú sigue abierto (acceso público).
 */
export default async function MenuPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Sin esto, Next intentaría prerenderizar el menú en build (precios viejos).
  await connection();

  // El instante con el que se deciden el aviso de horario y la vigencia de cada
  // promoción. Sale del SERVIDOR: el celular del cliente puede tener la hora
  // mal, y una promoción que vence a las 23:31 no puede depender de eso.
  //
  // En el navegador avanza con `useServerClock`, así que una pestaña abierta
  // durante horas no se queda mostrando el pasado.
  // eslint-disable-next-line react-hooks/purity
  const serverNow = Date.now();

  // Validación de sesión (opcional: sin ?session el menú sigue abierto).
  const searchParams = await props.searchParams;
  const sessionToken = typeof searchParams.session === 'string' ? searchParams.session : null;

  let sessionValid = true;
  if (sessionToken) {
    try {
      const tokenHash = hashMenuSessionToken(sessionToken);
      const repo = createMenuSessionRepository(getSupabaseAdmin());
      const session = await repo.findByHash(tokenHash);
      if (!session) {
        sessionValid = false;
      }
    } catch (error) {
      log.error('menu.page.validateSession', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      sessionValid = false;
    }
  }

  // Si hay token pero es inválido o vencido, mostrar error.
  if (sessionToken && !sessionValid) {
    return <MenuSessionExpired />;
  }

  let items: MenuItem[] | null = null;

  try {
    items = await createMenuRepository(getSupabaseAdmin()).listActive();
  } catch (error) {
    // El detalle va al log del servidor; al cliente solo un mensaje amigable.
    log.error('menu.page.listActive', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    items = null;
  }

  // Las promociones se cargan APARTE y su fallo no tumba el menú: sin combos se
  // puede pedir igual, y un catálogo entero caído por una sección opcional
  // sería cambiar un problema pequeño por uno grande.
  let promotions: Promotion[] = [];
  try {
    promotions = await createPromotionsRepository(getSupabaseAdmin()).list();
  } catch (error) {
    log.error('menu.page.listPromotions', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    promotions = [];
  }

  return (
    <main className="flex-1 bg-donzarco-surface text-zinc-900">
      <MenuHeader />
      <ServiceNoticeBanner serverNow={serverNow} />

      {items === null ? (
        <MenuUnavailable
          title="No pudimos cargar el menú"
          body="Estamos teniendo un problema para mostrar los productos. Intenta de nuevo en un momento o escríbenos por WhatsApp."
        />
      ) : items.length === 0 ? (
        <MenuUnavailable
          title="No hay productos disponibles"
          body="Por ahora no tenemos nada cargado en el menú. Escríbenos por WhatsApp y te contamos."
        />
      ) : (
        // El token solo se propaga si la sesión ya quedó validada arriba. Sin
        // sesión va `null`: el menú sigue siendo público, pero no se puede
        // confirmar un pedido. No se registra ni se persiste en ningún sitio.
        <MenuStore
          items={items}
          promotions={promotions}
          serverNow={serverNow}
          sessionToken={sessionToken}
        />
      )}
    </main>
  );
}

/** Sesión expirada o inválida. */
function MenuSessionExpired() {
  return (
    <div className="flex-1 bg-donzarco-surface px-4 py-16">
      <div className="mx-auto max-w-sm rounded-2xl bg-white px-6 py-10 text-center ring-1 ring-zinc-200">
        <span className="text-4xl" aria-hidden>
          ⏱️
        </span>
        <h2 className="mt-4 text-lg font-semibold text-zinc-900">Enlace expirado</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          Este enlace ya no es válido. Vuelve a WhatsApp y solicita nuevamente el menú.
        </p>
      </div>
    </div>
  );
}

/** Estado vacío / de error. Nunca inventa precios ni usa datos de ejemplo. */
function MenuUnavailable({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-16">
      <div className="mx-auto max-w-sm rounded-2xl bg-white px-6 py-10 text-center ring-1 ring-zinc-200">
        <span className="text-4xl" aria-hidden>
          🍔
        </span>
        <h2 className="mt-4 text-lg font-semibold text-zinc-900">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">{body}</p>
      </div>
    </div>
  );
}
