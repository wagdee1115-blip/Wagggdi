import { z } from 'zod';
import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { holdAuctionDeposit } from '@/lib/auction-deposit';
import { isIdentityVerified } from '@/lib/identity-policy';

const schema = z.object({ idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) }).strict();

function publicDeposit(deposit: { id: string; status: string; amount: unknown; currency: string; createdAt: Date; updatedAt: Date }) {
  return { id: deposit.id, status: deposit.status, amount: deposit.amount, currency: deposit.currency, createdAt: deposit.createdAt, updatedAt: deposit.updatedAt };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user || user.status !== 'ACTIVE') return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    if (user.phoneStatus !== 'VERIFIED') return Response.json({ ok: false, error: 'PHONE_NOT_VERIFIED' }, { status: 409 });
    if (!isIdentityVerified(user)) return Response.json({ ok: false, error: 'IDENTITY_NOT_VERIFIED' }, { status: 409 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    // The client key is accepted for API compatibility only. Financial
    // idempotency is derived server-side from the auction and authenticated user.
    const result = await holdAuctionDeposit({ auctionId: (await params).id, bidderId: user.id });
    if (result.deposit.status === 'PENDING') return Response.json({ ok: false, error: 'BID_DEPOSIT_RECONCILIATION_PENDING', deposit: publicDeposit(result.deposit) }, { status: 202 });
    return Response.json({ ok: true, deposit: publicDeposit(result.deposit), replayed: result.replayed });
  } catch (error) {
    const message = safeApiErrorCode(error);
    const status = message === 'INTERNAL_ERROR' ? 500 : message === 'AUCTION_NOT_FOUND' ? 404 : message.startsWith('NOT_CONFIGURED') ? 503 : message.includes('PROVIDER') || message === 'BID_DEPOSIT_NOT_HELD' ? 502 : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
