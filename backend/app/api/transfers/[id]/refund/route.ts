import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { rbacService, type Role } from '@/lib/rbac';
import { processSaleRefund, queueSaleRefund } from '@/lib/transfer-workflow';
import { z } from 'zod';

const schema = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    if (!rbacService.hasPermission(user.role as Role, 'MANAGE_REFUND')) return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const saleId = (await params).id;
    await queueSaleRefund(saleId, parsed.data.reason, user.id);
    const sale = await processSaleRefund(saleId, user.id);
    return Response.json({ ok: true, sale: { id: sale.id, status: sale.status, refundedAt: sale.refundedAt, updatedAt: sale.updatedAt } });
  } catch (error) {
    const message = safeApiErrorCode(error);
    return Response.json({ ok: false, error: message }, { status: message === 'INTERNAL_ERROR' ? 500 : message.startsWith('NOT_CONFIGURED') ? 503 : message.endsWith('_NOT_FOUND') ? 404 : 400 });
  }
}
