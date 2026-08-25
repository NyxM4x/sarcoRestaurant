/**
 * Handler HTTP del tablero de cocina — dependencias INYECTADAS.
 *
 * Solo lectura, para el polling de la tablet. Exige sesion valida y devuelve
 * una vista minima ya sanitizada. Los errores SIEMPRE se sanitizan: nunca SQL,
 * stack ni detalle interno llega al navegador.
 */
import type { KitchenRepository } from './tickets-repository';

export interface KitchenHandlerDeps {
  /** Verifica la cookie de sesion del request (rol con acceso a cocina). */
  isAuthorized(request: Request): boolean;
  repo: KitchenRepository;
  now(): number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** `GET /api/kitchen/orders` — tickets del dia para el tablero. */
export async function handleKitchenBoardRequest(
  request: Request,
  deps: KitchenHandlerDeps,
): Promise<Response> {
  if (!deps.isAuthorized(request)) return json(401, { error: 'unauthorized' });
  try {
    return json(200, await deps.repo.getBoard(deps.now()));
  } catch {
    return json(500, { error: 'internal_error' });
  }
}
