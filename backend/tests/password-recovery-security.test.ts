import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  hashPassword: vi.fn(),
  signPasswordResetJwt: vi.fn(),
  isIdentityVerified: vi.fn(),
  otpSend: vi.fn(),
  otpVerify: vi.fn(),
  db: {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn(), update: vi.fn() },
    otpRecord: { updateMany: vi.fn() },
    passwordResetRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    notification: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../lib/db', () => ({ db: mocks.db }));
vi.mock('../lib/otp', () => ({
  otpService: { sendOtp: mocks.otpSend, verifyOtp: mocks.otpVerify },
}));
vi.mock('../lib/auth', () => ({
  hashPassword: mocks.hashPassword,
  signPasswordResetJwt: mocks.signPasswordResetJwt,
}));
vi.mock('../lib/rate-limit', () => ({ consumeRateLimit: mocks.consumeRateLimit }));
vi.mock('../lib/identity-policy', () => ({ isIdentityVerified: mocks.isIdentityVerified }));

import {
  PASSWORD_RESET_VERIFICATION_LIMIT,
  PASSWORD_RESET_VERIFICATION_WINDOW_MS,
  completePasswordReset,
  passwordRecoveryRiskLevel,
  requestPasswordReset,
  verifyPasswordResetOtp,
} from '../lib/password-recovery';

const expiresAt = new Date('2030-01-01T00:00:00.000Z');

function resetRequest(index: number, expectedSessionVersion: number | null = 7) {
  return {
    id: `request-${index}`,
    userId: 'user-1',
    otpId: `otp-${index}`,
    operationId: `PASSWORD_RESET:user-1:${index}`,
    recoveryTokenHash: `hash-${index}`,
    expectedSessionVersion,
    riskLevel: 'LOW',
    verifiedAt: null,
    completedAt: null,
    expiresAt,
    createdAt: new Date('2029-12-31T00:00:00.000Z'),
    user: {
      id: 'user-1',
      phone: '777000111',
      status: 'ACTIVE',
      sessionVersion: 7,
      identityStatus: 'UNVERIFIED',
      nationalId: null,
    },
  };
}

describe('password recovery hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true, count: 1, remaining: 4 });
    mocks.hashPassword.mockResolvedValue('new-password-hash');
    mocks.otpSend.mockResolvedValue({ otpId: 'otp-new', expiresAt, providerReference: 'provider-private' });
    mocks.otpVerify.mockResolvedValue({ verified: true });
    mocks.db.passwordResetRequest.create.mockResolvedValue({ id: 'request-new' });
    mocks.db.passwordResetRequest.updateMany.mockResolvedValue({ count: 1 });
    mocks.db.otpRecord.updateMany.mockResolvedValue({ count: 1 });
    mocks.signPasswordResetJwt.mockResolvedValue('signed-reset-token');
    mocks.isIdentityVerified.mockReturnValue(false);
    mocks.db.$transaction.mockImplementation(async (callback: (tx: typeof mocks.db) => unknown) => callback(mocks.db));
  });

  it('stores the request-time session version and opts into recovery-scoped OTP supersession', async () => {
    mocks.db.user.findUnique.mockResolvedValue({
      id: 'user-1', phone: '777000111', status: 'ACTIVE', role: 'AUDITOR', sessionVersion: 7,
    });

    await requestPasswordReset({ phone: '777000111' });

    expect(mocks.otpSend).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      securityScope: 'PASSWORD_RESET',
    }));
    expect(mocks.db.passwordResetRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      expectedSessionVersion: 7,
      riskLevel: 'HIGH',
    }) });
  });

  it.each([
    ['legacy request without a stored version', null],
    ['request made before session invalidation', 6],
  ])('fails closed before OTP verification for a stale %s', async (_label, expectedSessionVersion) => {
    mocks.db.passwordResetRequest.findUnique.mockResolvedValue(resetRequest(1, expectedSessionVersion));

    await expect(verifyPasswordResetOtp({ recoveryToken: 'recovery-token-1', otp: '1234' }))
      .rejects.toThrow('RESET_TOKEN_STALE');
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.otpVerify).not.toHaveBeenCalled();
    expect(mocks.signPasswordResetJwt).not.toHaveBeenCalled();
  });

  it('binds completion to the version stored on the reset request, not only the JWT claim', async () => {
    mocks.db.passwordResetRequest.findUnique.mockResolvedValue({
      ...resetRequest(1, 6),
      verifiedAt: new Date('2029-12-31T12:00:00.000Z'),
    });

    await expect(completePasswordReset({
      resetRequestId: 'request-1',
      userId: 'user-1',
      expectedSessionVersion: 7,
      password: 'New-Password-123!',
    })).rejects.toThrow('RESET_TOKEN_STALE');
    expect(mocks.db.user.update).not.toHaveBeenCalled();
  });

  it('shares one atomic verification budget across recovery tokens for the account and phone', async () => {
    let requestIndex = 0;
    const counters = new Map<string, number>();
    mocks.db.passwordResetRequest.findUnique.mockImplementation(async () => resetRequest(++requestIndex));
    mocks.consumeRateLimit.mockImplementation(async (key: string, limit: number, windowMs: number) => {
      expect(limit).toBe(PASSWORD_RESET_VERIFICATION_LIMIT);
      expect(windowMs).toBe(PASSWORD_RESET_VERIFICATION_WINDOW_MS);
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      if (count > limit) throw new Error('RATE_LIMITED');
      return { allowed: true, count, remaining: limit - count };
    });

    for (let index = 0; index < PASSWORD_RESET_VERIFICATION_LIMIT; index += 1) {
      await expect(verifyPasswordResetOtp({ recoveryToken: `different-token-${index}`, otp: '1234' }))
        .resolves.toMatchObject({ resetToken: 'signed-reset-token' });
    }
    await expect(verifyPasswordResetOtp({ recoveryToken: 'different-token-over-budget', otp: '1234' }))
      .rejects.toThrow('RATE_LIMITED');

    expect(counters.size).toBe(2);
    expect([...counters.keys()].some(key => key.startsWith('forgot-password:verify:user:'))).toBe(true);
    expect([...counters.keys()].some(key => key.startsWith('forgot-password:verify:phone:'))).toBe(true);
    expect(mocks.otpVerify).toHaveBeenCalledTimes(PASSWORD_RESET_VERIFICATION_LIMIT);
    expect(mocks.signPasswordResetJwt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionVersion: 7 }));
  });

  it.each([
    ['USER', 'LOW'], ['SELLER', 'LOW'], ['BUYER', 'LOW'], ['DEALER', 'LOW'],
    ['SUPPORT', 'HIGH'], ['FINANCE', 'HIGH'], ['VERIFIER', 'HIGH'], ['AUDITOR', 'HIGH'],
    ['ADMIN', 'HIGH'], ['SUPER_ADMIN', 'HIGH'], ['OWNER', 'HIGH'], ['MODERATOR', 'HIGH'],
    ['FUTURE_PRIVILEGED_ROLE', 'HIGH'],
  ])('classifies %s recovery as %s risk', (role, risk) => {
    expect(passwordRecoveryRiskLevel(role)).toBe(risk);
  });
});
