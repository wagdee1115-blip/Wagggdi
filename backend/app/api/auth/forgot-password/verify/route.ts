import { z } from 'zod';
import { hashRecoveryToken, verifyPasswordResetOtp } from '@/lib/password-recovery';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';

const schema = z.object({ recoveryToken: z.string().min(40).max(100), otp: z.string().regex(/^\d{4}$/) });

export async function POST(req: Request) {
  try {
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    await consumeCompositeRateLimit({ scope: 'forgot-password-verify', limit: 10, windowMs: 15 * 60 * 1000, ip: getTrustedClientIp(req), deviceId: hashRecoveryToken(p.data.recoveryToken) });
    const result = await verifyPasswordResetOtp(p.data);
    return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'OTP_INVALID_OR_EXPIRED';
    if (message === 'RATE_LIMITED') return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    if (message === 'IDENTITY_VERIFICATION_REQUIRED') return Response.json({ ok: false, error: message }, { status: 403 });
    return Response.json({ ok: false, error: 'OTP_INVALID_OR_EXPIRED' }, { status: 400 });
  }
}
