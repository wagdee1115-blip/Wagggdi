import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { db } from '../lib/db';
import { hashRecoveryToken, verifyPasswordResetOtp } from '../lib/password-recovery';
import { passwordResetPublicResponse } from '../app/api/auth/forgot-password/request/route';

describe('opaque password recovery flow', () => {
  it('uses an indistinguishable public response for existing and nonexistent targets', () => {
    const existing = passwordResetPublicResponse('token-a');
    const missing = passwordResetPublicResponse('token-b');
    expect(Object.keys(existing)).toEqual(Object.keys(missing));
    expect(existing.message).toBe(missing.message);
    expect(existing.ok).toBe(missing.ok);
  });

  it('continues valid recovery and rejects forged, replayed, expired, and cross-request tokens', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await db.user.create({ data: { fullName: 'RECOVERY USER', phone: `764${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const createRequest = async (token: string, otp: string, expired = false) => {
      const operationId = `PASSWORD_RESET:${suffix}:${token}`;
      const otpRow = await db.otpRecord.create({ data: { operationId, type: 'BUYER', phone: user.phone, userId: user.id, otpHash: createHash('sha256').update(otp).digest('hex'), resendAvailableAt: new Date(), expiresAt: new Date(Date.now() + (expired ? -1000 : 60_000)) } });
      const request = await db.passwordResetRequest.create({ data: { userId: user.id, otpId: otpRow.id, operationId, recoveryTokenHash: hashRecoveryToken(token), expiresAt: otpRow.expiresAt } });
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
});
