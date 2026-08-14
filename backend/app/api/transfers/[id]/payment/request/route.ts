import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { requestSalePayment } from '@/lib/sale-provider-requests';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const { id } = await params;
    const configuredBase = process.env.APP_BASE_URL?.trim();
    if (process.env.NODE_ENV === 'production' && !configuredBase) throw new Error('NOT_CONFIGURED:APP_BASE_URL_REQUIRED');
    let baseUrl: URL;
    try { baseUrl = new URL(configuredBase || new URL(req.url).origin); } catch { throw new Error('NOT_CONFIGURED:APP_BASE_URL_INVALID'); }
    if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('NOT_CONFIGURED:APP_BASE_URL_INVALID');
    if (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:') throw new Error('NOT_CONFIGURED:APP_BASE_URL_HTTPS_REQUIRED');
    const returnUrl = new URL(`/transfers/${encodeURIComponent(id)}`, baseUrl.origin).toString();
    const payment = await requestSalePayment({ saleId: id, buyerId: user.id, returnUrl });
    return Response.json({ ok: true, payment: { status: payment.status, checkoutUrl: payment.checkoutUrl, inProgress: payment.inProgress, replayed: payment.replayed } }, { status: payment.inProgress ? 202 : 200 });
  } catch (error) {
    const message = safeApiErrorCode(error);
    const status = message === 'INTERNAL_ERROR' ? 500 : message.startsWith('NOT_CONFIGURED') ? 503 : message === 'FORBIDDEN' || message === 'BUYER_PAYMENT_REQUIRED' ? 403 : message.includes('PROVIDER_') ? 502 : message.endsWith('_NOT_FOUND') ? 404 : 409;
    return Response.json({ ok: false, error: message }, { status });
  }
}
