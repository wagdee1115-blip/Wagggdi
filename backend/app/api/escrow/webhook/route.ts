import { confirmEscrowHeld } from '@/lib/transfer-workflow';
import { safeApiErrorCode } from '@/lib/api-auth';
import { verifyHexHmac } from '@/lib/webhook-signature';
import { readBoundedRequestText } from '@/lib/request-body';
import { z } from 'zod';

const webhookSchema = z.object({
  status: z.literal('HELD'),
  saleId: z.string().trim().min(1).max(100),
  escrowProviderReference: z.string().trim().min(1).max(300),
  paymentProviderReference: z.string().trim().min(1).max(300),
  amountYER: z.number().positive().finite().max(1_000_000_000_000),
  currency: z.literal('YER'),
}).strict();

export async function POST(req: Request) {
  const secret = process.env.ESCROW_PROVIDER_SECRET;
  if (!process.env.ESCROW_PROVIDER_URL || !secret) return Response.json({ ok: false, error: 'NOT_CONFIGURED:ESCROW_PROVIDER_REQUIRED' }, { status: 503 });
  let raw: string;
  try { raw = await readBoundedRequestText(req); }
  catch { return Response.json({ ok: false, error: 'INVALID_ESCROW_WEBHOOK' }, { status: 413 }); }
  const signature = req.headers.get('x-escrow-signature');
  if (!signature) return Response.json({ ok: false, error: 'SIGNATURE_REQUIRED' }, { status: 401 });
  if (!verifyHexHmac(secret, raw, signature)) return Response.json({ ok: false, error: 'INVALID_SIGNATURE' }, { status: 401 });
  try {
    const parsed = webhookSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_ESCROW_WEBHOOK' }, { status: 400 });
    const body = parsed.data;
    const sale = await confirmEscrowHeld({ saleId: body.saleId, escrowProviderReference: body.escrowProviderReference, paymentProviderReference: body.paymentProviderReference, amountYER: body.amountYER, currency: body.currency });
    return Response.json({ ok: true, saleId: sale.id, status: sale.status });
  } catch (error) {
    return Response.json({ ok: false, error: safeApiErrorCode(error) }, { status: 400 });
  }
}
