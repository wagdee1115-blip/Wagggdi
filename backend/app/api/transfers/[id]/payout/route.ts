import { getCurrentUser, getSensitiveUser, safeApiErrorCode } from '@/lib/api-auth';
import { releasePayout } from '@/lib/transfer-workflow';
import { notificationService } from '@/lib/notifications';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const u = await getCurrentUser();
    if (!u || !['OWNER', 'SUPER_ADMIN', 'FINANCE', 'ADMIN'].includes(u.role)) return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    const sensitive = await getSensitiveUser();
    if (!sensitive || sensitive.id !== u.id) return Response.json({ ok: false, error: 'SENSITIVE_SESSION_REQUIRED' }, { status: 403 });
    const sale = await releasePayout((await params).id, u.id);
    await notificationService.sendNotification({ userId: sale.payoutUserId ?? sale.sellerId, type: 'PAYOUT_CONFIRMED', title: 'تم تأكيد الصرف', message: `تم تأكيد صرف قيمة المركبة للعملية ${sale.id}.`, priority: 'CRITICAL', channels: ['IN_APP'], operationId: sale.id });
    return Response.json({ ok: true, sale: { id: sale.id, status: sale.status, updatedAt: sale.updatedAt } });
  } catch (e) {
    const msg = safeApiErrorCode(e);
    return Response.json({ ok: false, error: msg }, { status: msg === 'INTERNAL_ERROR' ? 500 : msg.startsWith('NOT_CONFIGURED') ? 503 : msg.endsWith('_NOT_FOUND') ? 404 : 400 });
  }
}
