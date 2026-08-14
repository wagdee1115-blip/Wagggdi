import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    vehicle: { findUnique: vi.fn() },
    vehicleMedia: { findFirst: vi.fn(), create: vi.fn() },
  };
  return {
    tx,
    db: { $transaction: vi.fn(), vehicleMedia: { findUnique: vi.fn(), update: vi.fn() } },
    scanner: { configured: true, name: 'TEST', scan: vi.fn() },
    storage: { configured: true, name: 'TEST', putObject: vi.fn(), getSignedUrl: vi.fn() },
  };
});

vi.mock('../lib/db', () => ({ db: mocks.db }));
vi.mock('../lib/malware-scanner', () => ({ getMalwareScanner: () => mocks.scanner }));
vi.mock('../lib/storage', async () => {
  const actual = await vi.importActual<typeof import('../lib/storage')>('../lib/storage');
  return { ...actual, getStorageProvider: () => mocks.storage };
});

import { redactPlateBeforePublic } from '../lib/plate-redaction';
import { uploadVehicleMedia } from '../lib/vehicle-media';

const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'vehicle.png', { type: 'image/png' });

describe('vehicle media hardening', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.db.$transaction.mockImplementation(async (callback: (tx: typeof mocks.tx) => unknown) => callback(mocks.tx));
    mocks.tx.vehicle.findUnique.mockResolvedValue({ ownerId: 'owner-1' });
    mocks.scanner.scan.mockResolvedValue({ clean: true });
    mocks.storage.putObject.mockResolvedValue({ key: 'stored' });
  });

  it('takes a vehicle row lock and returns a duplicate before scanner or storage cost', async () => {
    const duplicate = { id: 'media-existing', vehicleId: 'vehicle-1', sha256Hash: 'hash', publicStatus: 'PRIVATE' };
    mocks.tx.vehicleMedia.findFirst.mockResolvedValue(duplicate);
    await expect(uploadVehicleMedia({ vehicleId: 'vehicle-1', userId: 'owner-1', file: png, mediaType: 'PRIMARY' }))
      .resolves.toEqual({ media: duplicate, replayed: true });
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.scanner.scan).not.toHaveBeenCalled();
    expect(mocks.storage.putObject).not.toHaveBeenCalled();
    expect(mocks.tx.vehicleMedia.create).not.toHaveBeenCalled();
  });

  it('scans, stores, and creates a new row while the serialized transaction is held', async () => {
    const created = { id: 'media-new', vehicleId: 'vehicle-1', publicStatus: 'PRIVATE' };
    mocks.tx.vehicleMedia.findFirst.mockResolvedValue(null);
    mocks.tx.vehicleMedia.create.mockResolvedValue(created);
    await expect(uploadVehicleMedia({ vehicleId: 'vehicle-1', userId: 'owner-1', file: png, mediaType: 'PRIMARY' }))
      .resolves.toEqual({ media: created, replayed: false });
    expect(mocks.scanner.scan).toHaveBeenCalledTimes(1);
    expect(mocks.storage.putObject).toHaveBeenCalledTimes(1);
    expect(mocks.tx.vehicleMedia.create).toHaveBeenCalledTimes(1);
    expect(mocks.db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 35_000 });
  });

  it('rejects a non-owner after the row lock and before external providers', async () => {
    mocks.tx.vehicle.findUnique.mockResolvedValue({ ownerId: 'owner-2' });
    await expect(uploadVehicleMedia({ vehicleId: 'vehicle-1', userId: 'owner-1', file: png, mediaType: 'PRIMARY' })).rejects.toThrow('FORBIDDEN');
    expect(mocks.scanner.scan).not.toHaveBeenCalled();
    expect(mocks.storage.putObject).not.toHaveBeenCalled();
  });

  it('returns already-public media before requiring or calling the redaction provider', async () => {
    const media = {
      id: 'media-1', vehicleId: 'vehicle-1', mediaType: 'PRIMARY', publicStatus: 'PUBLIC', optimizedStorageKey: 'vehicles/vehicle-1/optimized/image',
      vehicle: { ownerId: 'owner-1', governmentStatus: 'VERIFIED' },
    };
    mocks.db.vehicleMedia.findUnique.mockResolvedValue(media);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(redactPlateBeforePublic('media-1', 'owner-1', 'vehicle-1')).resolves.toBe(media);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.db.vehicleMedia.update).not.toHaveBeenCalled();
  });

  it('does not publish media for an unverified vehicle', async () => {
    mocks.db.vehicleMedia.findUnique.mockResolvedValue({
      id: 'media-1', vehicleId: 'vehicle-1', publicStatus: 'PRIVATE', optimizedStorageKey: null,
      vehicle: { ownerId: 'owner-1', governmentStatus: 'UNKNOWN' },
    });
    await expect(redactPlateBeforePublic('media-1', 'owner-1', 'vehicle-1')).rejects.toThrow('VEHICLE_OWNERSHIP_NOT_VERIFIED');
    expect(mocks.db.vehicleMedia.update).not.toHaveBeenCalled();
  });
});
