import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { cancelPhoneChange, phoneChangeError } from '@/lib/phone-change';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';

const schema = z.object({ requestId: z.string().uuid() });

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    await consumeCompositeRateLimit({ scope: 'phone-change-cancel', limit: 10, windowMs: 60 * 60 * 1000, userId: user.id, ip: getTrustedClientIp(req) });
    const request = await cancelPhoneChange({ userId: user.id, requestId: parsed.data.requestId });
    return Response.json({ ok: true, request }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const result = phoneChangeError(error);
    return Response.json({ ok: false, error: result.code }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  }
}
