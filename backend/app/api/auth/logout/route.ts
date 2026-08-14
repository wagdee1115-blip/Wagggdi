import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { getSessionUser } from '@/lib/api-auth';

export async function POST() {
  let failure = false;
  let revoked = false;
  try {
    const user = await getSessionUser();
    if (user) {
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
        const current = await tx.user.findUnique({ where: { id: user.id }, select: { id: true, sessionVersion: true } });
        if (!current) return;
        const updated = await tx.user.update({ where: { id: current.id }, data: { sessionVersion: { increment: 1 } } });
        await tx.auditLog.create({ data: {
          userId: current.id,
          action: 'ALL_SESSIONS_REVOKED',
          entityType: 'USER',
          entityId: current.id,
          metadata: { previousSessionVersion: current.sessionVersion, newSessionVersion: updated.sessionVersion },
        } });
        await tx.notification.create({ data: {
          userId: current.id,
          type: 'SECURITY_ALERT',
          title: 'تم إلغاء جميع الجلسات',
          message: 'أُلغيت جميع جلسات تسجيل الدخول المرتبطة بحسابك. إذا لم تطلب ذلك فتواصل مع الدعم بعد تأمين كلمة المرور.',
          priority: 'HIGH',
        } });
        revoked = true;
      });
    }
  } catch {
    failure = true;
  }

  const cookieStore = await cookies();
  cookieStore.set('markabat_session', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: new Date(0) });
  cookieStore.set('markabat_sensitive_session', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', expires: new Date(0) });
  if (failure) return Response.json({ ok: false, error: 'SESSION_REVOCATION_FAILED' }, { status: 500 });
  return Response.json({ ok: true, sessionsRevoked: revoked });
}
