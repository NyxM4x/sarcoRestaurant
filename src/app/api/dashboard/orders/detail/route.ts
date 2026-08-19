import { handleDetailRequest, type DashboardHandlerDeps } from '@/lib/dashboard/orders-handler';
import { createOrdersRepository } from '@/lib/dashboard/orders-repository';
import { createSupabaseOrdersDataSource } from '@/lib/dashboard/data-source';
import { isRequestAuthorized } from '@/lib/dashboard/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function deps(): DashboardHandlerDeps {
  return {
    isAuthorized: isRequestAuthorized,
    repo: createOrdersRepository(createSupabaseOrdersDataSource()),
    now: () => Date.now(),
  };
}

export async function GET(request: Request): Promise<Response> {
  return handleDetailRequest(request, deps());
}
