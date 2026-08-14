import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  consumeCompositeRateLimit: vi.fn(),
  inquireAndSyncVehicleViolations: vi.fn(),
  startVehicleViolationPayment: vi.fn(),
  getVehicleRenewalOverview: vi.fn(),
  submitVehicleRegistrationRenewal: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/rate-limit', () => ({ consumeCompositeRateLimit: mocks.consumeCompositeRateLimit }));
vi.mock('@/lib/request-identity', () => ({ getTrustedClientIp: vi.fn(), rateLimitTarget: (value: string) => `hashed:${value}` }));
vi.mock('@/lib/vehicle-compliance', () => ({
  inquireAndSyncVehicleViolations: mocks.inquireAndSyncVehicleViolations,
  startVehicleViolationPayment: mocks.startVehicleViolationPayment,
  getVehicleRenewalOverview: mocks.getVehicleRenewalOverview,
  submitVehicleRegistrationRenewal: mocks.submitVehicleRegistrationRenewal,
  vehicleComplianceApiError: (error: unknown) => {
    const code = error instanceof Error ? error.message : 'VEHICLE_COMPLIANCE_FAILED';
    const status = code === 'UNAUTHORIZED' ? 401 : code === 'RATE_LIMITED' ? 429 : code.endsWith('_NOT_FOUND') ? 404 : 500;
    return Response.json({ ok: false, error: code }, { status, headers: { 'Cache-Control': 'private, no-store' } });
  },
}));

import { GET as getViolations } from '../app/api/vehicles/[id]/violations/route';
import { POST as startPayment } from '../app/api/vehicles/[id]/violations/[violationId]/payment/route';
import { GET as getRenewal, POST as submitRenewal } from '../app/api/vehicles/[id]/registration-renewal/route';

const vehicleContext = { params: Promise.resolve({ id: 'vehicle-1' }) };
const paymentContext = { params: Promise.resolve({ id: 'vehicle-1', violationId: 'violation-1' }) };

describe('vehicle compliance route boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeCompositeRateLimit.mockResolvedValue(undefined);
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1', status: 'ACTIVE' });
  });

  it('rejects unauthenticated inquiries before rate limits or provider work', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await getViolations(new Request('https://markabat.test/api/vehicles/vehicle-1/violations'), vehicleContext);
    expect(response.status).toBe(401);
    expect(mocks.consumeCompositeRateLimit).not.toHaveBeenCalled();
    expect(mocks.inquireAndSyncVehicleViolations).not.toHaveBeenCalled();
  });

  it('returns 429 without calling the provider when the owner limit is exhausted', async () => {
    mocks.consumeCompositeRateLimit.mockRejectedValue(new Error('RATE_LIMITED'));
    const response = await getRenewal(new Request('https://markabat.test/api/vehicles/vehicle-1/registration-renewal'), vehicleContext);
    expect(response.status).toBe(429);
    expect(mocks.getVehicleRenewalOverview).not.toHaveBeenCalled();
  });

  it('passes only the authenticated owner and bound vehicle to the inquiry service', async () => {
    mocks.inquireAndSyncVehicleViolations.mockResolvedValue([{
      id: 'local-violation-1', type: 'SPEEDING', summary: 'تجاوز السرعة', amountYER: 5000,
      status: 'PENDING', issuedAt: new Date('2026-08-01T00:00:00.000Z'), dueAt: null,
    }]);
    const response = await getViolations(new Request('https://markabat.test/api/vehicles/vehicle-1/violations'), vehicleContext);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.inquireAndSyncVehicleViolations).toHaveBeenCalledWith({ userId: 'owner-1', vehicleId: 'vehicle-1' });
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain('externalReference');
    expect(serialized).not.toContain('providerReference');
    expect(serialized).not.toContain('owner-1');
  });

  it('ignores client-supplied payment amount and provider references', async () => {
    mocks.startVehicleViolationPayment.mockResolvedValue({ status: 'PENDING', replayed: false });
    const response = await startPayment(new Request('https://markabat.test/api/vehicles/vehicle-1/violations/violation-1/payment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountYER: 1, externalReference: 'attacker-reference', idempotencyKey: 'attacker-key' }),
    }), paymentContext);
    expect(response.status).toBe(200);
    expect(mocks.startVehicleViolationPayment).toHaveBeenCalledWith({ userId: 'owner-1', vehicleId: 'vehicle-1', violationId: 'violation-1' });
    expect(JSON.stringify(await response.json())).not.toContain('attacker-reference');
  });

  it('conceals a vehicle that is not owned by the authenticated user', async () => {
    mocks.inquireAndSyncVehicleViolations.mockRejectedValue(new Error('VEHICLE_NOT_FOUND'));
    const response = await getViolations(new Request('https://markabat.test/api/vehicles/someone-elses-vehicle/violations'), {
      params: Promise.resolve({ id: 'someone-elses-vehicle' }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'VEHICLE_NOT_FOUND' });
  });

  it('returns a minimal renewal view and accepts a server-idempotent submission', async () => {
    mocks.getVehicleRenewalOverview.mockResolvedValue({
      eligibility: { eligible: true, feesYER: 10_000, currentExpiryDate: new Date('2026-09-01T00:00:00.000Z') },
      request: null,
    });
    const getResponse = await getRenewal(new Request('https://markabat.test/api/vehicles/vehicle-1/registration-renewal'), vehicleContext);
    expect(getResponse.status).toBe(200);
    expect(mocks.getVehicleRenewalOverview).toHaveBeenCalledWith({ userId: 'owner-1', vehicleId: 'vehicle-1' });

    mocks.submitVehicleRegistrationRenewal.mockResolvedValue({ status: 'PENDING_GOVERNMENT', feesYER: 10_000 });
    const postResponse = await submitRenewal(new Request('https://markabat.test/api/vehicles/vehicle-1/registration-renewal', {
      method: 'POST', body: JSON.stringify({ cycleId: 'attacker-cycle', eligibilityReference: 'attacker-token' }),
    }), vehicleContext);
    expect(postResponse.status).toBe(202);
    expect(mocks.submitVehicleRegistrationRenewal).toHaveBeenCalledWith({ userId: 'owner-1', vehicleId: 'vehicle-1' });
    const serialized = JSON.stringify(await postResponse.json());
    expect(serialized).not.toContain('attacker-cycle');
    expect(serialized).not.toContain('attacker-token');
  });
});
