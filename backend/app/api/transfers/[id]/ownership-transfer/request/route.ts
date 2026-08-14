import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { requestGovernmentOwnershipTransfer } from '@/lib/sale-provider-requests';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const transfer = await requestGovernmentOwnershipTransfer({ saleId: (await params).id, actorId: user.id });
    return Response.json({ ok: true, transfer: { status: transfer.status, inProgress: transfer.inProgress, replayed: transfer.replayed } }, { status: transfer.inProgress ? 202 : 200 });
  } catch (error) {
    const message = safeApiErrorCode(error);
    const status = message === 'INTERNAL_ERROR' ? 500 : message.startsWith('NOT_CONFIGURED') ? 503 : message === 'FORBIDDEN' ? 403 : message.includes('PROVIDER_') ? 502 : message.endsWith('_NOT_FOUND') ? 404 : 409;
    return Response.json({ ok: false, error: message }, { status });
  }
}
