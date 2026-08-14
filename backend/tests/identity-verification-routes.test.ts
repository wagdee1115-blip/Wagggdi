import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const verificationBase = {
  id: 'verification-1',
  userId: 'user-1',
  nationalId: '1234567890',
  dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
  provider: 'TEST_IDENTITY',
  status: 'PENDING',
  providerReference: null as string | null,
  verifiedAt: null as Date | null,
  createdAt: new Date('2026-08-14T10:00:00.000Z'),
  updatedAt: new Date('2026-08-14T10:00:00.000Z'),
};

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  consumeCompositeRateLimit: vi.fn(),
  verifyIdentity: vi.fn(),
  getIdentityProvider: vi.fn(),
  isIdentityVerified: vi.fn(),
  db: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    identityVerification: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    notification: { create: vi.fn() },
  },
}));

vi.mock('@/lib/api-auth', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/db', () => ({ db: mocks.db }));
vi.mock('@/lib/rate-limit', () => ({ consumeCompositeRateLimit: mocks.consumeCompositeRateLimit }));
vi.mock('@/lib/request-identity', () => ({ getTrustedClientIp: vi.fn(() => undefined) }));
vi.mock('@/lib/identity-policy', () => ({ isIdentityVerified: mocks.isIdentityVerified }));
vi.mock('@/lib/identity-provider-http', () => ({
  formatDateOnly: (value: Date) => value.toISOString().slice(0, 10),
  getIdentityProvider: mocks.getIdentityProvider,
  isAdult: vi.fn(() => true),
  normalizeNationalId: (value: string) => value.replace(/\D/g, ''),
  parseDateOnly: (value: string) => new Date(`${value}T00:00:00.000Z`),
}));

import { POST as submitIdentity } from '../app/api/identity-verifications/route';

function request() {
  return new Request('https://markabat.test/api/identity-verifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nationalId: '1234567890', dateOfBirth: '1990-01-01' }),
  });
}

describe('identity verification privacy boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({
      id: 'user-1',
      status: 'ACTIVE',
      phoneStatus: 'VERIFIED',
      identityStatus: 'UNVERIFIED',
      nationalId: null,
      dateOfBirth: null,
    });
    mocks.consumeCompositeRateLimit.mockResolvedValue(undefined);
    mocks.getIdentityProvider.mockReturnValue({
      name: 'TEST_IDENTITY',
      verifyIdentity: mocks.verifyIdentity,
    });
    mocks.isIdentityVerified.mockImplementation((user: { identityStatus?: string; nationalId?: string | null }) => (
      user.identityStatus === 'VERIFIED' && Boolean(user.nationalId)
    ));
    mocks.db.$transaction.mockImplementation(async (input: unknown) => {
      if (typeof input === 'function') return input(mocks.db);
      if (Array.isArray(input)) return Promise.all(input);
      throw new Error('UNEXPECTED_TRANSACTION_INPUT');
    });
    mocks.db.identityVerification.create.mockResolvedValue(verificationBase);
    mocks.db.identityVerification.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...verificationBase,
      ...data,
      updatedAt: verificationBase.updatedAt,
    }));
    mocks.db.identityVerification.findUnique.mockResolvedValue(null);
    mocks.db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    mocks.db.notification.create.mockResolvedValue({ id: 'notification-1' });
    mocks.db.user.findUnique.mockResolvedValue({
      id: 'user-1', status: 'ACTIVE', identityStatus: 'UNVERIFIED', nationalId: null, dateOfBirth: null,
    });
    mocks.db.user.findFirst.mockResolvedValue({ id: 'existing-owner' });
  });

  it('does provider-equivalent work and returns the same public rejection for a bound ID', async () => {
    mocks.verifyIdentity
      .mockResolvedValueOnce({ status: 'REJECTED', providerReference: 'provider-rejected' })
      .mockResolvedValueOnce({ status: 'VERIFIED', providerReference: 'provider-verified' });

    const providerRejection = await submitIdentity(request());
    const providerRejectionBody = await providerRejection.json();
    expect(mocks.db.user.findFirst).not.toHaveBeenCalled();

    const duplicateRejection = await submitIdentity(request());
    const duplicateRejectionBody = await duplicateRejection.json();

    expect(mocks.verifyIdentity).toHaveBeenCalledTimes(2);
    expect(mocks.db.user.findFirst).toHaveBeenCalledTimes(1);
    expect(providerRejection.status).toBe(201);
    expect(duplicateRejection.status).toBe(201);
    expect(duplicateRejectionBody).toEqual(providerRejectionBody);
    expect(duplicateRejectionBody).toMatchObject({
      ok: true,
      verification: { id: 'verification-1', status: 'REJECTED', provider: 'TEST_IDENTITY' },
    });
    expect(JSON.stringify(duplicateRejectionBody)).not.toMatch(/CONFLICT|REPLAY|nationalId|1234567890/);
  });

  it('maps a concurrent national-ID uniqueness race to the same generic rejection', async () => {
    mocks.verifyIdentity
      .mockResolvedValueOnce({ status: 'REJECTED', providerReference: 'provider-rejected' })
      .mockResolvedValueOnce({ status: 'VERIFIED', providerReference: 'provider-race' });

    const providerRejection = await submitIdentity(request());
    const providerRejectionBody = await providerRejection.json();

    mocks.db.user.findFirst.mockResolvedValue(null);
    mocks.db.user.update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '5.22.0', meta: { target: ['nationalId'] } },
    ));
    const raceRejection = await submitIdentity(request());
    const raceRejectionBody = await raceRejection.json();

    expect(raceRejection.status).toBe(201);
    expect(raceRejectionBody).toEqual(providerRejectionBody);
    expect(JSON.stringify(raceRejectionBody)).not.toMatch(/CONFLICT|REPLAY|nationalId|1234567890/);
    expect(mocks.db.identityVerification.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'REJECTED' }),
    }));
  });
});
