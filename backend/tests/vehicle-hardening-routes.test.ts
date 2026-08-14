import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  consumeCompositeRateLimit: vi.fn(),
  uploadVehicleMedia: vi.fn(),
  redactPlateBeforePublic: vi.fn(),
  generateVehicleDescription: vi.fn(),
  verifyVehicleOwnership: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  getCurrentUser: mocks.getCurrentUser,
  safeApiErrorCode: (error: unknown) => error instanceof Error ? error.message : 'INTERNAL_ERROR',
}));
vi.mock('@/lib/rate-limit', () => ({ consumeCompositeRateLimit: mocks.consumeCompositeRateLimit }));
vi.mock('@/lib/request-identity', () => ({ getTrustedClientIp: vi.fn(() => '203.0.113.9') }));
vi.mock('@/lib/vehicle-media', () => ({ uploadVehicleMedia: mocks.uploadVehicleMedia }));
vi.mock('@/lib/plate-redaction', () => ({ redactPlateBeforePublic: mocks.redactPlateBeforePublic }));
vi.mock('@/lib/vehicle-description', () => ({ generateVehicleDescription: mocks.generateVehicleDescription }));
vi.mock('@/lib/vehicle-ownership-verification', () => ({ verifyVehicleOwnership: mocks.verifyVehicleOwnership }));

import { POST as uploadMedia } from '../app/api/vehicles/[id]/media/route';
import { POST as publishMedia } from '../app/api/vehicles/[id]/media/[mediaId]/publish/route';
import { POST as generateDescription } from '../app/api/vehicles/[id]/description/route';
import { POST as verifyOwnership } from '../app/api/vehicles/[id]/verify-ownership/route';

const vehicleContext = { params: Promise.resolve({ id: 'vehicle-1' }) };
const mediaContext = { params: Promise.resolve({ id: 'vehicle-1', mediaId: 'media-1' }) };

describe('vehicle hardening route boundaries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1', status: 'ACTIVE' });
    mocks.consumeCompositeRateLimit.mockResolvedValue(undefined);
  });

  it('does not claim an ownership verification for an unauthenticated request', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await verifyOwnership(new Request('https://markabat.test/api/vehicles/vehicle-1/verify-ownership', { method: 'POST' }), vehicleContext);
    expect(response.status).toBe(401);
    expect(mocks.consumeCompositeRateLimit).not.toHaveBeenCalled();
    expect(mocks.verifyVehicleOwnership).not.toHaveBeenCalled();
  });

  it('passes only the authenticated owner and URL vehicle into ownership verification', async () => {
    mocks.verifyVehicleOwnership.mockResolvedValue({ decision: 'VERIFIED', replayed: false, vehicle: { id: 'vehicle-1', status: 'ACTIVE', governmentStatus: 'VERIFIED' } });
    const response = await verifyOwnership(new Request('https://markabat.test/api/vehicles/vehicle-1/verify-ownership', { method: 'POST' }), vehicleContext);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.verifyVehicleOwnership).toHaveBeenCalledWith({ userId: 'owner-1', vehicleId: 'vehicle-1' });
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain('nationalId');
    expect(serialized).not.toContain('providerReference');
  });

  it('rate limits ownership verification before provider work', async () => {
    mocks.consumeCompositeRateLimit.mockRejectedValue(new Error('RATE_LIMITED'));
    const response = await verifyOwnership(new Request('https://markabat.test/api/vehicles/vehicle-1/verify-ownership', { method: 'POST' }), vehicleContext);
    expect(response.status).toBe(429);
    expect(mocks.verifyVehicleOwnership).not.toHaveBeenCalled();
  });

  it('rejects multipart uploads without a trusted Content-Length before formData parsing', async () => {
    const response = await uploadMedia(new Request('https://markabat.test/api/vehicles/vehicle-1/media', { method: 'POST', body: 'multipart' }), vehicleContext);
    expect(response.status).toBe(411);
    expect(mocks.uploadVehicleMedia).not.toHaveBeenCalled();
  });

  it('rejects multipart uploads above the request bound before formData parsing', async () => {
    const response = await uploadMedia(new Request('https://markabat.test/api/vehicles/vehicle-1/media', {
      method: 'POST', headers: { 'content-length': String(11 * 1024 * 1024) }, body: 'multipart',
    }), vehicleContext);
    expect(response.status).toBe(413);
    expect(mocks.uploadVehicleMedia).not.toHaveBeenCalled();
  });

  it('rate limits description generation before invoking the AI provider', async () => {
    mocks.consumeCompositeRateLimit.mockRejectedValue(new Error('RATE_LIMITED'));
    const response = await generateDescription(new Request('https://markabat.test/api/vehicles/vehicle-1/description', { method: 'POST', body: '{}' }), vehicleContext);
    expect(response.status).toBe(429);
    expect(mocks.generateVehicleDescription).not.toHaveBeenCalled();
  });

  it('rate limits plate publication before invoking the redaction provider', async () => {
    mocks.consumeCompositeRateLimit.mockRejectedValue(new Error('RATE_LIMITED'));
    const response = await publishMedia(new Request('https://markabat.test/api/vehicles/vehicle-1/media/media-1/publish', { method: 'POST' }), mediaContext);
    expect(response.status).toBe(429);
    expect(mocks.redactPlateBeforePublic).not.toHaveBeenCalled();
  });
});
