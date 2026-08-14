import { db } from '@/lib/db';
import { getCurrentUser, apiError } from '@/lib/api-auth';

const auctionSelect = {
  id: true,
  startingPrice: true,
  currentPrice: true,
  minimumIncrement: true,
  bidDepositAmount: true,
  bidDepositCurrency: true,
  startAt: true,
  endAt: true,
  status: true,
  createdAt: true,
  vehicle: { select: { make: true, model: true, year: true, price: true, mileage: true, transmission: true, fuelType: true, color: true, city: true } },
} as const;

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [user, auction] = await Promise.all([
      getCurrentUser(),
      db.auction.findUnique({ where: { id }, select: { ...auctionSelect, sellerId: true, winnerId: true, saleId: true } }),
    ]);
    if (!auction) return Response.json({ ok: false, error: 'AUCTION_NOT_FOUND' }, { status: 404 });
    const bids = await db.auctionBid.findMany({ where: { auctionId: id }, select: { id: true, amount: true, createdAt: true }, orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }], take: 100 });
    let participation: null | Record<string, unknown> = null;
    if (user) {
      const [myBids, autoBid, deposit] = await Promise.all([
        db.auctionBid.findMany({ where: { auctionId: id, bidderId: user.id }, select: { id: true, amount: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
        db.auctionAutoBid.findUnique({ where: { auctionId_bidderId: { auctionId: id, bidderId: user.id } }, select: { maxAmount: true, isActive: true } }),
        db.auctionBidDeposit.findUnique({ where: { auctionId_bidderId: { auctionId: id, bidderId: user.id } }, select: { status: true, amount: true, currency: true } }),
      ]);
      participation = {
        authenticated: true,
        isSeller: auction.sellerId === user.id,
        isWinner: auction.winnerId === user.id,
        saleId: auction.sellerId === user.id || auction.winnerId === user.id ? auction.saleId : null,
        myBids,
        autoBid,
        deposit,
      };
    }
    const publicAuction = { ...auction, sellerId: undefined, winnerId: undefined, saleId: undefined };
    const now = new Date();
    const phase = auction.status === 'ACTIVE' && auction.startAt > now ? 'UPCOMING'
      : auction.status === 'ACTIVE' && auction.endAt > now ? 'LIVE'
        : 'ENDED';
    return Response.json({ ok: true, auction: { ...publicAuction, phase }, bids: bids.map(bid => ({ ...bid, bidderName: 'مزايد مجهول' })), participation }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const body = await req.json();
    if (body.action !== 'CANCEL') return Response.json({ ok: false, error: 'INVALID_ACTION' }, { status: 400 });
    const { id } = await params;
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Auction" WHERE id = ${id} FOR UPDATE`;
      const auction = await tx.auction.findUnique({ where: { id }, select: { id: true, sellerId: true, vehicleId: true, status: true, startAt: true, _count: { select: { bids: true } } } });
      if (!auction) return 'NOT_FOUND' as const;
      if (auction.sellerId !== user.id && !['ADMIN', 'SUPER_ADMIN', 'OWNER'].includes(user.role)) return 'FORBIDDEN' as const;
      if (auction.status === 'CANCELLED') return auction;
      if (auction.status !== 'ACTIVE' || auction.startAt <= new Date() || auction._count.bids > 0) return 'CANNOT_CANCEL' as const;
      await tx.auction.update({ where: { id }, data: { status: 'CANCELLED' } });
      await tx.vehicle.updateMany({ where: { id: auction.vehicleId, isReserved: true, status: 'ACTIVE' }, data: { isReserved: false } });
      return auction;
    });
    if (result === 'NOT_FOUND') return Response.json({ ok: false, error: 'AUCTION_NOT_FOUND' }, { status: 404 });
    if (result === 'FORBIDDEN') return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    if (result === 'CANNOT_CANCEL') return Response.json({ ok: false, error: 'AUCTION_CANNOT_BE_CANCELLED' }, { status: 409 });
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
