import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../lib/auth';
import { db } from '../lib/db';
import {
  activatePhoneChangeRequest,
  beginPhoneChange,
  cancelPhoneChange,
  getPhoneChangeOtpProvider,
  HttpPhoneChangeOtpProvider,
  maskPhone,
  normalizePhone,
  phoneChangeActivationAt,
  PHONE_CHANGE_SECURITY_DELAY_MS,
  publicPhoneChangeRequest,
  verifyPhoneChangeOtp,
  type PhoneChangeOtpProvider,
} from '../lib/phone-change';

class CapturingProvider implements PhoneChangeOtpProvider {
  name = 'TEST_SMS_PROVIDER';
  deliveries: Array<{ phone: string; otp: string; requestId: string; deliveryId: string }> = [];
  async send(delivery: { phone: string; otp: string; requestId: string; deliveryId: string }) {
    this.deliveries.push(delivery);
    return { providerReference: `sms-${delivery.deliveryId}` };
  }
}

const dbIt = process.env.DATABASE_URL ? it : it.skip;

function uniquePhone(prefix = '77') {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`.slice(-7);
  return `${prefix}${suffix}`;
}

async function cleanupUser(userId: string) {
  await db.notification.deleteMany({ where: { userId } });
  await db.auditLog.deleteMany({ where: { userId } });
  await db.phoneChangeRequest.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: userId } });
}

describe('phone-change pure security contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('normalizes valid phone numbers and exposes only a masked value', () => {
    expect(normalizePhone(' +967777000123 ')).toBe('+967777000123');
    expect(maskPhone('+967777000123')).toBe('+********0123');
    expect(() => normalizePhone('777 000 123')).toThrow('INVALID_PHONE');
  });

  it('uses an exact, non-configurable 48-hour security delay', () => {
    const verifiedAt = new Date('2026-08-14T10:00:00.000Z');
    expect(PHONE_CHANGE_SECURITY_DELAY_MS).toBe(48 * 60 * 60 * 1000);
    expect(phoneChangeActivationAt(verifiedAt).toISOString()).toBe('2026-08-16T10:00:00.000Z');
  });

  it('never includes raw phones, OTP hashes, or provider references in the public projection', () => {
    const request = publicPhoneChangeRequest({
      id: 'request-1', userId: 'user-1', oldPhone: '777000111', newPhone: '777000222', newPhoneMasked: '*****0222',
      status: 'OTP_PENDING', activeUserKey: 'user-1', reservedPhoneKey: '777000222', expectedSessionVersion: 0,
      otpDeliveryId: 'delivery-1', otpHash: 'bcrypt-hash', otpAttempts: 0, otpMaxAttempts: 5,
      otpExpiresAt: new Date('2026-08-14T10:05:00Z'), resendAvailableAt: new Date('2026-08-14T10:01:00Z'),
      requestExpiresAt: new Date('2026-08-15T10:00:00Z'), otpVerifiedAt: null, activateAt: null, activatedAt: null,
      cancelledAt: null, expiredAt: null, provider: 'SMS', providerReference: 'secret-provider-reference',
      requestIpHash: null, deviceHash: null, createdAt: new Date('2026-08-14T10:00:00Z'), updatedAt: new Date('2026-08-14T10:00:00Z'),
    });
    expect(request.newPhoneMasked).toBe('*****0222');
    expect(request).not.toHaveProperty('newPhone');
    expect(request).not.toHaveProperty('oldPhone');
    expect(request).not.toHaveProperty('otpHash');
    expect(request).not.toHaveProperty('providerReference');
  });

  it('fails closed when SMS credentials are missing or production transport is not HTTPS', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMS_PROVIDER_URL', '');
    vi.stubEnv('SMS_PROVIDER_SECRET', '');
    expect(() => getPhoneChangeOtpProvider()).toThrow('NOT_CONFIGURED:SMS_PROVIDER_REQUIRED');
    vi.stubEnv('SMS_PROVIDER_URL', 'http://sms.test/send');
    vi.stubEnv('SMS_PROVIDER_SECRET', 'secret');
    expect(() => getPhoneChangeOtpProvider()).toThrow('NOT_CONFIGURED:SMS_PROVIDER_HTTPS_REQUIRED');
  });

  it('binds provider delivery to a unique request delivery without returning the OTP', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const provider = new HttpPhoneChangeOtpProvider(new URL('https://sms.test/send'), 'secret', async (input, init) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ providerReference: 'provider-ref' }), { status: 200 });
    });
    const result = await provider.send({ phone: '777000222', otp: '123456', requestId: 'request-1', deliveryId: 'delivery-1' });
    expect(result).toEqual({ providerReference: 'provider-ref' });
    const [, init] = calls[0];
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('delivery-1');
    expect(JSON.parse(String(init?.body))).toEqual({ phone: '777000222', otp: '123456', operationId: 'PHONE_CHANGE:request-1:delivery-1', purpose: 'PHONE_CHANGE' });
    expect(result).not.toHaveProperty('otp');
  });
});

describe('phone-change database workflow', () => {
  dbIt('verifies ownership without changing the phone, then supports cancellation before activation', async () => {
    const provider = new CapturingProvider();
    const password = 'Phone-Change-Test-Password!';
    const oldPhone = uniquePhone('71');
    const newPhone = uniquePhone('72');
    const user = await db.user.create({ data: { fullName: 'PHONE CHANGE USER', phone: oldPhone, passwordHash: await hashPassword(password), status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    try {
      const started = await beginPhoneChange({ userId: user.id, expectedSessionVersion: 0, currentPassword: password, newPhone, provider });
      expect(started.newPhoneMasked).toBe(maskPhone(newPhone));
      expect(provider.deliveries).toHaveLength(1);
      const stored = await db.phoneChangeRequest.findUniqueOrThrow({ where: { id: started.id } });
      expect(stored.otpHash).toBeTruthy();
      expect(stored.otpHash).not.toBe(provider.deliveries[0].otp);

      const verifiedAt = new Date('2026-08-14T10:00:00Z');
      const verified = await verifyPhoneChangeOtp({ userId: user.id, requestId: started.id, otp: provider.deliveries[0].otp, now: verifiedAt });
      expect(verified.status).toBe('SECURITY_DELAY');
      expect(verified.activateAt).toBe('2026-08-16T10:00:00.000Z');
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).phone).toBe(oldPhone);

      const cancelled = await cancelPhoneChange({ userId: user.id, requestId: started.id, now: new Date('2026-08-15T10:00:00Z') });
      expect(cancelled.status).toBe('CANCELLED');
      await expect(activatePhoneChangeRequest(started.id, new Date('2026-08-17T10:00:00Z'))).rejects.toThrow('PHONE_CHANGE_NOT_ACTIVE');
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).phone).toBe(oldPhone);
    } finally {
      await cleanupUser(user.id);
    }
  });

  dbIt('activates atomically after 48 hours, invalidates sessions once, and is idempotent', async () => {
    const provider = new CapturingProvider();
    const password = 'Phone-Activation-Test-Password!';
    const oldPhone = uniquePhone('73');
    const newPhone = uniquePhone('74');
    const user = await db.user.create({ data: { fullName: 'PHONE ACTIVATION USER', phone: oldPhone, passwordHash: await hashPassword(password), status: 'ACTIVE', phoneStatus: 'VERIFIED', sessionVersion: 7 } });
    try {
      const started = await beginPhoneChange({ userId: user.id, expectedSessionVersion: 7, currentPassword: password, newPhone, provider });
      const verifiedAt = new Date('2026-08-14T10:00:00Z');
      await verifyPhoneChangeOtp({ userId: user.id, requestId: started.id, otp: provider.deliveries[0].otp, now: verifiedAt });
      await expect(activatePhoneChangeRequest(started.id, new Date(verifiedAt.getTime() + PHONE_CHANGE_SECURITY_DELAY_MS - 1))).rejects.toThrow('PHONE_CHANGE_NOT_DUE');
      const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(before.phone).toBe(oldPhone);
      expect(before.sessionVersion).toBe(7);

      const activated = await activatePhoneChangeRequest(started.id, new Date(verifiedAt.getTime() + PHONE_CHANGE_SECURITY_DELAY_MS));
      expect(activated).toEqual({ status: 'ACTIVATED', activated: true });
      const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.phone).toBe(newPhone);
      expect(after.phoneStatus).toBe('VERIFIED');
      expect(after.sessionVersion).toBe(8);
      expect(await db.auditLog.count({ where: { userId: user.id, action: 'PHONE_CHANGED' } })).toBe(1);

      expect(await activatePhoneChangeRequest(started.id, new Date(verifiedAt.getTime() + PHONE_CHANGE_SECURITY_DELAY_MS + 1))).toEqual({ status: 'ACTIVATED', activated: false });
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(8);
      expect(await db.auditLog.count({ where: { userId: user.id, action: 'PHONE_CHANGED' } })).toBe(1);
    } finally {
      await cleanupUser(user.id);
    }
  });

  dbIt('allows only one concurrent active request per user', async () => {
    const password = 'Concurrent-Phone-Request!';
    const user = await db.user.create({ data: { fullName: 'PHONE RACE USER', phone: uniquePhone('75'), passwordHash: await hashPassword(password), status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    try {
      const results = await Promise.allSettled([
        beginPhoneChange({ userId: user.id, expectedSessionVersion: 0, currentPassword: password, newPhone: uniquePhone('76'), provider: new CapturingProvider() }),
        beginPhoneChange({ userId: user.id, expectedSessionVersion: 0, currentPassword: password, newPhone: uniquePhone('77'), provider: new CapturingProvider() }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(await db.phoneChangeRequest.count({ where: { userId: user.id, status: { in: ['OTP_PENDING', 'SECURITY_DELAY'] } } })).toBe(1);
    } finally {
      await cleanupUser(user.id);
    }
  });

  dbIt('does not reserve or send an OTP to a number owned by another user', async () => {
    const password = 'Unavailable-Phone-Test!';
    const occupiedPhone = uniquePhone('78');
    const first = await db.user.create({ data: { fullName: 'PHONE OWNER', phone: occupiedPhone, passwordHash: await hashPassword(password), status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const second = await db.user.create({ data: { fullName: 'PHONE REQUESTER', phone: uniquePhone('79'), passwordHash: await hashPassword(password), status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const provider = new CapturingProvider();
    try {
      await expect(beginPhoneChange({ userId: second.id, expectedSessionVersion: 0, currentPassword: password, newPhone: `+${occupiedPhone}`, provider })).rejects.toThrow('PHONE_CHANGE_UNAVAILABLE');
      expect(provider.deliveries).toHaveLength(0);
      expect(await db.phoneChangeRequest.count({ where: { userId: second.id } })).toBe(0);
    } finally {
      await cleanupUser(second.id);
      await cleanupUser(first.id);
    }
  });
});
