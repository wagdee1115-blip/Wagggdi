import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser, apiError } from '@/lib/api-auth';
import { notificationService } from '@/lib/notifications';
import { placeAuctionBid } from '@/lib/auction';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';

const schema = z.object({ amount: z.number().positive() });

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const bids = await db.auctionBid.findMany({ where: { auctionId: (await params).id }, orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }], include: { bidder: { select: { id: true, fullName: true } } }, take: 100 });
    return Response.json({ ok: true, bids });
  } catch (e) { return apiError(e); }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user || user.status !== 'ACTIVE') return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    if (user.phoneStatus !== 'VERIFIED') return Response.json({ ok: false, error: 'PHONE_NOT_VERIFIED' }, { status: 409 });
    await consumeCompositeRateLimit({ scope: 'auction-bid', limit: 60, windowMs: 60_000, userId: user.id, ip: req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined, deviceId: req.headers.get('x-device-id') ?? undefined });
    const idempotencyKey = req.headers.get('Idempotency-Key');
    if (!idempotencyKey) return Response.json({ ok: false, error: 'IDEMPOTENCY_KEY_REQUIRED' }, { status: 400 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });

    const result = await placeAuctionBid({ auctionId: (await params).id, bidderId: user.id, amount: parsed.data.amount, idempotencyKey });
    if (!result.replayed) {
      const auction = result.auction;
      if (auction) {
        await notificationService.sendNotification({
          userId: auction.sellerId,
          type: 'AUCTION_BID', title: 'مزايدة جديدة على مركبتك',
          message: `تمت مزايدة جديدة بقيمة ${parsed.data.amount.toLocaleString('ar-YE')} ريال.`,
          priority: 'HIGH', channels: ['IN_APP'], operationId: auction.id,
          data: { auctionId: auction.id, vehicleId: auction.vehicleId },
        });
      }
    }
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'BID_FAILED';
    const conflict = ['SELLER_CANNOT_BID', 'PHONE_NOT_VERIFIED', 'AUCTION_ENDED', 'VEHICLE_RESTRICTED', 'AUCTION_CONCURRENT_UPDATE', 'BID_DEPOSIT_REQUIRED'].includes(msg);
    if (msg.startsWith('MIN_BID:')) return Response.json({ ok: false, error: 'MINIMUM_BID_NOT_MET', minimum: Number(msg.split(':')[1]) }, { status: 409 });
    if (msg === 'RATE_LIMITED') return Response.json({ ok: false, error: msg }, { status: 429 });
    return Response.json({ ok: false, error: msg }, { status: conflict ? 409 : 400 });
  }
}
