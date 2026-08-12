import { createHmac, timingSafeEqual } from 'crypto';
import { confirmOwnershipTransfer } from '@/lib/transfer-workflow';
import { notificationService } from '@/lib/notifications';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const secret = process.env.TRAFFIC_PROVIDER_WEBHOOK_SECRET;
    if (!secret) return Response.json({ ok: false, error: 'NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED' }, { status: 503 });
    const raw = await req.text();
    const signature = req.headers.get('x-traffic-signature');
    if (!signature) return Response.json({ ok: false, error: 'SIGNATURE_REQUIRED' }, { status: 401 });
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const valid = signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) return Response.json({ ok: false, error: 'INVALID_SIGNATURE' }, { status: 401 });
    const body = JSON.parse(raw) as { providerReference?: string };
    if (!body.providerReference) return Response.json({ ok: false, error: 'PROVIDER_REFERENCE_REQUIRED' }, { status: 400 });
    const sale = await confirmOwnershipTransfer(params.id, body.providerReference);
    if (sale.buyerId) await notificationService.sendNotification({ userId: sale.buyerId, type: 'OWNERSHIP_TRANSFERRED', title: 'تم نقل الملكية', message: `تم نقل ملكية المركبة للعملية ${sale.id}.`, priority: 'CRITICAL', channels: ['IN_APP'], operationId: sale.id });
    return Response.json({ ok: true, sale });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'TRANSFER_FAILED' }, { status: 400 });
  }
}
