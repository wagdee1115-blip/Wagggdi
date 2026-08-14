import { getCurrentUser, apiError, safeApiErrorCode } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { advanceSaleStatus, canRequestSaleStatus } from '@/lib/transfer-workflow';
import { SaleStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { z } from 'zod';
import { readBoundedRequestText } from '@/lib/request-body';

const ALLOWED = new Set<SaleStatus>([
  'BUYER_ACCEPTED', 'PAYMENT_PROCESSING', 'PAYMENT_PENDING_VERIFICATION', 'PAYMENT_CONFIRMED', 'ESCROW_HELD',
  'TRANSFER_PENDING', 'TRANSFER_IN_PROGRESS', 'TRANSFER_BLOCKED', 'HANDOVER_PENDING', 'HANDOVER_CONFIRMED',
  'PAYOUT_PROTECTION', 'PAYOUT_PENDING', 'PAYOUT_PROCESSING', 'PAYOUT_CONFIRMED', 'COMPLETED',
  'CANCELLED', 'EXPIRED', 'DISPUTED', 'MANUAL_REVIEW', 'PAYOUT_REVIEW_REQUIRED',
]);
const statusUpdateSchema = z.object({ status: z.nativeEnum(SaleStatus) }).strict();

function checkoutUrlFromMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const checkoutUrl = (value as Record<string, unknown>).checkoutUrl;
  if (typeof checkoutUrl !== 'string') return null;
  try {
    const parsed = new URL(checkoutUrl);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const u = await getCurrentUser();
    if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const { id } = await params;
    const sale = await db.vehicleSale.findUnique({ where: { id }, select: {
      id: true, vehicleId: true, status: true, sellerId: true, payoutUserId: true, buyerId: true,
      sellerName: true, buyerName: true, auctionId: true, vehicleAmountYER: true,
      transferFeeUSD: true, platformFeeUSD: true, totalPaidYER: true,
      buyerOtpVerified: true, sellerOtpVerified: true,
      payoutProtectionUntil: true, expiresAt: true, createdAt: true,
      refundReason: true, refundFailureReason: true,
      vehicle: { select: { plateNumber: true, make: true, model: true, year: true, city: true } },
      contract: { select: { id: true, contractNumber: true, status: true } },
      auditLogs: { select: { id: true, action: true, oldStatus: true, newStatus: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
    } });
    if (!sale) return Response.json({ ok: false, error: 'SALE_NOT_FOUND' }, { status: 404 });
    if (sale.sellerId !== u.id && sale.payoutUserId !== u.id && sale.buyerId !== u.id && !['ADMIN', 'SUPER_ADMIN', 'OWNER', 'SUPPORT'].includes(u.role)) return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    const [handoverConsents, paymentRequest, disputes] = await Promise.all([
      db.operation.findMany({ where: { idempotencyKey: { in: [`HANDOVER_CONSENT:${sale.id}:BUYER`, `HANDOVER_CONSENT:${sale.id}:SELLER`] } }, select: { idempotencyKey: true, status: true, updatedAt: true } }),
      sale.buyerId === u.id ? db.operation.findUnique({ where: { idempotencyKey: `PAYMENT:${sale.id}` }, select: { status: true, metadata: true, updatedAt: true } }) : null,
      db.dispute.findMany({ where: { operationId: sale.id }, select: { id: true, status: true, reason: true, createdAt: true, resolvedAt: true }, orderBy: { createdAt: 'desc' } }),
    ]);
    const buyerConsent = handoverConsents.find(item => item.idempotencyKey?.endsWith(':BUYER'));
    const sellerConsent = handoverConsents.find(item => item.idempotencyKey?.endsWith(':SELLER'));
    const handoverQrValue = sale.status === 'HANDOVER_PENDING' && sale.buyerId === u.id
      ? createHash('sha256').update(`${sale.id}|${sale.vehicleId}|HANDOVER`).digest('hex')
      : null;
    const party = sale.buyerId === u.id ? 'BUYER' : sale.sellerId === u.id ? 'SELLER' : sale.payoutUserId === u.id ? 'PAYOUT_OWNER' : 'STAFF';
    const { vehicleId, sellerId, buyerId, payoutUserId, refundFailureReason, ...saleView } = sale;
    void vehicleId; void sellerId; void buyerId; void payoutUserId;
    return Response.json({
      ok: true,
      sale: { ...saleView, refundFailureReason: refundFailureReason ? safeApiErrorCode(new Error(refundFailureReason)) : null },
      viewer: { party },
      handover: { qrValue: handoverQrValue, buyerConsent: buyerConsent?.status === 'SUCCESS', sellerConsent: sellerConsent?.status === 'SUCCESS' },
      paymentRequest: paymentRequest ? { status: paymentRequest.status, checkoutUrl: checkoutUrlFromMetadata(paymentRequest.metadata), updatedAt: paymentRequest.updatedAt } : null,
      disputes,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) { return apiError(e); }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const u = await getCurrentUser();
    if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    let json: unknown;
    try { json = JSON.parse(await readBoundedRequestText(req, 16 * 1024)); }
    catch { return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 }); }
    const parsed = statusUpdateSchema.safeParse(json);
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const requested = parsed.data.status;
    if (!ALLOWED.has(requested)) return Response.json({ ok: false, error: 'INVALID_STATUS' }, { status: 400 });
    if (!canRequestSaleStatus(u.role, requested)) return Response.json({ ok: false, error: 'PROVIDER_MANAGED_STATUS' }, { status: 403 });
    const sale = await db.vehicleSale.findUnique({ where: { id: (await params).id } });
    if (!sale) return Response.json({ ok: false, error: 'SALE_NOT_FOUND' }, { status: 404 });
    if (sale.sellerId !== u.id && sale.payoutUserId !== u.id && sale.buyerId !== u.id && !['ADMIN', 'SUPER_ADMIN', 'OWNER', 'FINANCE', 'VERIFIER'].includes(u.role)) return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    const updated = await advanceSaleStatus((await params).id, requested, u.id);
    return Response.json({ ok: true, sale: { id: updated.id, status: updated.status, updatedAt: updated.updatedAt } });
  } catch (e) { return apiError(e); }
}
