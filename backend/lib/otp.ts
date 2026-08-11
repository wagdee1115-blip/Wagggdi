import { createHash, randomInt } from 'crypto';
import { db } from './db';

export type OtpType = 'BUYER' | 'SELLER';
export type OtpChannel = 'SMS';

export interface OtpProvider {
  name: string;
  configured: boolean;
  sendOtp(phone: string, otp: string, operationId: string): Promise<{ providerReference: string; channel: OtpChannel }>;
}

class HttpSmsOtpProvider implements OtpProvider {
  name = 'SMS_HTTP_PROVIDER';
  configured = true;
  constructor(private readonly url: string, private readonly secret: string) {}
  async sendOtp(phone: string, otp: string, operationId: string) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({ phone, otp, operationId }),
    });
    if (!response.ok) throw new Error('SMS_PROVIDER_FAILED');
    const data = await response.json() as { providerReference?: string };
    if (!data.providerReference) throw new Error('SMS_PROVIDER_REFERENCE_MISSING');
    return { providerReference: data.providerReference, channel: 'SMS' as const };
  }
}

export class UnconfiguredOtpProvider implements OtpProvider {
  name = 'SMS_NOT_CONFIGURED';
  configured = false;
  async sendOtp(): Promise<{ providerReference: string; channel: OtpChannel }> {
    throw new Error('NOT_CONFIGURED:SMS_PROVIDER_REQUIRED');
  }
}

function defaultProvider(): OtpProvider {
  if (process.env.SMS_PROVIDER_URL && process.env.SMS_PROVIDER_SECRET) return new HttpSmsOtpProvider(process.env.SMS_PROVIDER_URL, process.env.SMS_PROVIDER_SECRET);
  return new UnconfiguredOtpProvider();
}

export class OtpService {
  private provider: OtpProvider;
  private readonly OTP_EXPIRY_MS = Number(process.env.OTP_EXPIRY_MINUTES ?? 5) * 60 * 1000;
  private readonly RESEND_DELAY_MS = 60 * 1000;
  private readonly MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS ?? 5);
  private readonly MAX_PER_PHONE_HOUR = 10;
  private readonly MAX_PER_IP_HOUR = 30;
  private readonly MAX_PER_DEVICE_HOUR = 20;
  private readonly MAX_PER_USER_HOUR = 10;

  constructor(provider?: OtpProvider) { this.provider = provider ?? defaultProvider(); }

  private hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
  private generateOtp() { return randomInt(1000, 10000).toString(); }

  async sendOtp(params: { phone: string; operationId: string; type: OtpType; ip?: string; deviceId?: string; userId?: string }): Promise<{ otpId: string; expiresAt: Date; providerReference: string }> {
    const now = new Date();
    const requestIpHash = params.ip ? this.hash(params.ip) : undefined;
    const deviceHash = params.deviceId ? this.hash(params.deviceId) : undefined;

    return db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${params.operationId}:${params.type}`}))`;
      const existing = await tx.otpRecord.findFirst({ where: { operationId: params.operationId, type: params.type, isUsed: false, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
      if (existing && existing.resendAvailableAt > now) throw new Error('OTP_RESEND_TOO_SOON');

      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const [phoneCount, ipCount, deviceCount, userCount] = await Promise.all([
        tx.otpRecord.count({ where: { phone: params.phone, createdAt: { gte: hourAgo } } }),
        requestIpHash ? tx.otpRecord.count({ where: { requestIpHash, createdAt: { gte: hourAgo } } }) : 0,
        deviceHash ? tx.otpRecord.count({ where: { deviceHash, createdAt: { gte: hourAgo } } }) : 0,
        params.userId ? tx.otpRecord.count({ where: { userId: params.userId, createdAt: { gte: hourAgo } } }) : 0,
      ]);
      if (phoneCount >= this.MAX_PER_PHONE_HOUR) throw new Error('OTP_PHONE_RATE_LIMIT');
      if (requestIpHash && ipCount >= this.MAX_PER_IP_HOUR) throw new Error('OTP_IP_RATE_LIMIT');
      if (deviceHash && deviceCount >= this.MAX_PER_DEVICE_HOUR) throw new Error('OTP_DEVICE_RATE_LIMIT');
      if (params.userId && userCount >= this.MAX_PER_USER_HOUR) throw new Error('OTP_USER_RATE_LIMIT');

      const otp = this.generateOtp();
      const expiresAt = new Date(now.getTime() + this.OTP_EXPIRY_MS);
      const resendAvailableAt = new Date(now.getTime() + this.RESEND_DELAY_MS);
      const providerResult = await this.provider.sendOtp(params.phone, otp, params.operationId);
      await tx.otpRecord.updateMany({ where: { operationId: params.operationId, type: params.type, isUsed: false }, data: { isUsed: true } });
      const record = await tx.otpRecord.create({ data: {
        operationId: params.operationId, type: params.type, phone: params.phone, userId: params.userId,
        otpHash: this.hash(otp), channel: providerResult.channel, providerReference: providerResult.providerReference,
        attempts: 0, maxAttempts: this.MAX_ATTEMPTS, resendAvailableAt, requestIpHash, deviceHash, expiresAt,
      } });
      return { otpId: record.id, expiresAt, providerReference: providerResult.providerReference };
    });
  }

  async verifyOtp(params: { otpId: string; otp: string; operationId: string; type: OtpType }): Promise<{ verified: boolean }> {
    if (!/^\d{4}$/.test(params.otp)) throw new Error('OTP_INVALID_FORMAT');
    const now = new Date();
    return db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.otpId}))`;
      const record = await tx.otpRecord.findUnique({ where: { id: params.otpId } });
      if (!record) throw new Error('OTP_NOT_FOUND');
      if (record.operationId !== params.operationId || record.type !== params.type) throw new Error('OTP_MISMATCH');
      if (record.isUsed) throw new Error('OTP_REPLAY');
      if (record.expiresAt <= now) throw new Error('OTP_EXPIRED');
      if (record.attempts >= record.maxAttempts) throw new Error('OTP_MAX_ATTEMPTS');

      const nextAttempts = record.attempts + 1;
      await tx.otpRecord.update({ where: { id: record.id }, data: { attempts: nextAttempts } });
      const valid = this.hash(params.otp) === record.otpHash;
      if (!valid) {
        if (nextAttempts >= record.maxAttempts) throw new Error('OTP_MAX_ATTEMPTS');
        throw new Error('OTP_INVALID');
      }
      await tx.otpRecord.update({ where: { id: record.id }, data: { isUsed: true, verifiedAt: now } });
      return { verified: true };
    });
  }

  async cleanupExpired() { return db.otpRecord.deleteMany({ where: { isUsed: false, expiresAt: { lt: new Date() } } }).then(r => r.count); }
}

export const otpService = new OtpService();
