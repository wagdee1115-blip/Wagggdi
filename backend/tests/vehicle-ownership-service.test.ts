import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    vehicle: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    operation: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    vehicleOwnership: { updateMany: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    db: {
      $transaction: vi.fn(),
      operation: { updateMany: vi.fn() },
    },
  };
});

vi.mock('../lib/db', () => ({ db: mocks.db }));

import {
  deriveVehicleOwnershipVerificationKey,
  verifyVehicleOwnership,
  type VehicleOwnershipProvider,
} from '../lib/vehicle-ownership-verification';

const owner = { id: 'owner-1', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED', nationalId: '1234567890' };
const subject = { vehicleId: 'vehicle-1', plateNumber: '12-3456', vin: 'VIN12345678901234', userId: owner.id, nationalId: owner.nationalId };
const vehicle = {
  id: subject.vehicleId, ownerId: owner.id, plateNumber: subject.plateNumber, vin: subject.vin,
  status: 'DRAFT', isReserved: false, governmentStatus: 'UNKNOWN', owner,
};
const operation = {
  id: 'operation-1', operationNumber: 'VOV-1', type: 'VEHICLE_OWNERSHIP_VERIFICATION', userId: owner.id,
  status: 'PENDING', providerReference: null, idempotencyKey: deriveVehicleOwnershipVerificationKey(subject),
  metadata: { vehicleId: vehicle.id, subjectDigest: deriveVehicleOwnershipVerificationKey(subject).split(':')[1], providerDecision: 'PENDING' },
  createdAt: new Date('2026-08-14T10:00:00.000Z'), updatedAt: new Date('2026-08-14T10:00:00.000Z'),
};

function provider(result: { decision: 'VERIFIED' | 'REJECTED'; providerReference: string } = { decision: 'VERIFIED', providerReference: 'government-ref-1' }) {
  return { verifyOwnership: vi.fn(async () => ({ ...result, subject })) } satisfies VehicleOwnershipProvider;
}

describe('vehicle ownership verification service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.db.$transaction.mockImplementation(async (callback: (tx: typeof mocks.tx) => unknown) => callback(mocks.tx));
    mocks.tx.vehicle.findUnique.mockResolvedValueOnce(vehicle).mockResolvedValueOnce({ ...vehicle, owner: undefined });
    mocks.tx.user.findUnique.mockResolvedValue(owner);
    mocks.tx.operation.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(operation);
    mocks.tx.operation.findFirst.mockResolvedValue(null);
    mocks.tx.operation.create.mockResolvedValue(operation);
    mocks.tx.operation.update.mockResolvedValue(operation);
    mocks.tx.vehicle.update.mockResolvedValue({ ...vehicle, status: 'ACTIVE', governmentStatus: 'VERIFIED' });
  });

  it('stops a non-owner before a provider operation is claimed', async () => {
    mocks.tx.vehicle.findUnique.mockReset().mockResolvedValue(null);
    const boundary = provider();
    await expect(verifyVehicleOwnership({ userId: 'attacker', vehicleId: vehicle.id, provider: boundary })).rejects.toThrow('VEHICLE_NOT_FOUND');
    expect(boundary.verifyOwnership).not.toHaveBeenCalled();
    expect(mocks.tx.operation.create).not.toHaveBeenCalled();
  });

  it('requires a verified national identity before contacting the vehicle provider', async () => {
    mocks.tx.vehicle.findUnique.mockReset().mockResolvedValue({ ...vehicle, owner: { ...owner, identityStatus: 'UNVERIFIED' } });
    const boundary = provider();
    await expect(verifyVehicleOwnership({ userId: owner.id, vehicleId: vehicle.id, provider: boundary })).rejects.toThrow('IDENTITY_NOT_VERIFIED');
    expect(boundary.verifyOwnership).not.toHaveBeenCalled();
  });

  it('requires a verified phone before contacting the vehicle provider', async () => {
    mocks.tx.vehicle.findUnique.mockReset().mockResolvedValue({ ...vehicle, owner: { ...owner, phoneStatus: 'PENDING' } });
    const boundary = provider();
    await expect(verifyVehicleOwnership({ userId: owner.id, vehicleId: vehicle.id, provider: boundary })).rejects.toThrow('PHONE_NOT_VERIFIED');
    expect(boundary.verifyOwnership).not.toHaveBeenCalled();
    expect(mocks.tx.operation.create).not.toHaveBeenCalled();
  });

  it('activates only after a strictly bound VERIFIED decision and keeps PII out of the public result and metadata', async () => {
    const boundary = provider();
    const result = await verifyVehicleOwnership({ userId: owner.id, vehicleId: vehicle.id, provider: boundary });

    expect(boundary.verifyOwnership).toHaveBeenCalledWith(subject, operation.idempotencyKey);
    expect(mocks.tx.vehicle.update).toHaveBeenCalledWith({ where: { id: vehicle.id }, data: { status: 'ACTIVE', governmentStatus: 'VERIFIED' } });
    expect(mocks.tx.vehicleOwnership.create).toHaveBeenCalledWith({ data: expect.objectContaining({ vehicleId: vehicle.id, ownerId: owner.id, ownershipStatus: 'ACTIVE' }) });
    expect(result).toEqual({ decision: 'VERIFIED', replayed: false, vehicle: { id: vehicle.id, status: 'ACTIVE', governmentStatus: 'VERIFIED' } });
    expect(JSON.stringify(result)).not.toContain(owner.nationalId);
    expect(JSON.stringify(result)).not.toContain('government-ref-1');
    expect(JSON.stringify(mocks.tx.operation.create.mock.calls[0][0].data.metadata)).not.toContain(owner.nationalId);
  });

  it('keeps the vehicle DRAFT/UNKNOWN after a REJECTED decision', async () => {
    const result = await verifyVehicleOwnership({ userId: owner.id, vehicleId: vehicle.id, provider: provider({ decision: 'REJECTED', providerReference: 'rejected-ref' }) });
    expect(result).toEqual({ decision: 'REJECTED', replayed: false, vehicle: { id: vehicle.id, status: 'DRAFT', governmentStatus: 'UNKNOWN' } });
    expect(mocks.tx.vehicle.update).not.toHaveBeenCalled();
    expect(mocks.tx.operation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', providerReference: 'rejected-ref' }) }));
  });

  it('marks an ambiguous provider failure without activating the vehicle and can safely reuse the same key later', async () => {
    const boundary: VehicleOwnershipProvider = { verifyOwnership: vi.fn(async () => { throw new Error('TRAFFIC_PROVIDER_UNAVAILABLE'); }) };
    await expect(verifyVehicleOwnership({ userId: owner.id, vehicleId: vehicle.id, provider: boundary })).rejects.toThrow('TRAFFIC_PROVIDER_UNAVAILABLE');
    expect(mocks.db.operation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: operation.id, status: 'PENDING' }, data: expect.objectContaining({ status: 'FAILED', providerReference: null }),
    }));
    expect(mocks.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it('places a cross-operation provider reference replay into manual review', async () => {
    mocks.tx.operation.findFirst.mockResolvedValue({ id: 'other-operation' });
    await expect(verifyVehicleOwnership({ userId: owner.id, vehicleId: vehicle.id, provider: provider() })).rejects.toThrow('TRAFFIC_PROVIDER_REFERENCE_REPLAY');
    expect(mocks.tx.operation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'MANUAL_REVIEW' }) }));
    expect(mocks.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it('does not overwrite a government restriction applied while provider verification is in flight', async () => {
    mocks.tx.vehicle.findUnique.mockReset()
      .mockResolvedValueOnce(vehicle)
      .mockResolvedValueOnce({ ...vehicle, owner: undefined, governmentStatus: 'BLOCKED' });

    await expect(verifyVehicleOwnership({ userId: owner.id, vehicleId: vehicle.id, provider: provider() }))
      .rejects.toThrow('VEHICLE_OWNERSHIP_SUBJECT_CHANGED');

    expect(mocks.tx.operation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'MANUAL_REVIEW' }),
    }));
    expect(mocks.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it('does not activate when phone verification expires while the provider request is in flight', async () => {
    mocks.tx.user.findUnique.mockResolvedValue({ ...owner, phoneStatus: 'EXPIRED' });

    await expect(verifyVehicleOwnership({ userId: owner.id, vehicleId: vehicle.id, provider: provider() }))
      .rejects.toThrow('VEHICLE_OWNERSHIP_SUBJECT_CHANGED');

    expect(mocks.tx.operation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'MANUAL_REVIEW' }),
    }));
    expect(mocks.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it('replays an already verified vehicle without calling the provider', async () => {
    mocks.tx.vehicle.findUnique.mockReset().mockResolvedValue({ ...vehicle, status: 'ACTIVE', governmentStatus: 'VERIFIED' });
    const boundary = provider();
    const result = await verifyVehicleOwnership({ userId: owner.id, vehicleId: vehicle.id, provider: boundary });
    expect(result).toEqual({ decision: 'VERIFIED', replayed: true, vehicle: { id: vehicle.id, status: 'ACTIVE', governmentStatus: 'VERIFIED' } });
    expect(boundary.verifyOwnership).not.toHaveBeenCalled();
  });
});
