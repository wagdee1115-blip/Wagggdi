import { confirmOwnershipTransfer } from '@/lib/transfer-workflow';
import { notificationService } from '@/lib/notifications';
import { issueSaleContract } from '@/lib/contract-pdf-v2';
import { safeApiErrorCode } from '@/lib/api-auth';
import { verifyHexHmac } from '@/lib/webhook-signature';
import { readBoundedRequestText } from '@/lib/request-body';
import { z } from 'zod';

const webhookSchema = z.object({
  saleId: z.string().trim().min(1).max(100),
  providerReference: z.string().trim().min(1).max(300),
}).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const secret = process.env.TRAFFIC_PROVIDER_WEBHOOK_SECRET;
    if (!secret) return Response.json({ ok: false, error: 'NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED' }, { status: 503 });
    let raw: string;
    try { raw = await readBoundedRequestText(req); }
    catch { return Response.json({ ok: false, error: 'INVALID_WEBHOOK' }, { status: 413 }); }
    const signature = req.headers.get('x-traffic-signature');
    if (!signature) return Response.json({ ok: false, error: 'SIGNATURE_REQUIRED' }, { status: 401 });
    const saleId = (await params).id;
    // saleId lives in the URL, so include it explicitly in the signed domain.
    // A callback issued for one sale can no longer be replayed against another path.
    if (!verifyHexHmac(secret, `${saleId}.${raw}`, signature)) return Response.json({ ok: false, error: 'INVALID_SIGNATURE' }, { status: 401 });
    const parsed = webhookSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_WEBHOOK' }, { status: 400 });
    const body = parsed.data;
    if (body.saleId !== saleId) return Response.json({ ok: false, error: 'SALE_ID_MISMATCH' }, { status: 400 });
    const sale = await confirmOwnershipTransfer(saleId, body.providerReference);
    const contract = await issueSaleContract(sale.id, 'TRAFFIC_PROVIDER');
    if (sale.buyerId && !contract.replayed) await notificationService.sendNotification({ userId: sale.buyerId, type: 'OWNERSHIP_TRANSFERRED', title: 'تم نقل الملكية', message: `تم نقل ملكية المركبة للعملية ${sale.id}.`, priority: 'CRITICAL', channels: ['IN_APP'], operationId: sale.id });
    return Response.json({ ok: true, saleId: sale.id, status: sale.status });
  } catch (e) {
    return Response.json({ ok: false, error: safeApiErrorCode(e) }, { status: 400 });
  }
}
