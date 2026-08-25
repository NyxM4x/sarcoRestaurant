import { handleKitchenBoardRequest, type KitchenHandlerDeps } from '@/lib/kitchen/board-handler';
import { createKitchenRepository } from '@/lib/kitchen/tickets-repository';
import { createSupabaseKitchenDataSource } from '@/lib/kitchen/data-source';
import { requestSessionRole } from '@/lib/dashboard/auth';
import { canAccessKitchen } from '@/lib/dashboard/session-role';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function deps(): KitchenHandlerDeps {
  return {
    isAuthorized: (request) => {
      const role = requestSessionRole(request);
      return role !== null && canAccessKitchen(role);
    },
    repo: createKitchenRepository(createSupabaseKitchenDataSource()),
    now: () => Date.now(),
  };
}

export async function GET(request: Request): Promise<Response> {
  return handleKitchenBoardRequest(request, deps());
}
