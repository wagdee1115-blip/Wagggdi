import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    vehicle: { findUnique: vi.fn(), findFirst: vi.fn() },
    violation: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    operation: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    provider: { inquiryViolations: vi.fn(), startPayment: vi.fn() },
    renewalProvider: { checkEligibility: vi.fn(), submitRenewal: vi.fn(), getRenewalStatus: vi.fn() },
    transaction,
    db: {
      vehicle: { findFirst: vi.fn() },
      violation: { findFirst: vi.fn() },
      operation: { findFirst: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn(),
    },
  };
});

vi.mock('../lib/db', () => ({ db: mocks.db }));
vi.mock('../lib/violations', async () => {
  const actual = await vi.importActual<typeof import('../lib/violations')>('../lib/violations');
  return { ...actual, getViolationProvider: () => mocks.provider };
});
vi.mock('../lib/renewal', async () => {
  const actual = await vi.importActual<typeof import('../lib/renewal')>('../lib/renewal');
  return { ...actual, getRenewalProvider: () => mocks.renewalProvider };
});

import {
  deriveRenewalCycleDigest,
  getVehicleRenewalOverview,
  inquireAndSyncVehicleViolations,
  startVehicleViolationPayment,
  submitVehicleRegistrationRenewal,
} from '../lib/vehicle-compliance';

const snapshot = {
  externalReference: 'provider-violation-1', type: 'SPEEDING' as const, summary: 'تجاوز السرعة', amountYER: 5000,
  issuedAt: new Date('2026-08-01T10:00:00.000Z'), dueAt: null, status: 'PENDING' as const,
};
const verifiedVehicle = {
  id: 'vehicle-1', ownerId: 'owner-1', plateNumber: '12-3456', vin: 'VIN12345678901234',
  status: 'ACTIVE', isReserved: false, hasLegalBlock: false, governmentStatus: 'VERIFIED',
};

