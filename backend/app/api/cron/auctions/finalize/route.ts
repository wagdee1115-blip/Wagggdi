import { db } from '@/lib/db';
import { safeApiErrorCode } from '@/lib/api-auth';
import { finalizeAuction, settleLosingBidDeposits } from '@/lib/auction';
export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
  const ended = await db.auction.findMany({ where: { status: 'ACTIVE', endAt: { lte: new Date() } }, select: { id: true }, take: 50 });
  const results = [] as unknown[];
  for (const a of ended) {
    try {
      const auction = await finalizeAuction(a.id);
      let depositSettlement: unknown = null;
      if (auction.status === 'SOLD' || auction.status === 'ENDED') {
        try { depositSettlement = (await settleLosingBidDeposits(auction.id, auction.winnerId ?? undefined)).map(item => ({ id: item.id, status: item.status })); }
        catch (e) { depositSettlement = { status: 'MANUAL_REVIEW_REQUIRED', error: safeApiErrorCode(e) }; }
      }
      results.push({ auction: { id: auction.id, status: auction.status, saleId: auction.saleId }, depositSettlement });
    } catch (e) { results.push({ id: a.id, error: safeApiErrorCode(e) }); }
  }
  return Response.json({ ok: true, count: results.length, results });
}
