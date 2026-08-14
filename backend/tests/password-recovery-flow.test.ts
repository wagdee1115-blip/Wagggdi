import { describe, expect, it } from 'vitest';
import { db } from '../lib/db';
import { passwordResetPublicResponse } from '../lib/auth-public-contracts';
import { hashOtpForStorage } from '../lib/otp';
import { completePasswordReset, hashRecoveryToken, verifyPasswordResetOtp } from '../lib/password-recovery';

const dbIt = process.env.DATABASE_URL ? it : it.skip;

describe('opaque password recovery flow', () => {
  it('uses an indistinguishable public response for existing and nonexistent targets', () => {
    const existing = passwordResetPublicResponse('token-a');
    const missing = passwordResetPublicResponse('token-b');
    expect(Object.keys(existing)).toEqual(Object.keys(missing));
    expect(existing.message).toBe(missing.message);
    expect(existing.ok).toBe(missing.ok);
  });

  dbIt('continues valid recovery and rejects forged, replayed, expired, and cross-request tokens', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await db.user.create({ data: { fullName: 'RECOVERY USER', phone: `764${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const createRequest = async (token: string, otp: string, expired = false) => {
      const operationId = `PASSWORD_RESET:${suffix}:${token}`;
      const otpRow = await db.otpRecord.create({ data: { operationId, type: 'BUYER', phone: user.phone, userId: user.id, otpHash: hashOtpForStorage(otp, { userId: user.id, operationId, type: 'BUYER' }), resendAvailableAt: new Date(), expiresAt: new Date(Date.now() + (expired ? -1000 : 60_000)) } });
      const request = await db.passwordResetRequest.create({ data: { userId: user.id, otpId: otpRow.id, operationId, recoveryTokenHash: hashRecoveryToken(token), expectedSessionVersion: user.sessionVersion, expiresAt: otpRow.expiresAt } });
      return { otpRow, request };
    };
    const rows: string[] = [];
    try {
      const valid = await createRequest('valid-recovery-token-that-is-long-enough-0001', '1234'); rows.push(valid.otpRow.id, valid.request.id);
      const result = await verifyPasswordResetOtp({ recoveryToken: 'valid-recovery-token-that-is-long-enough-0001', otp: '1234' });
      expect(result.resetToken).toBeTruthy();
      await expect(verifyPasswordResetOtp({ recoveryToken: 'valid-recovery-token-that-is-long-enough-0001', otp: '1234' })).rejects.toThrow('RESET_REQUEST_EXPIRED');
      await expect(verifyPasswordResetOtp({ recoveryToken: 'forged-recovery-token-that-is-long-enough-0000', otp: '1234' })).rejects.toThrow('RESET_REQUEST_NOT_FOUND');

      const expired = await createRequest('expired-recovery-token-that-is-long-enough-02', '2345', true); rows.push(expired.otpRow.id, expired.request.id);
      await expect(verifyPasswordResetOtp({ recoveryToken: 'expired-recovery-token-that-is-long-enough-02', otp: '2345' })).rejects.toThrow('RESET_REQUEST_EXPIRED');

      const first = await createRequest('cross-recovery-token-that-is-long-enough-0003', '3456'); rows.push(first.otpRow.id, first.request.id);
      const second = await createRequest('other-recovery-token-that-is-long-enough-0004', '4567'); rows.push(second.otpRow.id, second.request.id);
      await expect(verifyPasswordResetOtp({ recoveryToken: 'cross-recovery-token-that-is-long-enough-0003', otp: '4567' })).rejects.toThrow('OTP_INVALID');
    } finally {
      await db.passwordResetRequest.deleteMany({ where: { id: { in: rows } } });
      await db.otpRecord.deleteMany({ where: { id: { in: rows } } });
      await db.user.delete({ where: { id: user.id } });
    }
  });

  dbIt('consumes a verified reset request exactly once under concurrent completion', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await db.user.create({ data: { fullName: 'RESET RACE USER', phone: `763${suffix.slice(-7)}`, passwordHash: 'old-hash', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const otp = await db.otpRecord.create({ data: { operationId: `RESET-RACE:${suffix}`, type: 'BUYER', phone: user.phone, userId: user.id, otpHash: 'unused', isUsed: true, verifiedAt: new Date(), resendAvailableAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
    const request = await db.passwordResetRequest.create({ data: { userId: user.id, otpId: otp.id, operationId: otp.operationId, recoveryTokenHash: hashRecoveryToken(`race-${suffix}`), expectedSessionVersion: user.sessionVersion, verifiedAt: new Date(), expiresAt: otp.expiresAt } });
    try {
      const results = await Promise.allSettled([
        completePasswordReset({ resetRequestId: request.id, userId: user.id, expectedSessionVersion: 0, password: 'Concurrent-Password-1!' }),
        completePasswordReset({ resetRequestId: request.id, userId: user.id, expectedSessionVersion: 0, password: 'Concurrent-Password-2!' }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(1);
    } finally {
      await db.notification.deleteMany({ where: { userId: user.id } });
      await db.auditLog.deleteMany({ where: { userId: user.id } });
      await db.passwordResetRequest.delete({ where: { id: request.id } });
      await db.otpRecord.delete({ where: { id: otp.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });

  dbIt('rejects a reset token issued for an older session version', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await db.user.create({ data: { fullName: 'STALE RESET USER', phone: `765${suffix.slice(-7)}`, passwordHash: 'old-hash', status: 'ACTIVE', phoneStatus: 'VERIFIED', sessionVersion: 2 } });
    const otp = await db.otpRecord.create({ data: { operationId: `RESET-STALE:${suffix}`, type: 'BUYER', phone: user.phone, userId: user.id, otpHash: 'unused', isUsed: true, verifiedAt: new Date(), resendAvailableAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
    const request = await db.passwordResetRequest.create({ data: { userId: user.id, otpId: otp.id, operationId: otp.operationId, recoveryTokenHash: hashRecoveryToken(`stale-${suffix}`), expectedSessionVersion: 1, verifiedAt: new Date(), expiresAt: otp.expiresAt } });
    try {
      await expect(completePasswordReset({ resetRequestId: request.id, userId: user.id, expectedSessionVersion: 1, password: 'Fresh-Password-123!' }))
        .rejects.toThrow('RESET_TOKEN_STALE');
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(2);
      expect((await db.passwordResetRequest.findUniqueOrThrow({ where: { id: request.id } })).completedAt).toBeNull();
    } finally {
      await db.passwordResetRequest.delete({ where: { id: request.id } });
      await db.otpRecord.delete({ where: { id: otp.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
});
