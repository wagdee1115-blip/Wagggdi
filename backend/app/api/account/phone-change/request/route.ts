import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { beginPhoneChange, phoneChangeError } from '@/lib/phone-change';
import { consumeCompositeRateLimit, consumeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';

const schema = z.object({
  newPhone: z.string().trim().regex(/^\+?[0-9]{9,15}$/),
  currentPassword: z.string().min(8).max(200),
});

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const ip = getTrustedClientIp(req);
    const deviceId = req.headers.get('x-device-id')?.trim() || undefined;
    await consumeCompositeRateLimit({
      scope: 'phone-change-request', limit: 5, windowMs: 60 * 60 * 1000, userId: user.id, ip,
      deviceId: deviceId ? rateLimitTarget(deviceId) : undefined,
    });
    await consumeRateLimit(`phone-change:target:${rateLimitTarget(parsed.data.newPhone)}`, 5, 60 * 60 * 1000);
    const request = await beginPhoneChange({
      userId: user.id,
      expectedSessionVersion: user.sessionVersion,
      currentPassword: parsed.data.currentPassword,
      newPhone: parsed.data.newPhone,
      ip,
      deviceId,
    });
    return Response.json({ ok: true, request }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const result = phoneChangeError(error);
    return Response.json({ ok: false, error: result.code }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  }
}