describe('vehicle compliance owner and synchronization service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.$transaction.mockImplementation(async (callback: (tx: typeof mocks.transaction) => unknown) => callback(mocks.transaction));
    mocks.transaction.operation.findUnique.mockResolvedValue(null);
    mocks.transaction.operation.create.mockResolvedValue({ id: 'inquiry-state' });
  });

  it('stops a non-owner before contacting the provider or starting a transaction', async () => {
    mocks.db.vehicle.findFirst.mockResolvedValue(null);
    await expect(inquireAndSyncVehicleViolations({ userId: 'viewer-1', vehicleId: 'vehicle-1' })).rejects.toThrow('VEHICLE_NOT_FOUND');
    expect(mocks.provider.inquiryViolations).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it.each(['UNKNOWN', 'RESTRICTED', 'BLOCKED'])('rejects %s government status before a violation inquiry', async governmentStatus => {
    mocks.db.vehicle.findFirst.mockResolvedValue({ ...verifiedVehicle, governmentStatus });
    await expect(inquireAndSyncVehicleViolations({ userId: 'owner-1', vehicleId: 'vehicle-1' }))
      .rejects.toThrow('VEHICLE_OWNERSHIP_NOT_VERIFIED');
    expect(mocks.provider.inquiryViolations).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it('synchronizes a confirmed provider snapshot and returns only its safe projection', async () => {
    mocks.db.vehicle.findFirst.mockResolvedValue(verifiedVehicle);
    mocks.provider.inquiryViolations.mockResolvedValue({ snapshotSequence: 1, violations: [snapshot] });
    mocks.transaction.vehicle.findUnique.mockResolvedValue(verifiedVehicle);
    mocks.transaction.violation.findMany.mockResolvedValue([]);
    mocks.transaction.violation.create.mockResolvedValue({
      id: 'local-violation-1', vehicleId: 'vehicle-1', userId: 'owner-1', externalReference: snapshot.externalReference,
      type: snapshot.type, description: snapshot.summary, amount: 5000, status: snapshot.status,
      issuedAt: snapshot.issuedAt, dueAt: snapshot.dueAt,
    });
    mocks.transaction.violation.updateMany.mockResolvedValue({ count: 0 });

    const result = await inquireAndSyncVehicleViolations({ userId: 'owner-1', vehicleId: 'vehicle-1' });
    expect(mocks.provider.inquiryViolations).toHaveBeenCalledWith(expect.objectContaining({ vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234' }));
    expect(mocks.transaction.violation.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      vehicleId: 'vehicle-1', userId: 'owner-1', externalReference: snapshot.externalReference,
    }) });
    expect(result).toEqual([{
      id: 'local-violation-1', type: 'SPEEDING', summary: 'تجاوز السرعة', amountYER: 5000,
      status: 'PENDING', issuedAt: snapshot.issuedAt, dueAt: null,
    }]);
    expect(JSON.stringify(result)).not.toContain(snapshot.externalReference);
    expect(JSON.stringify(result)).not.toContain('owner-1');
  });

  it('rejects a provider violation reference already bound to another vehicle', async () => {
    mocks.db.vehicle.findFirst.mockResolvedValue(verifiedVehicle);
    mocks.provider.inquiryViolations.mockResolvedValue({ snapshotSequence: 1, violations: [snapshot] });
    mocks.transaction.vehicle.findUnique.mockResolvedValue(verifiedVehicle);
    mocks.transaction.violation.findMany.mockResolvedValue([{ id: 'existing', vehicleId: 'vehicle-2', externalReference: snapshot.externalReference }]);

    await expect(inquireAndSyncVehicleViolations({ userId: 'owner-1', vehicleId: 'vehicle-1' })).rejects.toThrow('TRAFFIC_PROVIDER_REFERENCE_REPLAY');
    expect(mocks.transaction.violation.create).not.toHaveBeenCalled();
    expect(mocks.transaction.violation.update).not.toHaveBeenCalled();
  });

  it('rejects a stale pending snapshot that conflicts with a locally confirmed payment', async () => {
    mocks.db.vehicle.findFirst.mockResolvedValue(verifiedVehicle);
    mocks.provider.inquiryViolations.mockResolvedValue({ snapshotSequence: 1, violations: [snapshot] });
    mocks.transaction.vehicle.findUnique.mockResolvedValue(verifiedVehicle);
    mocks.transaction.violation.findMany.mockResolvedValue([{
      id: 'local-violation-1', vehicleId: 'vehicle-1', externalReference: snapshot.externalReference, status: 'PAID',
      amount: { eq: (value: number) => value === 5000, toString: () => '5000' },
    }]);
    await expect(inquireAndSyncVehicleViolations({ userId: 'owner-1', vehicleId: 'vehicle-1' })).rejects.toThrow('TRAFFIC_PROVIDER_PAYMENT_STATE_CONFLICT');
    expect(mocks.transaction.violation.update).not.toHaveBeenCalled();
  });

  it.each(['DISPUTED', 'CANCELLED'] as const)('does not let a late PENDING snapshot reopen a %s violation', async status => {
    const existing = {
      id: 'local-violation-1', vehicleId: 'vehicle-1', userId: 'owner-1', externalReference: snapshot.externalReference,
      type: snapshot.type, description: snapshot.summary, amount: 5000, status,
      issuedAt: snapshot.issuedAt, dueAt: snapshot.dueAt,
    };
    mocks.db.vehicle.findFirst.mockResolvedValue(verifiedVehicle);
    mocks.provider.inquiryViolations.mockResolvedValue({ snapshotSequence: 1, violations: [snapshot] });
    mocks.transaction.vehicle.findUnique.mockResolvedValue(verifiedVehicle);
    mocks.transaction.violation.findMany.mockResolvedValue([existing]);
    mocks.transaction.violation.updateMany.mockResolvedValue({ count: 0 });

    const result = await inquireAndSyncVehicleViolations({ userId: 'owner-1', vehicleId: 'vehicle-1' });

    expect(mocks.transaction.violation.update).not.toHaveBeenCalled();
    expect(result[0]).toEqual(expect.objectContaining({ id: existing.id, status }));
  });

  it('ignores an older complete violation snapshot after a newer sequence was stored', async () => {
    const subjectDigest = createHash('sha256').update('vehicle-1|12-3456|VIN12345678901234').digest('hex');
    const current = {
      id: 'local-current', type: 'SPEEDING', description: 'الحالة الأحدث', amount: 5000, status: 'DISPUTED',
      issuedAt: snapshot.issuedAt, dueAt: null,
    };
    mocks.db.vehicle.findFirst.mockResolvedValue(verifiedVehicle);
    mocks.provider.inquiryViolations.mockResolvedValue({ snapshotSequence: 9, violations: [snapshot] });
    mocks.transaction.vehicle.findUnique.mockResolvedValue(verifiedVehicle);
    mocks.transaction.operation.findUnique.mockResolvedValue({
      id: 'inquiry-state', type: 'VIOLATION_INQUIRY_STATE', userId: 'owner-1',
      metadata: { vehicleId: 'vehicle-1', subjectDigest, snapshotSequence: 10, snapshotDigest: 'newer' },
    });
    mocks.transaction.violation.findMany.mockResolvedValue([current]);

    const result = await inquireAndSyncVehicleViolations({ userId: 'owner-1', vehicleId: 'vehicle-1' });

    expect(result).toEqual([expect.objectContaining({ id: 'local-current', status: 'DISPUTED' })]);
    expect(mocks.transaction.violation.update).not.toHaveBeenCalled();
    expect(mocks.transaction.violation.updateMany).not.toHaveBeenCalled();
    expect(mocks.transaction.operation.update).not.toHaveBeenCalled();
  });

  it('does not start payment for a violation outside the owner vehicle boundary', async () => {
    mocks.db.violation.findFirst.mockResolvedValue(null);
    await expect(startVehicleViolationPayment({ userId: 'owner-1', vehicleId: 'vehicle-1', violationId: 'foreign-violation' })).rejects.toThrow('VIOLATION_NOT_FOUND');
    expect(mocks.provider.startPayment).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it.each(['UNKNOWN', 'RESTRICTED', 'BLOCKED'])('rejects %s government status before starting a violation payment', async governmentStatus => {
    mocks.db.violation.findFirst.mockResolvedValue({
      id: 'violation-1', vehicleId: 'vehicle-1', externalReference: 'provider-violation-1', amount: 5000, status: 'PENDING',
      vehicle: { ...verifiedVehicle, governmentStatus },
    });
    await expect(startVehicleViolationPayment({ userId: 'owner-1', vehicleId: 'vehicle-1', violationId: 'violation-1' }))
      .rejects.toThrow('VEHICLE_OWNERSHIP_NOT_VERIFIED');
    expect(mocks.provider.startPayment).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it('binds renewal cycle digests to the complete vehicle identity', () => {
    const first = deriveRenewalCycleDigest('vehicle-1', '12-3456', 'VIN12345678901234', 'cycle-2027');
    const second = deriveRenewalCycleDigest('vehicle-2', '12-3457', 'VIN12345678901235', 'cycle-2027');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
  });

  it('derives renewal idempotency on the server and never persists provider eligibility tokens', async () => {
    const createdAt = new Date('2026-08-14T10:00:00.000Z');
    const operation = {
      id: 'operation-1', operationNumber: 'REN-1', type: 'REGISTRATION_RENEWAL', userId: 'owner-1',
      status: 'PENDING', providerReference: null, idempotencyKey: 'server-key',
      metadata: { vehicleId: 'vehicle-1', feesYER: 10000, providerStatus: 'PENDING_GOVERNMENT' },
      createdAt, updatedAt: createdAt,
    };
    mocks.db.vehicle.findFirst.mockResolvedValue(verifiedVehicle);
    mocks.renewalProvider.checkEligibility.mockResolvedValue({
      eligible: true, feesYER: 10000, currentExpiryDate: new Date('2026-09-01T00:00:00.000Z'),
      cycleId: 'private-cycle', eligibilityReference: 'private-eligibility-token',
    });
    mocks.transaction.vehicle.findFirst.mockResolvedValue(verifiedVehicle);
    mocks.transaction.vehicle.findUnique.mockResolvedValue({ ownerId: 'owner-1' });
    mocks.transaction.operation.findUnique.mockResolvedValue(null);
    mocks.transaction.operation.create.mockResolvedValue(operation);
    mocks.renewalProvider.submitRenewal.mockResolvedValue({
      status: 'PAYMENT_REQUIRED', providerSequence: 1, providerReference: 'private-provider-reference', checkoutUrl: 'https://payments.example.test/renewal',
    });
    mocks.transaction.operation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(operation)
      .mockResolvedValueOnce(null);
    mocks.transaction.operation.update.mockResolvedValue({
      ...operation, providerReference: 'private-provider-reference',
      metadata: { vehicleId: 'vehicle-1', feesYER: 10000, providerStatus: 'PAYMENT_REQUIRED' },
      updatedAt: new Date('2026-08-14T10:01:00.000Z'),
    });

    const result = await submitVehicleRegistrationRenewal({ userId: 'owner-1', vehicleId: 'vehicle-1' });
    expect(mocks.renewalProvider.submitRenewal).toHaveBeenCalledWith(expect.objectContaining({
      vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234',
      eligibility: expect.objectContaining({ eligibilityReference: 'private-eligibility-token' }),
      idempotencyKey: expect.stringMatching(/^REGISTRATION_RENEWAL:[a-f0-9]{64}$/),
    }));
    const createInput = mocks.transaction.operation.create.mock.calls[0][0];
    const updateInput = mocks.transaction.operation.update.mock.calls[0][0];
    expect(JSON.stringify(createInput)).not.toContain('private-cycle');
    expect(JSON.stringify(createInput)).not.toContain('private-eligibility-token');
    expect(JSON.stringify(updateInput)).not.toContain('payments.example.test');
    expect(JSON.stringify(result)).not.toContain('private-provider-reference');
    expect(result).toEqual(expect.objectContaining({ status: 'PAYMENT_REQUIRED', feesYER: 10000, checkoutUrl: 'https://payments.example.test/renewal' }));
  });

  it('creates an isolated renewal operation when retrying a confirmed failed attempt', async () => {
    const createdAt = new Date('2026-08-14T10:00:00.000Z');
    const digest = deriveRenewalCycleDigest(verifiedVehicle.id, verifiedVehicle.plateNumber, verifiedVehicle.vin, 'private-cycle');
    const failedOperation = {
      id: 'failed-operation', operationNumber: 'REN-failed', type: 'REGISTRATION_RENEWAL', userId: 'owner-1',
      status: 'FAILED', providerReference: 'old-provider-reference' as string | null, idempotencyKey: 'base-server-key',
      metadata: { vehicleId: 'vehicle-1', feesYER: 10000, providerStatus: 'FAILED', renewalCycleDigest: digest, attemptNumber: 1 },
      createdAt, updatedAt: createdAt,
    };
    let retryOperation: typeof failedOperation | null = null;
    mocks.db.vehicle.findFirst.mockResolvedValue(verifiedVehicle);
    mocks.renewalProvider.checkEligibility.mockResolvedValue({
      eligible: true, feesYER: 10000, currentExpiryDate: new Date('2026-09-01T00:00:00.000Z'),
      cycleId: 'private-cycle', eligibilityReference: 'private-eligibility-token',
    });
    mocks.transaction.vehicle.findFirst.mockResolvedValue(verifiedVehicle);
    mocks.transaction.vehicle.findUnique.mockResolvedValue({ ownerId: 'owner-1' });
    mocks.transaction.operation.findUnique
      .mockResolvedValueOnce(failedOperation)
      .mockResolvedValueOnce(null);
    mocks.transaction.operation.findFirst
      .mockResolvedValueOnce(failedOperation)
      .mockImplementationOnce(async () => retryOperation)
      .mockImplementationOnce(async () => ({ id: failedOperation.id, metadata: failedOperation.metadata }));
    mocks.transaction.operation.create.mockImplementation(async ({ data }: { data: typeof failedOperation }) => {
      retryOperation = {
        ...data,
        id: 'retry-operation',
        providerReference: null,
        createdAt,
        updatedAt: createdAt,
      };
      return retryOperation;
    });
    mocks.renewalProvider.submitRenewal.mockResolvedValue({
      status: 'PENDING_GOVERNMENT', providerSequence: 1, providerReference: 'new-provider-reference',
    });
    mocks.transaction.operation.update.mockImplementation(async ({ data }: { data: Partial<typeof failedOperation> }) => ({
      ...retryOperation!, ...data, updatedAt: new Date('2026-08-14T10:01:00.000Z'),
    }));

    const result = await submitVehicleRegistrationRenewal({ userId: 'owner-1', vehicleId: 'vehicle-1' });

    const retryCreate = mocks.transaction.operation.create.mock.calls[0][0].data;
    expect(retryCreate.idempotencyKey).toMatch(/:RETRY:2$/);
    expect(retryCreate).not.toHaveProperty('providerReference');
    expect(mocks.transaction.operation.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'failed-operation' } }));
    expect(mocks.renewalProvider.submitRenewal).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: retryCreate.idempotencyKey }));
    expect(result).toEqual(expect.objectContaining({ status: 'PENDING_GOVERNMENT' }));
  });

  it('does not regress a newer renewal state when an older provider sequence arrives late', async () => {
    const createdAt = new Date('2026-08-14T10:00:00.000Z');
    const operation = {
      id: 'operation-1', operationNumber: 'REN-1', type: 'REGISTRATION_RENEWAL', userId: 'owner-1',
      status: 'PENDING', providerReference: 'renewal-ref', idempotencyKey: 'server-key',
      metadata: { vehicleId: 'vehicle-1', feesYER: 10000, providerStatus: 'PAYMENT_REQUIRED', providerSequence: 5, providerResultDigest: 'newer' },
      createdAt, updatedAt: createdAt,
    };
    mocks.db.vehicle.findFirst.mockResolvedValue(verifiedVehicle);
    mocks.db.operation.findFirst.mockResolvedValue(operation);
    mocks.transaction.vehicle.findUnique.mockResolvedValue({ ownerId: 'owner-1' });
    mocks.transaction.operation.findFirst.mockResolvedValue(operation);
    mocks.renewalProvider.getRenewalStatus.mockResolvedValue({ status: 'PENDING_GOVERNMENT', providerSequence: 4, providerReference: 'renewal-ref' });
    mocks.renewalProvider.checkEligibility.mockResolvedValue({ eligible: true, feesYER: 10000, currentExpiryDate: null, cycleId: 'cycle', eligibilityReference: 'eligibility-ref' });

    const result = await getVehicleRenewalOverview({ userId: 'owner-1', vehicleId: 'vehicle-1' });

    expect(result.request).toEqual(expect.objectContaining({ status: 'PAYMENT_REQUIRED' }));
    expect(result.request).not.toHaveProperty('checkoutUrl', expect.any(String));
    expect(mocks.transaction.operation.update).not.toHaveBeenCalled();
  });
});
