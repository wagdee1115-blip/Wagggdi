import { getOtpUser, safeApiErrorCode } from '@/lib/api-auth';
import { otpService } from '@/lib/otp';
import { z } from 'zod';
import { db } from '@/lib/db';

const schema = z.object({ otpId: z.string().min(1).max(100), operationId: z.string().min(1).max(200), type: z.enum(['BUYER', 'SELLER']), otp: z.string().regex(/^\d{4}$/) }).strict();

export async function POST(req: Request) {
  try {
    const user = await getOtpUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const registration = parsed.data.operationId === `REGISTRATION:${user.id}` && parsed.data.type === 'BUYER' && user.status === 'PENDING';
    if (!registration) return Response.json({ ok: false, error: 'OTP_OPERATION_FORBIDDEN' }, { status: 403 });
    const result = await otpService.verifyOtp({ ...parsed.data, userId: user.id });
    await db.user.update({ where: { id: user.id }, data: { phoneStatus: 'VERIFIED', status: 'ACTIVE', sessionVersion: { increment: 1 } } });
    return Response.json({ ok: true, verified: result.verified });
  } catch (e) {
    const msg = safeApiErrorCode(e);
    const status = msg === 'INTERNAL_ERROR' ? 500 : msg === 'OTP_REPLAY' ? 409 : msg.includes('ATTEMPTS') || msg === 'OTP_EXPIRED' ? 410 : 400;
    return Response.json({ ok: false, error: msg }, { status });
  }
}
