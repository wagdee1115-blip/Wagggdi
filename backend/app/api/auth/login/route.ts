import { db } from '@/lib/db';
import { signAuthenticatedJwt, verifyPassword } from '@/lib/auth';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';

const schema = z.object({ identifier: z.string().trim().min(3).max(254), password: z.string().min(8).max(200) });
const DUMMY_PASSWORD_HASH = '$2a$12$jMJODdIfcNs3qOd98FvHkOO/53EYwRrkebHVkQ2XRgG8fjWAa7jOu';

export async function POST(req: Request) {
  try {
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const ip = getTrustedClientIp(req);
    const identifier = p.data.identifier;
    const u = await db.user.findFirst({
      where: {
        OR: [
          { phone: identifier },
          { email: { equals: identifier, mode: 'insensitive' } },
        ],
      },
    });
    await consumeCompositeRateLimit({ scope: 'login', limit: 20, windowMs: 60_000, ip, userId: u?.id, deviceId: `target:${rateLimitTarget(identifier)}` });
    const passwordValid = await verifyPassword(p.data.password, u?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!u || !passwordValid) return Response.json({ ok: false, error: 'INVALID_CREDENTIALS' }, { status: 401 });
    if (u.status !== 'ACTIVE') return Response.json({ ok: false, error: 'ACCOUNT_UNAVAILABLE' }, { status: 403 });
    const token = await signAuthenticatedJwt({ sub: u.id, role: u.role, sessionVersion: u.sessionVersion });
    (await cookies()).set('markabat_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 30 * 60 });
    return Response.json({ ok: true, user: { id: u.id, fullName: u.fullName, role: u.role, status: u.status, identityStatus: u.identityStatus, phoneStatus: u.phoneStatus } });
  } catch (e) {
    if (e instanceof Error && e.message === 'RATE_LIMITED') return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    return Response.json({ ok: false, error: 'LOGIN_FAILED' }, { status: 500 });
  }
}
