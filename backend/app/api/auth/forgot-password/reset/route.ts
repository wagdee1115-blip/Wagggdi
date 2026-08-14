import { z } from 'zod';
import { verifyJwt } from '@/lib/auth';
import { completePasswordReset } from '@/lib/password-recovery';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';

const schema = z.object({ resetToken: z.string().min(40).max(4096), password: z.string().min(10).max(200) });

export async function POST(req: Request) {
  try {
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const payload = await verifyJwt(p.data.resetToken);
    await consumeCompositeRateLimit({ scope: 'forgot-password-reset', limit: 10, windowMs: 15 * 60 * 1000, ip: getTrustedClientIp(req), userId: payload?.sub ? String(payload.sub) : undefined, deviceId: rateLimitTarget(p.data.resetToken) });
    if (!payload?.sub || payload.purpose !== 'PASSWORD_RESET' || !payload.resetRequestId || !Number.isInteger(payload.sessionVersion)) return Response.json({ ok: false, error: 'RESET_TOKEN_INVALID' }, { status: 401 });
    await completePasswordReset({ resetRequestId: String(payload.resetRequestId), userId: String(payload.sub), expectedSessionVersion: Number(payload.sessionVersion), password: p.data.password });
    return Response.json({ ok: true, message: 'PASSWORD_RESET_COMPLETED' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'PASSWORD_RESET_FAILED';
    if (message === 'RATE_LIMITED') return Response.json({ ok: false, error: message }, { status: 429 });
    if (message === 'RESET_TOKEN_STALE' || message === 'RESET_REQUEST_INVALID') return Response.json({ ok: false, error: message }, { status: 401 });
    return Response.json({ ok: false, error: 'PASSWORD_RESET_FAILED' }, { status: 400 });
  }
}
