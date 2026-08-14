import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { confirmHandover } from '@/lib/transfer-workflow';
import { notificationService } from '@/lib/notifications';
import { consumeRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';

const schema = z.object({
  buyerOtpId: z.string().min(1).optional(), buyerOtp: z.string().regex(/^\d{4}$/).optional(),
  sellerOtpId: z.string().min(1).optional(), sellerOtp: z.string().regex(/^\d{4}$/).optional(),
  qrValue: z.string().length(64).regex(/^[a-f0-9]+$/), mileage: z.number().int().nonnegative().max(10_000_000), photos: z.array(z.string().url().max(2000)).max(20).optional(), notes: z.string().trim().max(2000).optional(),
}).refine(value => {
  const provided = [value.buyerOtpId, value.buyerOtp, value.sellerOtpId, value.sellerOtp].filter(Boolean).length;
  return provided === 0 || provided === 4;
}, { message: 'ALL_HANDOVER_OTP_FIELDS_REQUIRED' });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const u = await getCurrentUser();
    if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeRateLimit(`handover:user:${u.id}`, 10, 60_000);
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const sale = await db.vehicleSale.findUnique({ where: { id: (await params).id } });
    if (!sale || !sale.buyerId) return Response.json({ ok: false, error: 'SALE_NOT_FOUND' }, { status: 404 });
    if (sale.buyerId !== u.id) return Response.json({ ok: false, error: 'BUYER_HANDOVER_CONFIRMATION_REQUIRED' }, { status: 403 });

    // confirmHandover owns the OTP verification/consumption. Do not verify twice here.
    const updated = await confirmHandover({ saleId: sale.id, actorId: u.id, buyerOtpId: p.data.buyerOtpId, buyerOtp: p.data.buyerOtp, sellerOtpId: p.data.sellerOtpId, sellerOtp: p.data.sellerOtp, qrValue: p.data.qrValue, mileage: p.data.mileage, photos: p.data.photos, notes: p.data.notes });
    await notificationService.sendNotification({ userId: sale.payoutUserId ?? sale.sellerId, type: 'PAYOUT_PROTECTION', title: 'بدأت فترة حماية الصرف', message: `تم تأكيد التسليم وبدأت فترة الحماية للعملية ${sale.id}.`, priority: 'HIGH', channels: ['IN_APP'], operationId: sale.id });
    return Response.json({ ok: true, sale: { id: updated.id, status: updated.status, payoutProtectionUntil: updated.payoutProtectionUntil } });
  } catch (e) {
    const message = safeApiErrorCode(e);
    return Response.json({ ok: false, error: message }, { status: message === 'INTERNAL_ERROR' ? 500 : message === 'RATE_LIMITED' ? 429 : message === 'BUYER_HANDOVER_CONFIRMATION_REQUIRED' ? 403 : message.endsWith('_NOT_FOUND') ? 404 : 400 });
  }
}
