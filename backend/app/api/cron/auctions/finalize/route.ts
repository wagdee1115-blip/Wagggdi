import { db } from '@/lib/db';
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
        try { depositSettlement = await settleLosingBidDeposits(auction.id, auction.winnerId ?? undefined); }
        catch (e) { depositSettlement = { status: 'MANUAL_REVIEW_REQUIRED', error: e instanceof Error ? e.message : 'DEPOSIT_SETTLEMENT_FAILED' }; }
      }
      results.push({ auction, depositSettlement });
    } catch (e) { results.push({ id: a.id, error: e instanceof Error ? e.message : 'FAILED' }); }
  }
  return Response.json({ ok: true, count: results.length, results });
}
