import { cookies } from 'next/headers';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { db } from '@/lib/db';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';

const schema = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(10).max(200),
});

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });

    await consumeCompositeRateLimit({
      scope: 'change-password',
      limit: 5,
      windowMs: 60 * 60 * 1000,
      userId: user.id,
      ip: getTrustedClientIp(req),
    });

    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
      return Response.json({ ok: false, error: 'CURRENT_PASSWORD_INVALID' }, { status: 400 });
    }
    if (await verifyPassword(parsed.data.newPassword, user.passwordHash)) {
      return Response.json({ ok: false, error: 'NEW_PASSWORD_MUST_DIFFER' }, { status: 400 });
    }

    const passwordHash = await hashPassword(parsed.data.newPassword);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current || current.status !== 'ACTIVE') throw new Error('UNAUTHORIZED');
      if (current.sessionVersion !== user.sessionVersion || current.passwordHash !== user.passwordHash) throw new Error('ACCOUNT_CHANGED_RETRY');

      const updated = await tx.user.update({
        where: { id: current.id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          userId: updated.id,
          action: 'PASSWORD_CHANGED',
          entityType: 'USER',
          entityId: updated.id,
          metadata: {
            sessionVersionInvalidated: true,
            previousSessionVersion: current.sessionVersion,
            newSessionVersion: updated.sessionVersion,
          },
        },
      });
      await tx.notification.create({
        data: {
          userId: updated.id,
          type: 'SECURITY_ALERT',
          title: 'تم تغيير كلمة المرور',
          message: 'تم تغيير كلمة مرور حسابك وإلغاء جميع الجلسات، بما فيها الجلسة الحالية.',
          priority: 'CRITICAL',
        },
      });
    });

    const cookieStore = await cookies();
    cookieStore.set('markabat_session', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: new Date(0) });
    cookieStore.set('markabat_sensitive_session', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', expires: new Date(0) });
    return Response.json({ ok: true, message: 'PASSWORD_CHANGED_AND_SESSIONS_INVALIDATED' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PASSWORD_CHANGE_FAILED';
    const status = message === 'UNAUTHORIZED' ? 401 : message === 'RATE_LIMITED' ? 429 : message === 'ACCOUNT_CHANGED_RETRY' ? 409 : 400;
    const allowed = new Set(['UNAUTHORIZED', 'RATE_LIMITED', 'ACCOUNT_CHANGED_RETRY']);
    return Response.json({ ok: false, error: allowed.has(message) ? message : 'PASSWORD_CHANGE_FAILED' }, { status });
  }
}
