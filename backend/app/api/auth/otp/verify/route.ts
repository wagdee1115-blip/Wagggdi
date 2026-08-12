import { getOtpUser } from '@/lib/api-auth';
import { otpService } from '@/lib/otp';
import { z } from 'zod';
import { db } from '@/lib/db';

const schema = z.object({ otpId: z.string().min(1), operationId: z.string().min(1), type: z.enum(['BUYER', 'SELLER']), otp: z.string().regex(/^\d{4}$/) });

export async function POST(req: Request) {
  try {
    const user = await getOtpUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    if (user.status === 'PENDING' && (parsed.data.operationId !== `REGISTRATION:${user.id}` || parsed.data.type !== 'BUYER')) return Response.json({ ok: false, error: 'ONBOARDING_OPERATION_FORBIDDEN' }, { status: 403 });
    const result = await otpService.verifyOtp(parsed.data);
    if (user.status === 'PENDING') await db.user.update({ where: { id: user.id }, data: { phoneStatus: 'VERIFIED', status: 'ACTIVE', sessionVersion: { increment: 1 } } });
    return Response.json({ ok: true, verified: result.verified });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'OTP_VERIFY_FAILED';
    const status = msg === 'OTP_REPLAY' ? 409 : msg.includes('ATTEMPTS') || msg === 'OTP_EXPIRED' ? 410 : 400;
    return Response.json({ ok: false, error: msg }, { status });
  }
}
