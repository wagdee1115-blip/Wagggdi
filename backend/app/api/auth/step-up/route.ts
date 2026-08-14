import { cookies } from 'next/headers';
import { z } from 'zod';
import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { signSensitiveJwt } from '@/lib/auth';
import { otpService } from '@/lib/otp';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';

const schema = z.object({
  otpId: z.string().min(1).max(100),
  operationId: z.string().min(1).max(200),
  type: z.literal('SELLER'),
  otp: z.string().regex(/^\d{4}$/),
}).strict();

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeCompositeRateLimit({ scope: 'auth-step-up', limit: 10, windowMs: 10 * 60 * 1000, userId: user.id, ip: getTrustedClientIp(req) });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    if (parsed.data.operationId !== `STEP_UP:${user.id}`) return Response.json({ ok: false, error: 'OTP_OPERATION_FORBIDDEN' }, { status: 403 });
    await otpService.verifyOtp({ ...parsed.data, userId: user.id });
    const token = await signSensitiveJwt({ sub: user.id, role: user.role, sessionVersion: user.sessionVersion });
    (await cookies()).set('markabat_sensitive_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 120,
    });
    return Response.json({ ok: true, expiresInSeconds: 120 }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const code = safeApiErrorCode(error);
    const status = code === 'INTERNAL_ERROR' ? 500 : code === 'RATE_LIMITED' ? 429 : code === 'OTP_REPLAY' ? 409 : code.startsWith('NOT_CONFIGURED') ? 503 : 400;
    return Response.json({ ok: false, error: code }, { status });
  }
}
