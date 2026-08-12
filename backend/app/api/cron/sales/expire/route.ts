import { db } from '@/lib/db';
import { forfeitWinningBidDeposit } from '@/lib/auction';

const EXPIRABLE = [
  'SALE_CREATED', 'BUYER_PENDING', 'BUYER_ACCEPTED', 'PAYMENT_PROCESSING', 'PAYMENT_PENDING_VERIFICATION',
  'PENDING_SELLER', 'BUYER_IDENTIFIED', 'WAITING_BUYER_APPROVAL', 'BUYER_APPROVED', 'BUYER_OTP_VERIFIED', 'WAITING_PAYMENT',
] as const;

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
  const now = new Date();
  const candidates = await db.vehicleSale.findMany({ where: { expiresAt: { lte: now }, status: { in: [...EXPIRABLE] } }, select: { id: true }, take: 100 });
  let count = 0;
  for (const candidate of candidates) {
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${candidate.id} FOR UPDATE`;
      const sale = await tx.vehicleSale.findUnique({ where: { id: candidate.id } });
      if (!sale || sale.expiresAt > now || !EXPIRABLE.includes(sale.status as typeof EXPIRABLE[number])) return;
      await tx.vehicleSale.update({ where: { id: sale.id }, data: { status: 'EXPIRED', statusHistory: [...(Array.isArray(sale.statusHistory) ? sale.statusHistory : []), { event: 'EXPIRED', at: now.toISOString(), actorId: 'SYSTEM' }] } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: sale.sellerId, userName: 'SYSTEM', action: 'SALE_EXPIRED', oldStatus: sale.status, newStatus: 'EXPIRED' } });
      await tx.vehicle.updateMany({ where: { id: sale.vehicleId, isReserved: true, status: 'PENDING' }, data: { isReserved: false, status: 'ACTIVE' } });
      count += 1;
      if (sale.auctionId && sale.buyerId && sale.bidDepositYER.gt(0)) {
        try {
          await forfeitWinningBidDeposit(sale.auctionId, sale.buyerId);
        } catch (error) {
          await db.vehicleSale.update({ where: { id: sale.id }, data: { status: 'MANUAL_REVIEW' } });
        }
      }
    });
  }
  return Response.json({ ok: true, count });
}
