import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { MenuItem } from '@/types';
import { createMenuRepository } from '@/lib/menu';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { log } from '@/lib/log';
import { createMenuSessionRepository } from '@/lib/menu/session-repository';
import { hashMenuSessionToken } from '@/lib/menu/session-token';
import { MenuHeader } from '@/components/menu/MenuHeader';
import { MenuStore } from '@/components/menu/MenuStore';

export const metadata: Metadata = {
  title: 'La Fija — Menú',
  description: 'Menú de La Fija: hamburguesas, bebidas y extras. Pide por WhatsApp.',
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

  return (
    <main className="flex-1 bg-lafija-surface text-zinc-900">
      <MenuHeader />

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
        <MenuStore items={items} sessionToken={sessionToken} />
      )}
    </main>
  );
}

/** Sesión expirada o inválida. */
function MenuSessionExpired() {
  return (
    <div className="flex-1 bg-lafija-surface px-4 py-16">
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
