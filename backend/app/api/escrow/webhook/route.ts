import { createHmac, timingSafeEqual } from 'crypto';
import { confirmEscrowHeld } from '@/lib/transfer-workflow';

export async function POST(req: Request) {
  const secret = process.env.ESCROW_PROVIDER_SECRET;
  if (!process.env.ESCROW_PROVIDER_URL || !secret) return Response.json({ ok: false, error: 'NOT_CONFIGURED:ESCROW_PROVIDER_REQUIRED' }, { status: 503 });
  const raw = await req.text();
  const signature = req.headers.get('x-escrow-signature');
  if (!signature) return Response.json({ ok: false, error: 'SIGNATURE_REQUIRED' }, { status: 401 });
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return Response.json({ ok: false, error: 'INVALID_SIGNATURE' }, { status: 401 });
  try {
    const body = JSON.parse(raw) as { status?: string; saleId?: string; escrowProviderReference?: string; paymentProviderReference?: string; amountYER?: number; currency?: string };
    if (body.status !== 'HELD' || !body.saleId || !body.escrowProviderReference || !body.paymentProviderReference || !Number.isFinite(body.amountYER) || !body.currency) return Response.json({ ok: false, error: 'INVALID_ESCROW_WEBHOOK' }, { status: 400 });
    const sale = await confirmEscrowHeld({ saleId: body.saleId, escrowProviderReference: body.escrowProviderReference, paymentProviderReference: body.paymentProviderReference, amountYER: body.amountYER!, currency: body.currency });
    return Response.json({ ok: true, saleId: sale.id, status: sale.status });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'ESCROW_WEBHOOK_FAILED' }, { status: 400 });
  }
}
