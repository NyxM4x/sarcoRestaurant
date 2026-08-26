import { handleDetailRequest, type DashboardHandlerDeps } from '@/lib/dashboard/orders-handler';
import { createOrdersRepository } from '@/lib/dashboard/orders-repository';
import { createSupabaseOrdersDataSource } from '@/lib/dashboard/data-source';
import { isRequestAuthorized } from '@/lib/dashboard/auth';
import { createSupabaseProofsDataSource } from '@/lib/dashboard/proofs-data-source';
import { toPaymentView } from '@/lib/dashboard/attempt-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function deps(): DashboardHandlerDeps {
  return {
    isAuthorized: isRequestAuthorized,
    repo: createOrdersRepository(createSupabaseOrdersDataSource()),
    now: () => Date.now(),
    async loadPayment(orderNumber) {
      const rows = await createSupabaseProofsDataSource().getPaymentRows(orderNumber);
      return toPaymentView(rows.attempts, rows.proofs);
    },
  };
}

export async function GET(request: Request): Promise<Response> {
  return handleDetailRequest(request, deps());
}
