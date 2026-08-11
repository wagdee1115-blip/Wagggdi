import { createHmac, timingSafeEqual } from 'crypto';
import { confirmSalePayment } from '@/lib/transfer-workflow';
import { notificationService } from '@/lib/notifications';
import { db } from '@/lib/db';

export async function POST(req: Request) {
  const secret = process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET;
  if (!secret) return Response.json({ ok: false, error: 'NOT_CONFIGURED:PAYMENT_PROVIDER_REQUIRED' }, { status: 503 });
  const raw = await req.text();
  const signature = req.headers.get('x-payment-signature');
  if (!signature) return Response.json({ ok: false, error: 'SIGNATURE_REQUIRED' }, { status: 401 });
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const valid = signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return Response.json({ ok: false, error: 'INVALID_SIGNATURE' }, { status: 401 });
  try {
    const body = JSON.parse(raw) as { saleId?: string; providerReference?: string; idempotencyKey?: string; status?: string; amountYER?: number };
    if (body.status !== 'SUCCESS' || !body.saleId || !body.providerReference || !body.idempotencyKey || !Number.isFinite(body.amountYER)) return Response.json({ ok: false, error: 'INVALID_WEBHOOK' }, { status: 400 });
    const sale = await confirmSalePayment(body.saleId, body.providerReference, body.idempotencyKey, body.amountYER);
    await notificationService.sendNotification({userId:sale.sellerId,type:'PAYMENT_CONFIRMED',title:'تم تأكيد الدفع',message:`تم تأكيد الدفع للعملية ${sale.id} وأصبحت الأموال في حالة Escrow.`,priority:'CRITICAL',channels:['IN_APP'],operationId:sale.id});
    return Response.json({ ok: true, saleId: sale.id, status: sale.status });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'WEBHOOK_FAILED' }, { status: 400 });
  }
}
