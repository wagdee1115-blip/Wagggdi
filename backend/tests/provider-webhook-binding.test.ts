import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { POST as paymentWebhook } from '../app/api/payments/webhook/route';
import { POST as trafficWebhook } from '../app/api/transfers/[id]/ownership-transfer/route';
import { verifyHexHmac } from '../lib/webhook-signature';

describe('provider webhook sale binding', () => {
  it('rejects malformed hexadecimal signatures without throwing', () => {
    expect(verifyHexHmac('secret', 'payload', 'z'.repeat(64))).toBe(false);
    expect(verifyHexHmac('secret', 'payload', '00')).toBe(false);
  });

  it('binds payment signatures to the saleId in the signed body', async () => {
    process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET = 'payment-binding-secret';
    const body = JSON.stringify({ status: 'SUCCESS', saleId: 'sale-a', providerReference: 'pay-a', idempotencyKey: 'idem-a', amountYER: 100 });
    const legacySignature = createHmac('sha256', process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET).update(body).digest('hex');
    const rebound = await paymentWebhook(new Request('https://markabat.test/api/payments/webhook', { method: 'POST', headers: { 'x-payment-signature': legacySignature }, body }));
    expect(rebound.status).toBe(401);
  });

  it('rejects a traffic callback replayed against another sale path', async () => {
    process.env.TRAFFIC_PROVIDER_WEBHOOK_SECRET = 'traffic-binding-secret';
    process.env.TRAFFIC_PROVIDER_URL = 'https://traffic.test';
    process.env.TRAFFIC_PROVIDER_SECRET = 'traffic-api-secret';
    const body = JSON.stringify({ providerReference: 'traffic-reference-a' });
    const signatureForSaleA = createHmac('sha256', process.env.TRAFFIC_PROVIDER_WEBHOOK_SECRET).update(`sale-a.${body}`).digest('hex');
    const response = await trafficWebhook(
      new Request('https://markabat.test/api/transfers/sale-b/ownership-transfer', { method: 'POST', headers: { 'x-traffic-signature': signatureForSaleA }, body }),
      { params: Promise.resolve({ id: 'sale-b' }) },
    );
    expect(response.status).toBe(401);
  });

  it('rejects a correctly signed traffic callback whose body names another sale', async () => {
    process.env.TRAFFIC_PROVIDER_WEBHOOK_SECRET = 'traffic-binding-secret';
    const body = JSON.stringify({ saleId: 'sale-a', providerReference: 'traffic-reference-a' });
    const signatureForSaleB = createHmac('sha256', process.env.TRAFFIC_PROVIDER_WEBHOOK_SECRET).update(`sale-b.${body}`).digest('hex');
    const response = await trafficWebhook(
      new Request('https://markabat.test/api/transfers/sale-b/ownership-transfer', { method: 'POST', headers: { 'x-traffic-signature': signatureForSaleB }, body }),
      { params: Promise.resolve({ id: 'sale-b' }) },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'SALE_ID_MISMATCH' });
  });
});
