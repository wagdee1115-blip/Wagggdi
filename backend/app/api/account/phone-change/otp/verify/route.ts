import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { phoneChangeError, verifyPhoneChangeOtp } from '@/lib/phone-change';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';

const schema = z.object({ requestId: z.string().uuid(), otp: z.string().regex(/^\d{6}$/) });

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const deviceId = req.headers.get('x-device-id')?.trim() || undefined;
    await consumeCompositeRateLimit({
      scope: 'phone-change-verify', limit: 10, windowMs: 15 * 60 * 1000, userId: user.id,
      ip: getTrustedClientIp(req), deviceId: deviceId ? rateLimitTarget(deviceId) : undefined,
    });
    const request = await verifyPhoneChangeOtp({ userId: user.id, requestId: parsed.data.requestId, otp: parsed.data.otp });
    return Response.json({ ok: true, request }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const result = phoneChangeError(error);
    return Response.json({ ok: false, error: result.code }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  }
}
