import { getCurrentUser, apiError } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { advanceSaleStatus, canRequestSaleStatus } from '@/lib/transfer-workflow';
import { SaleStatus } from '@prisma/client';

const ALLOWED = new Set<SaleStatus>([
  'BUYER_ACCEPTED', 'PAYMENT_PROCESSING', 'PAYMENT_PENDING_VERIFICATION', 'PAYMENT_CONFIRMED', 'ESCROW_HELD',
  'TRANSFER_PENDING', 'TRANSFER_IN_PROGRESS', 'TRANSFER_BLOCKED', 'HANDOVER_PENDING', 'HANDOVER_CONFIRMED',
  'PAYOUT_PROTECTION', 'PAYOUT_PENDING', 'PAYOUT_PROCESSING', 'PAYOUT_CONFIRMED', 'COMPLETED',
  'CANCELLED', 'EXPIRED', 'DISPUTED', 'MANUAL_REVIEW', 'PAYOUT_REVIEW_REQUIRED',
]);

export async function GET(_: Request, { params }: { params: { id: string } }) {
  try {
    const u = await getCurrentUser();
    if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const sale = await db.vehicleSale.findUnique({ where: { id: params.id }, include: { vehicle: true, payments: true, receipts: true, contract: true, auditLogs: true } });
    if (!sale) return Response.json({ ok: false, error: 'SALE_NOT_FOUND' }, { status: 404 });
    if (sale.sellerId !== u.id && sale.payoutUserId !== u.id && sale.buyerId !== u.id && !['ADMIN', 'SUPER_ADMIN', 'OWNER', 'SUPPORT'].includes(u.role)) return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    return Response.json({ ok: true, sale });
  } catch (e) { return apiError(e); }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const u = await getCurrentUser();
    if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const body = await req.json();
    const requested = String(body.status) as SaleStatus;
    if (!ALLOWED.has(requested)) return Response.json({ ok: false, error: 'INVALID_STATUS' }, { status: 400 });
    if (!canRequestSaleStatus(u.role, requested)) return Response.json({ ok: false, error: 'PROVIDER_MANAGED_STATUS' }, { status: 403 });
    const sale = await db.vehicleSale.findUnique({ where: { id: params.id } });
    if (!sale) return Response.json({ ok: false, error: 'SALE_NOT_FOUND' }, { status: 404 });
    if (sale.sellerId !== u.id && sale.payoutUserId !== u.id && sale.buyerId !== u.id && !['ADMIN', 'SUPER_ADMIN', 'OWNER', 'FINANCE', 'VERIFIER'].includes(u.role)) return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    const updated = await advanceSaleStatus(params.id, requested, u.id, body.metadata);
    return Response.json({ ok: true, sale: updated });
  } catch (e) { return apiError(e); }
}
