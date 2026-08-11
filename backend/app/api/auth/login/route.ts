import { db } from '@/lib/db';
import { verifyPassword, signJwt } from '@/lib/auth';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';

const schema = z.object({ identifier: z.string().min(3), password: z.string().min(8) });

export async function POST(req: Request) {
  try {
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const ip = req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;
    const deviceId = req.headers.get('x-device-id') ?? undefined;
    const u = await db.user.findUnique({ where: { phone: p.data.identifier } });
    await consumeCompositeRateLimit({ scope: 'login', limit: 20, windowMs: 60_000, ip, deviceId, userId: u?.id });
    if (!u || !(await verifyPassword(p.data.password, u.passwordHash))) return Response.json({ ok: false, error: 'INVALID_CREDENTIALS' }, { status: 401 });
    if (u.status === 'SUSPENDED') return Response.json({ ok: false, error: 'ACCOUNT_SUSPENDED' }, { status: 403 });
    const token = await signJwt({ sub: u.id, role: u.role, sessionVersion: u.sessionVersion });
    cookies().set('markabat_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 30 * 60 });
    return Response.json({ ok: true, user: { id: u.id, fullName: u.fullName, role: u.role, status: u.status, identityStatus: u.identityStatus, phoneStatus: u.phoneStatus } });
  } catch (e) {
    if (e instanceof Error && e.message === 'RATE_LIMITED') return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    return Response.json({ ok: false, error: 'LOGIN_FAILED' }, { status: 500 });
  }
}
