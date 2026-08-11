import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { otpService } from '@/lib/otp';
import { confirmHandover } from '@/lib/transfer-workflow';
import { notificationService } from '@/lib/notifications';
import { consumeRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';

const schema = z.object({
  buyerOtpId: z.string().min(1), buyerOtp: z.string().regex(/^\d{4}$/),
  sellerOtpId: z.string().min(1), sellerOtp: z.string().regex(/^\d{4}$/),
  qrValue: z.string().min(1), mileage: z.number().int().nonnegative(), photos: z.any().optional(), notes: z.string().max(2000).optional(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const u = await getCurrentUser();
    if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeRateLimit(`handover:user:${u.id}`, 10, 60_000);
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const sale = await db.vehicleSale.findUnique({ where: { id: params.id } });
    if (!sale || !sale.buyerId) return Response.json({ ok: false, error: 'SALE_NOT_FOUND' }, { status: 404 });
    if (![sale.buyerId, sale.sellerId, sale.payoutUserId].includes(u.id)) return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });

    // confirmHandover owns the OTP verification/consumption. Do not verify twice here.
    const updated = await confirmHandover({ saleId: sale.id, actorId: u.id, buyerOtpId: p.data.buyerOtpId, buyerOtp: p.data.buyerOtp, sellerOtpId: p.data.sellerOtpId, sellerOtp: p.data.sellerOtp, qrValue: p.data.qrValue, mileage: p.data.mileage, photos: p.data.photos, notes: p.data.notes });
    await notificationService.sendNotification({ userId: sale.payoutUserId ?? sale.sellerId, type: 'PAYOUT_PROTECTION', title: 'بدأت فترة حماية الصرف', message: `تم تأكيد التسليم وبدأت فترة الحماية للعملية ${sale.id}.`, priority: 'HIGH', channels: ['IN_APP'], operationId: sale.id });
    return Response.json({ ok: true, sale: updated });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'HANDOVER_FAILED';
    return Response.json({ ok: false, error: message }, { status: message === 'RATE_LIMITED' ? 429 : 400 });
  }
}
