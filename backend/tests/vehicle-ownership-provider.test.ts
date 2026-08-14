import { describe, expect, it, vi } from 'vitest';
import { TrafficProviderHttpClient } from '../lib/traffic-provider-http';
import {
  deriveVehicleOwnershipVerificationKey,
  HttpVehicleOwnershipProvider,
} from '../lib/vehicle-ownership-verification';

const subject = {
  vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234',
  userId: 'owner-1', nationalId: '1234567890',
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('vehicle ownership provider contract', () => {
  it('binds the complete vehicle and legal owner subject to the provider request and response', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return response({ decision: 'VERIFIED', providerReference: 'government-ref-1', subject });
    });
    const provider = new HttpVehicleOwnershipProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', fetchImpl as typeof fetch));

    await expect(provider.verifyOwnership(subject, 'server-key')).resolves.toEqual({ decision: 'VERIFIED', providerReference: 'government-ref-1', subject });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(sent).toMatchObject({
      action: 'VERIFY_VEHICLE_OWNERSHIP', idempotencyKey: 'server-key',
      vehicle: { id: subject.vehicleId, plateNumber: subject.plateNumber, vin: subject.vin },
      owner: { userId: subject.userId, nationalId: subject.nationalId },
    });
  });

  it.each([
    ['vehicleId', 'vehicle-2'], ['plateNumber', '99-9999'], ['vin', 'VIN99999999999999'],
    ['userId', 'owner-2'], ['nationalId', '9999999999'],
  ] as const)('rejects a provider subject with mismatched %s', async (field, value) => {
    const fetchImpl = vi.fn(async () => response({ decision: 'VERIFIED', providerReference: 'government-ref-1', subject: { ...subject, [field]: value } }));
    const provider = new HttpVehicleOwnershipProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', fetchImpl as typeof fetch));
    await expect(provider.verifyOwnership(subject, 'server-key')).rejects.toThrow('TRAFFIC_PROVIDER_SUBJECT_MISMATCH');
  });

  it('requires a provider reference and a recognized decision', async () => {
    const missingReference = new HttpVehicleOwnershipProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', vi.fn(async () => response({ decision: 'VERIFIED', subject })) as typeof fetch));
    await expect(missingReference.verifyOwnership(subject, 'server-key')).rejects.toThrow('TRAFFIC_PROVIDER_RESPONSE_INVALID');

    const inventedDecision = new HttpVehicleOwnershipProvider(new TrafficProviderHttpClient('https://traffic.example.test/api', 'secret', vi.fn(async () => response({ decision: 'PENDING', providerReference: 'ref', subject })) as typeof fetch));
    await expect(inventedDecision.verifyOwnership(subject, 'server-key')).rejects.toThrow('TRAFFIC_PROVIDER_RESPONSE_INVALID');
  });

  it('derives stable keys from the full subject without embedding PII', () => {
    const key = deriveVehicleOwnershipVerificationKey(subject);
    expect(key).toMatch(/^VEHICLE_OWNERSHIP_VERIFY:[a-f0-9]{64}$/);
    expect(key).not.toContain(subject.nationalId);
    expect(key).not.toContain(subject.vin);
    expect(deriveVehicleOwnershipVerificationKey(subject)).toBe(key);
    expect(deriveVehicleOwnershipVerificationKey({ ...subject, nationalId: '1234567891' })).not.toBe(key);
  });
});
