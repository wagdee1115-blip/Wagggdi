import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    otpRecord: {
      findFirst: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../lib/db', () => ({ db: mocks.db }));

import { OtpService, type OtpProvider } from '../lib/otp';

describe('password-reset OTP scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.$transaction.mockImplementation(async (callback: (tx: typeof mocks.db) => unknown) => callback(mocks.db));
    mocks.db.user.findUnique.mockResolvedValue({ phone: '777000111' });
    mocks.db.otpRecord.findFirst.mockResolvedValue(null);
    mocks.db.otpRecord.count.mockResolvedValue(0);
    mocks.db.otpRecord.updateMany.mockResolvedValue({ count: 2 });
    mocks.db.otpRecord.create.mockResolvedValue({ id: 'otp-new' });
  });

  it('invalidates every prior unused recovery OTP without affecting other OTP flows', async () => {
    const provider: OtpProvider = {
      name: 'TEST_SMS',
      configured: true,
      async sendOtp() {
        return { providerReference: 'provider-private', channel: 'SMS' };
      },
    };
    const service = new OtpService(provider);

    await service.sendOtp({
      phone: '777000111',
      userId: 'user-1',
      operationId: 'PASSWORD_RESET:user-1:new-request',
      type: 'BUYER',
      securityScope: 'PASSWORD_RESET',
    });

    expect(mocks.db.otpRecord.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        operationId: { startsWith: 'PASSWORD_RESET:' },
        type: 'BUYER',
        isUsed: false,
      },
      data: { isUsed: true },
    });
  });

  it('rejects a mismatched scope before opening a database transaction', async () => {
    const service = new OtpService();
    await expect(service.sendOtp({
      phone: '777000111',
      userId: 'user-1',
      operationId: 'STEP_UP:user-1',
      type: 'SELLER',
      securityScope: 'PASSWORD_RESET',
    })).rejects.toThrow('OTP_SCOPE_MISMATCH');
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
});
