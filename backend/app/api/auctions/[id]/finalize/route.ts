import { getCurrentUser } from '@/lib/api-auth';
import { finalizeAuction, settleLosingBidDeposits } from '@/lib/auction';
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user || !['OWNER', 'SUPER_ADMIN', 'ADMIN'].includes(user.role)) return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    const auction = await finalizeAuction((await params).id);
    let depositSettlement: unknown = null;
    if (auction.status === 'SOLD' || auction.status === 'ENDED') {
      try { depositSettlement = await settleLosingBidDeposits(auction.id, auction.winnerId ?? undefined); }
      catch (e) { depositSettlement = { status: 'MANUAL_REVIEW_REQUIRED', error: e instanceof Error ? e.message : 'DEPOSIT_SETTLEMENT_FAILED' }; }
    }
    return Response.json({ ok: true, auction, depositSettlement });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'AUCTION_FINALIZE_FAILED';
    return Response.json({ ok: false, error: msg }, { status: msg === 'AUCTION_NOT_ENDED' ? 409 : 400 });
  }
}
