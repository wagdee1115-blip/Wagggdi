import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { holdAuctionDeposit } from '@/lib/auction-deposit';

const schema = z.object({ idempotencyKey: z.string().min(8) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user || user.status !== 'ACTIVE') return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    // The client key is accepted for API compatibility only. Financial
    // idempotency is derived server-side from the auction and authenticated user.
    const result = await holdAuctionDeposit({ auctionId: (await params).id, bidderId: user.id });
    if (result.deposit.status === 'PENDING') return Response.json({ ok: false, error: 'BID_DEPOSIT_RECONCILIATION_PENDING', deposit: result.deposit }, { status: 202 });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'BID_DEPOSIT_FAILED';
    const status = message === 'AUCTION_NOT_FOUND' ? 404 : message.startsWith('NOT_CONFIGURED') ? 503 : message.includes('PROVIDER') || message === 'BID_DEPOSIT_NOT_HELD' ? 502 : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
