import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveRenewalRequestKey,
  deriveRenewalStatusKey,
  HttpRenewalProvider,
  publicRenewalEligibility,
} from '../lib/renewal';
import { getTrafficProviderHttpClient, TrafficProviderHttpClient } from '../lib/traffic-provider-http';
import {
  deriveViolationPaymentKey,
  HttpViolationProvider,
  publicViolation,
} from '../lib/violations';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('traffic compliance provider boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fails closed without a configured real provider and requires HTTPS in production', () => {
    vi.stubEnv('TRAFFIC_PROVIDER_URL', '');
    vi.stubEnv('TRAFFIC_PROVIDER_SECRET', '');
    expect(() => getTrafficProviderHttpClient()).toThrow('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED');

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRAFFIC_PROVIDER_URL', 'http://traffic.example.test/api');
    vi.stubEnv('TRAFFIC_PROVIDER_SECRET', 'provider-secret');
    expect(() => getTrafficProviderHttpClient()).toThrow('NOT_CONFIGURED:TRAFFIC_PROVIDER_HTTPS_REQUIRED');
  });

  it('binds a violation inquiry to the vehicle and sends a stable idempotency header', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://traffic.example.test/api');
      expect(init?.method).toBe('POST');
      return jsonResponse({
        status: 'CONFIRMED', snapshotComplete: true, snapshotSequence: 7,
        subject: { vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234' },
        violations: [{
          reference: 'external-private-reference', type: 'SPEEDING', summary: '  تجاوز\u0007 السرعة  ',
          amountYER: '5000', issuedAt: '2026-08-01T10:00:00.000Z', dueAt: null, status: 'PENDING',
        }],
      });
    });
    const provider = new HttpViolationProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret-value', fetchImpl as typeof fetch));
    const result = await provider.inquiryViolations({ vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', idempotencyKey: 'inquiry-key' });

    expect(result).toEqual({ snapshotSequence: 7, violations: [expect.objectContaining({ externalReference: 'external-private-reference', summary: 'تجاوز السرعة', amountYER: 5000 })] });
    const [, init] = fetchImpl.mock.calls[0];
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('inquiry-key');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-value');
    const sent = JSON.parse(String(init?.body));
    expect(sent).toMatchObject({ action: 'INQUIRE_VEHICLE_VIOLATIONS', idempotencyKey: 'inquiry-key', vehicle: { id: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234' } });
  });

  it('rejects a provider response for a different vehicle and a mismatched paid amount', async () => {
    const mismatchedInquiry = vi.fn(async () => jsonResponse({ status: 'CONFIRMED', snapshotComplete: true, snapshotSequence: 1, subject: { vehicleId: 'vehicle-2', plateNumber: '12-3456', vin: 'VIN12345678901234' }, violations: [] }));
    const inquiryProvider = new HttpViolationProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', mismatchedInquiry as typeof fetch));
    await expect(inquiryProvider.inquiryViolations({ vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', idempotencyKey: 'key' })).rejects.toThrow('TRAFFIC_PROVIDER_SUBJECT_MISMATCH');

    const wrongAmount = vi.fn(async () => jsonResponse({
      status: 'PAID', subject: { vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', violationReference: 'violation-ref' },
      providerReference: 'payment-ref', paidAmountYER: 4999,
    }));
    const paymentProvider = new HttpViolationProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', wrongAmount as typeof fetch));
    await expect(paymentProvider.startPayment({ vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', externalReference: 'violation-ref', amountYER: 5000, idempotencyKey: 'payment-key' })).rejects.toThrow('TRAFFIC_PROVIDER_AMOUNT_MISMATCH');
  });

  it('rejects partial violation snapshots instead of cancelling unseen records', async () => {
    const partialSnapshot = vi.fn(async () => jsonResponse({
      status: 'CONFIRMED', snapshotComplete: false, snapshotSequence: 1, subject: { vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234' }, violations: [],
    }));
    const provider = new HttpViolationProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', partialSnapshot as typeof fetch));
    await expect(provider.inquiryViolations({ vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', idempotencyKey: 'key' })).rejects.toThrow('TRAFFIC_PROVIDER_RESPONSE_INVALID');
  });

  it('does not expose provider references through the public violation projection', () => {
    const internal = {
      id: 'local-id', externalReference: 'do-not-expose', type: 'SPEEDING', description: 'مخالفة سرعة',
      amount: 5000, status: 'PENDING', issuedAt: new Date('2026-08-01T10:00:00.000Z'), dueAt: null,
    };
    const projection = publicViolation(internal);
    expect(projection).toEqual({
      id: 'local-id', type: 'SPEEDING', summary: 'مخالفة سرعة', amountYER: 5000,
      status: 'PENDING', issuedAt: new Date('2026-08-01T10:00:00.000Z'), dueAt: null,
    });
    expect(JSON.stringify(projection)).not.toContain('do-not-expose');
  });

  it('keeps renewal eligibility tokens private while binding submissions to the provider response', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'CHECK_REGISTRATION_RENEWAL_ELIGIBILITY') return jsonResponse({
        status: 'CONFIRMED', subject: { vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234' }, eligible: true, feesYER: 10_000,
        currentExpiryDate: '2026-09-01T00:00:00.000Z', cycleId: '2027', eligibilityReference: 'private-eligibility-token',
      });
      return jsonResponse({
        status: 'PENDING_GOVERNMENT', providerSequence: 1, subject: { vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234' }, providerReference: 'private-renewal-ref',
      });
    });
    const provider = new HttpRenewalProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', fetchImpl as typeof fetch));
    const eligibility = await provider.checkEligibility({ vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', idempotencyKey: 'eligibility-key' });
    expect(publicRenewalEligibility(eligibility)).toEqual({
      eligible: true, reasonCode: undefined, feesYER: 10_000, currentExpiryDate: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(JSON.stringify(publicRenewalEligibility(eligibility))).not.toContain('private-eligibility-token');
    const result = await provider.submitRenewal({ vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', eligibility, idempotencyKey: 'renewal-key' });
    expect(result.status).toBe('PENDING_GOVERNMENT');
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(secondBody).toMatchObject({ action: 'SUBMIT_REGISTRATION_RENEWAL', eligibilityReference: 'private-eligibility-token', idempotencyKey: 'renewal-key' });
  });

  it('returns a live renewal checkout URL only after validating its production transport', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: 'PAYMENT_REQUIRED', providerSequence: 2, subject: { vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234' }, providerReference: 'renewal-ref',
      checkoutUrl: 'http://payments.example.test/renewal',
    }));
    const provider = new HttpRenewalProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', fetchImpl as typeof fetch));
    await expect(provider.submitRenewal({
      vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', idempotencyKey: 'renewal-key',
      eligibility: { eligible: true, feesYER: 10_000, currentExpiryDate: null, cycleId: '2027', eligibilityReference: 'eligibility-ref' },
    })).rejects.toThrow('TRAFFIC_PROVIDER_RESPONSE_INVALID');

    fetchImpl.mockResolvedValueOnce(jsonResponse({
      status: 'PAYMENT_REQUIRED', providerSequence: 2, subject: { vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234' }, providerReference: 'renewal-ref',
      checkoutUrl: 'https://payments.example.test/renewal',
    }));
    await expect(provider.submitRenewal({
      vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', idempotencyKey: 'renewal-key',
      eligibility: { eligible: true, feesYER: 10_000, currentExpiryDate: null, cycleId: '2027', eligibilityReference: 'eligibility-ref' },
    })).resolves.toEqual({ status: 'PAYMENT_REQUIRED', providerSequence: 2, providerReference: 'renewal-ref', checkoutUrl: 'https://payments.example.test/renewal' });
  });

  it('requires monotonic sequence fields on government state responses', async () => {
    const inquiry = new HttpViolationProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', vi.fn(async () => jsonResponse({
      status: 'CONFIRMED', snapshotComplete: true,
      subject: { vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234' }, violations: [],
    })) as typeof fetch));
    await expect(inquiry.inquiryViolations({ vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', idempotencyKey: 'key' }))
      .rejects.toThrow('TRAFFIC_PROVIDER_RESPONSE_INVALID');

    const renewal = new HttpRenewalProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', vi.fn(async () => jsonResponse({
      status: 'PENDING_GOVERNMENT', providerReference: 'renewal-ref',
      subject: { vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234' },
    })) as typeof fetch));
    await expect(renewal.getRenewalStatus({ vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', providerReference: 'renewal-ref', idempotencyKey: 'key' }))
      .rejects.toThrow('TRAFFIC_PROVIDER_RESPONSE_INVALID');
  });

  it('derives stable context-bound operation keys', () => {
    expect(deriveViolationPaymentKey('vehicle-1', 'violation-1', 'user-1', 'ref-1', 5000)).toBe(deriveViolationPaymentKey('vehicle-1', 'violation-1', 'user-1', 'ref-1', 5000));
    expect(deriveViolationPaymentKey('vehicle-1', 'violation-1', 'user-1', 'ref-1', 5000)).not.toBe(deriveViolationPaymentKey('vehicle-1', 'violation-1', 'user-2', 'ref-1', 5000));
    expect(deriveRenewalRequestKey('vehicle-1', '12-3456', 'VIN12345678901234', '2027')).toBe(deriveRenewalRequestKey('vehicle-1', '12-3456', 'VIN12345678901234', '2027'));
    expect(deriveRenewalRequestKey('vehicle-1', '12-3456', 'VIN12345678901234', '2027')).not.toBe(deriveRenewalRequestKey('vehicle-1', '12-3456', 'VIN12345678901234', '2028'));
    expect(deriveRenewalStatusKey('operation-1', 'provider-ref', new Date('2026-08-14T10:00:00.000Z'))).not.toBe(deriveRenewalStatusKey('operation-1', 'provider-ref', new Date('2026-08-14T10:01:00.000Z')));
  });
});
