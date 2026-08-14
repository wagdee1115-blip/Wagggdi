import { db } from '@/lib/db';
import { forfeitWinningBidDeposit, settleLosingBidDeposits } from '@/lib/auction';
import { processSaleRefund, queueSaleRefund } from '@/lib/transfer-workflow';
import type { SaleStatus } from '@prisma/client';

const EXPIRABLE: SaleStatus[] = [
  'SALE_CREATED', 'BUYER_PENDING', 'BUYER_ACCEPTED', 'PAYMENT_PROCESSING', 'PAYMENT_PENDING_VERIFICATION',
  'PENDING_SELLER', 'BUYER_IDENTIFIED', 'WAITING_BUYER_APPROVAL', 'BUYER_APPROVED', 'BUYER_OTP_VERIFIED', 'WAITING_PAYMENT',
];

const FUNDED_EXPIRABLE: SaleStatus[] = [
  'PAYMENT_CONFIRMED', 'PAYMENT_VERIFIED', 'FUNDS_SECURED', 'ESCROW_HELD', 'TRANSFER_PENDING', 'TRANSFER_IN_PROGRESS', 'TRANSFER_BLOCKED',
];

const ALL_EXPIRABLE: SaleStatus[] = [...EXPIRABLE, ...FUNDED_EXPIRABLE];

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
  const now = new Date();
  const candidates = await db.vehicleSale.findMany({
    where: { expiresAt: { lte: now }, status: { in: ALL_EXPIRABLE } },
    select: { id: true },
    take: 100,
  });
  const retryRefunds = await db.vehicleSale.findMany({ where: { status: { in: ['REFUND_PENDING', 'REFUND_FAILED'] } }, select: { id: true }, take: 100 });
  let expired = 0;
  let refunded = 0;
  let refundPending = 0;
  let manualReview = 0;

  for (const candidate of candidates) {
    const action = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${candidate.id} FOR UPDATE`;
      const sale = await tx.vehicleSale.findUnique({ where: { id: candidate.id } });
      if (!sale || sale.expiresAt > now || !ALL_EXPIRABLE.includes(sale.status)) return null;

      // A webhook may have marked the sale paid after it was selected. Never
      // convert captured money to a terminal EXPIRED state.
      if (sale.paymentVerified || FUNDED_EXPIRABLE.includes(sale.status)) return { kind: 'REFUND' as const, saleId: sale.id };

      await tx.vehicleSale.update({ where: { id: sale.id }, data: { status: 'EXPIRED', statusHistory: [...(Array.isArray(sale.statusHistory) ? sale.statusHistory : []), { event: 'EXPIRED', at: now.toISOString(), actorId: 'SYSTEM' }] } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: sale.sellerId, userName: 'SYSTEM', action: 'SALE_EXPIRED', oldStatus: sale.status, newStatus: 'EXPIRED' } });
      await tx.vehicle.updateMany({ where: { id: sale.vehicleId, isReserved: true, status: 'PENDING' }, data: { isReserved: false, status: 'ACTIVE' } });
      return { kind: 'EXPIRED' as const, auctionId: sale.auctionId, buyerId: sale.buyerId, hasDeposit: sale.bidDepositYER.gt(0), sellerConfirmed: sale.sellerOtpVerified, saleId: sale.id };
    });

    if (!action) continue;
    if (action.kind === 'REFUND') {
      try {
        await queueSaleRefund(action.saleId, 'SALE_EXPIRED_AFTER_PAYMENT');
        const result = await processSaleRefund(action.saleId);
        if (result.status === 'REFUNDED') refunded += 1;
        else refundPending += 1;
      } catch { refundPending += 1; }
      continue;
    }

    expired += 1;
    // Provider I/O runs after the VehicleSale lock is committed. Calling this
    // from inside the transaction used to deadlock when it updated via `db`.
    if (action.auctionId && action.buyerId && action.hasDeposit) {
      try {
        if (action.sellerConfirmed) await forfeitWinningBidDeposit(action.auctionId, action.buyerId);
        else await settleLosingBidDeposits(action.auctionId);
      }
      catch {
        manualReview += 1;
        await db.vehicleSale.update({ where: { id: action.saleId }, data: { status: 'MANUAL_REVIEW' } });
      }
    }
  }

  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  for (const pending of retryRefunds) {
    if (candidateIds.has(pending.id)) continue;
    try {
      const result = await processSaleRefund(pending.id);
      if (result.status === 'REFUNDED') refunded += 1;
      else refundPending += 1;
    } catch { refundPending += 1; }
  }

  return Response.json({ ok: true, count: expired + refunded, expired, refunded, refundPending, manualReview });
}
