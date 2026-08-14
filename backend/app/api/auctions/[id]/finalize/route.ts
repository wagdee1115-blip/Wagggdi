import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { finalizeAuction, settleLosingBidDeposits } from '@/lib/auction';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user || !['OWNER', 'SUPER_ADMIN', 'ADMIN'].includes(user.role)) return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    const auction = await finalizeAuction((await params).id);
    let depositSettlement: { status: string; deposits?: Array<{ id: string; status: string }>; error?: string } | null = null;
    if (auction.status === 'SOLD' || auction.status === 'ENDED') {
      try {
        const deposits = await settleLosingBidDeposits(auction.id, auction.winnerId ?? undefined);
        depositSettlement = { status: 'COMPLETED', deposits: deposits.map(item => ({ id: item.id, status: item.status })) };
      } catch (error) {
        depositSettlement = { status: 'MANUAL_REVIEW_REQUIRED', error: safeApiErrorCode(error) };
      }
    }
    return Response.json({ ok: true, auction: { id: auction.id, status: auction.status, saleId: auction.saleId }, depositSettlement });
  } catch (error) {
    const code = safeApiErrorCode(error);
    const status = code === 'INTERNAL_ERROR' ? 500 : code === 'AUCTION_NOT_FOUND' ? 404 : code === 'AUCTION_NOT_ENDED' ? 409 : code.startsWith('NOT_CONFIGURED') ? 503 : 400;
    return Response.json({ ok: false, error: code }, { status });
  }
}
