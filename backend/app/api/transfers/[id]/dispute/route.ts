import { z } from 'zod';
import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { consumeRateLimit } from '@/lib/rate-limit';

const schema = z.object({ reason: z.string().trim().min(3).max(120), description: z.string().trim().min(10).max(5000) });
const CLOSED = new Set(['PAYMENT_PROCESSING', 'PAYOUT_CONFIRMED', 'COMPLETED', 'REFUNDED', 'REFUND_PROCESSING']);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeRateLimit(`sale-dispute:${user.id}`, 5, 60 * 60 * 1000);
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const { id } = await params;
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${id} FOR UPDATE`;
      const sale = await tx.vehicleSale.findUnique({ where: { id } });
      if (!sale) return { error: 'SALE_NOT_FOUND' as const };
      if (![sale.buyerId, sale.sellerId, sale.payoutUserId].includes(user.id)) return { error: 'FORBIDDEN' as const };
      if (sale.status === 'PAYMENT_PROCESSING') return { error: 'PAYMENT_SETTLEMENT_PENDING' as const };
      if (CLOSED.has(sale.status)) return { error: 'DISPUTE_WINDOW_CLOSED' as const };
      const existing = await tx.dispute.findFirst({ where: { operationId: sale.id, status: { in: ['OPEN', 'UNDER_REVIEW'] } } });
      if (existing) return { error: 'DISPUTE_ALREADY_OPEN' as const };
      const dispute = await tx.dispute.create({ data: { operationId: sale.id, userId: user.id, reason: parsed.data.reason, description: parsed.data.description, payoutFrozen: true, status: 'OPEN' } });
      const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
      await tx.vehicleSale.update({ where: { id: sale.id }, data: { status: 'DISPUTED', statusHistory: [...history, { event: 'DISPUTED', at: new Date().toISOString(), actorId: user.id, disputeId: dispute.id }] } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: user.id, userName: user.fullName, action: 'DISPUTE_OPENED', oldStatus: sale.status, newStatus: 'DISPUTED', metadata: { disputeId: dispute.id, reason: parsed.data.reason } } });
      const recipients = new Set([sale.buyerId, sale.sellerId, sale.payoutUserId].filter((value): value is string => Boolean(value) && value !== user.id));
      for (const recipient of recipients) await tx.notification.create({ data: { userId: recipient, type: 'DISPUTE', title: 'تم فتح نزاع على العملية', message: `تم تجميد الصرف للعملية ${sale.id} حتى مراجعة النزاع.`, priority: 'CRITICAL', operationId: sale.id, data: { disputeId: dispute.id } } });
      return { dispute };
    });
    if ('error' in result) {
      const status = result.error === 'SALE_NOT_FOUND' ? 404 : result.error === 'FORBIDDEN' ? 403 : 409;
      return Response.json({ ok: false, error: result.error }, { status });
    }
    return Response.json({ ok: true, dispute: { id: result.dispute.id, status: result.dispute.status, reason: result.dispute.reason, createdAt: result.dispute.createdAt } }, { status: 201 });
  } catch (error) {
    const message = safeApiErrorCode(error);
    return Response.json({ ok: false, error: message }, { status: message === 'INTERNAL_ERROR' ? 500 : message === 'RATE_LIMITED' ? 429 : 400 });
  }
}
