import { confirmSalePayment, processSaleRefund } from '@/lib/transfer-workflow';
import { notificationService } from '@/lib/notifications';
import { safeApiErrorCode } from '@/lib/api-auth';
import { verifyHexHmac } from '@/lib/webhook-signature';
import { readBoundedRequestText } from '@/lib/request-body';
import { z } from 'zod';

const webhookSchema = z.object({
  status: z.literal('SUCCESS'),
  saleId: z.string().trim().min(1).max(100),
  providerReference: z.string().trim().min(1).max(300),
  idempotencyKey: z.string().trim().min(8).max(200),
  amountYER: z.number().positive().finite().max(1_000_000_000_000),
}).strict();

export async function POST(req: Request) {
  const secret = process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET;
  if (!secret) return Response.json({ ok: false, error: 'NOT_CONFIGURED:PAYMENT_PROVIDER_REQUIRED' }, { status: 503 });
  let raw: string;
  try { raw = await readBoundedRequestText(req); }
  catch { return Response.json({ ok: false, error: 'INVALID_WEBHOOK' }, { status: 413 }); }
  const signature = req.headers.get('x-payment-signature');
  if (!signature) return Response.json({ ok: false, error: 'SIGNATURE_REQUIRED' }, { status: 401 });
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch { return Response.json({ ok: false, error: 'INVALID_WEBHOOK' }, { status: 400 }); }
  const saleId = typeof json === 'object' && json !== null && 'saleId' in json && typeof json.saleId === 'string' && json.saleId.length <= 100 ? json.saleId : null;
  if (!saleId) return Response.json({ ok: false, error: 'INVALID_WEBHOOK' }, { status: 400 });
  // The sale identifier is an explicit part of the MAC domain, preventing a
  // valid callback from being rebound to another sale by an intermediary.
  if (!verifyHexHmac(secret, `${saleId}.${raw}`, signature)) return Response.json({ ok: false, error: 'INVALID_SIGNATURE' }, { status: 401 });
  const parsed = webhookSchema.safeParse(json);
  if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_WEBHOOK' }, { status: 400 });
  const body = parsed.data;
  try {
    const sale = await confirmSalePayment(body.saleId, body.providerReference, body.idempotencyKey, body.amountYER);
    if (['REFUND_PENDING', 'REFUND_FAILED'].includes(sale.status)) {
      await notificationService.sendNotification({ userId: sale.buyerId!, type: 'REFUND', title: 'جارٍ رد دفعة متأخرة', message: `وصلت دفعة العملية ${sale.id} بعد انتهاء المهلة وبدأ ردها تلقائيًا.`, priority: 'CRITICAL', channels: ['IN_APP'], operationId: sale.id });
      try {
        const refunded = await processSaleRefund(sale.id, 'PAYMENT_WEBHOOK');
        return Response.json({ ok: true, saleId: refunded.id, status: refunded.status });
      } catch (refundError) {
        return Response.json({ ok: true, saleId: sale.id, status: 'REFUND_PENDING', refundPending: true, refundError: safeApiErrorCode(refundError) }, { status: 202 });
      }
    }
    await notificationService.sendNotification({userId:sale.sellerId,type:'PAYMENT_CONFIRMED',title:'تم تأكيد الدفع',message:`تم تأكيد الدفع للعملية ${sale.id} وبانتظار تأكيد حجز المبلغ في الضمان.`,priority:'CRITICAL',channels:['IN_APP'],operationId:sale.id});
    return Response.json({ ok: true, saleId: sale.id, status: sale.status });
  } catch (e) {
    return Response.json({ ok: false, error: safeApiErrorCode(e) }, { status: 400 });
  }
}
