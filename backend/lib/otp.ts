import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto';
import { db } from './db';
import { readBoundedResponseText } from './http-bounds';
import { requireProviderEndpoint } from './provider-endpoint';

export type OtpType = 'BUYER' | 'SELLER';
export type OtpChannel = 'SMS';
export type OtpSecurityScope = 'PASSWORD_RESET';

export type OtpHashContext = {
  userId: string;
  operationId: string;
  type: OtpType;
};

function otpHashSecret() {
  const secret = process.env.OTP_HASH_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (secret) {
    if (process.env.NODE_ENV === 'production' && secret.length < 32) {
      throw new Error('NOT_CONFIGURED:OTP_HASH_SECRET_TOO_SHORT');
    }
    return secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NOT_CONFIGURED:OTP_HASH_SECRET_REQUIRED');
  }
  return 'local-development-only-otp-hash-secret';
}

function contextValue(value: string) {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/** Store low-entropy OTP values as keyed, user/operation-bound digests. */
export function hashOtpForStorage(otp: string, context: OtpHashContext) {
  const message = [context.userId, context.operationId, context.type, otp]
    .map(contextValue)
    .join('|');
  const digest = createHmac('sha256', otpHashSecret()).update(message).digest('hex');
  return `h1:${digest}`;
}

function constantTimeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function otpHashMatches(otp: string, context: OtpHashContext, storedHash: string) {
  if (storedHash.startsWith('h1:')) {
    return constantTimeStringEqual(hashOtpForStorage(otp, context), storedHash);
  }

  // Deployment compatibility for already-issued records. New records always
  // use h1, and legacy rows naturally expire within the configured OTP window.
  const legacyDigest = createHash('sha256').update(otp).digest('hex');
  return constantTimeStringEqual(legacyDigest, storedHash);
}

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
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('SMS_PROVIDER_FAILED');
    const body = await readBoundedResponseText(response, 64 * 1024, 'SMS_PROVIDER_REFERENCE_MISSING');
    let data: { providerReference?: unknown } | null = null;
    try { data = body ? JSON.parse(body) as { providerReference?: unknown } : null; } catch { data = null; }
    if (!data || typeof data.providerReference !== 'string' || !data.providerReference.trim() || data.providerReference.length > 256) throw new Error('SMS_PROVIDER_REFERENCE_MISSING');
    return { providerReference: data.providerReference.trim(), channel: 'SMS' as const };
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
  if (process.env.SMS_PROVIDER_URL && process.env.SMS_PROVIDER_SECRET) {
    return new HttpSmsOtpProvider(requireProviderEndpoint(process.env.SMS_PROVIDER_URL, 'SMS_PROVIDER'), process.env.SMS_PROVIDER_SECRET);
  }
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

  private operationPrefix(scope: OtpSecurityScope) {
    return `${scope}:`;
  }

  private assertSecurityScope(operationId: string, scope?: OtpSecurityScope) {
    if (scope && !operationId.startsWith(this.operationPrefix(scope))) {
      throw new Error('OTP_SCOPE_MISMATCH');
    }
  }

  async sendOtp(params: { phone: string; operationId: string; type: OtpType; userId: string; ip?: string; deviceId?: string; securityScope?: OtpSecurityScope }): Promise<{ otpId: string; expiresAt: Date; providerReference: string }> {
    this.assertSecurityScope(params.operationId, params.securityScope);
    const now = new Date();
    const requestIpHash = params.ip ? this.hash(params.ip) : undefined;
    const deviceHash = params.deviceId ? this.hash(params.deviceId) : undefined;

    return db.$transaction(async tx => {
      const lockScope = params.securityScope
        ? `${params.userId}:OTP_SECURITY_SCOPE:${params.securityScope}`
        : `${params.userId}:${params.operationId}:${params.type}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockScope}))`;
      const user = await tx.user.findUnique({ where: { id: params.userId }, select: { phone: true } });
      if (!user || user.phone !== params.phone) throw new Error('OTP_USER_PHONE_MISMATCH');
      const existing = await tx.otpRecord.findFirst({ where: { userId: params.userId, operationId: params.operationId, type: params.type, isUsed: false, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
      if (existing && existing.resendAvailableAt > now) throw new Error('OTP_RESEND_TOO_SOON');

      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const [phoneCount, ipCount, deviceCount, userCount] = await Promise.all([
        tx.otpRecord.count({ where: { phone: params.phone, createdAt: { gte: hourAgo } } }),
        requestIpHash ? tx.otpRecord.count({ where: { requestIpHash, createdAt: { gte: hourAgo } } }) : 0,
        deviceHash ? tx.otpRecord.count({ where: { deviceHash, createdAt: { gte: hourAgo } } }) : 0,
        tx.otpRecord.count({ where: { userId: params.userId, createdAt: { gte: hourAgo } } }),
      ]);
      if (phoneCount >= this.MAX_PER_PHONE_HOUR) throw new Error('OTP_PHONE_RATE_LIMIT');
      if (requestIpHash && ipCount >= this.MAX_PER_IP_HOUR) throw new Error('OTP_IP_RATE_LIMIT');
      if (deviceHash && deviceCount >= this.MAX_PER_DEVICE_HOUR) throw new Error('OTP_DEVICE_RATE_LIMIT');
      if (userCount >= this.MAX_PER_USER_HOUR) throw new Error('OTP_USER_RATE_LIMIT');

      const otp = this.generateOtp();
      const expiresAt = new Date(now.getTime() + this.OTP_EXPIRY_MS);
      const resendAvailableAt = new Date(now.getTime() + this.RESEND_DELAY_MS);
      const providerResult = await this.provider.sendOtp(params.phone, otp, params.operationId);
      await tx.otpRecord.updateMany({ where: {
        userId: params.userId,
        operationId: params.securityScope ? { startsWith: this.operationPrefix(params.securityScope) } : params.operationId,
        type: params.type,
        isUsed: false,
      }, data: { isUsed: true } });
      const record = await tx.otpRecord.create({ data: {
        operationId: params.operationId, type: params.type, phone: params.phone, userId: params.userId,
        otpHash: hashOtpForStorage(otp, params), channel: providerResult.channel, providerReference: providerResult.providerReference,
        attempts: 0, maxAttempts: this.MAX_ATTEMPTS, resendAvailableAt, requestIpHash, deviceHash, expiresAt,
      } });
      return { otpId: record.id, expiresAt, providerReference: providerResult.providerReference };
    });
  }

  async verifyOtp(params: { otpId: string; otp: string; operationId: string; type: OtpType; userId: string; securityScope?: OtpSecurityScope }): Promise<{ verified: boolean }> {
    if (!/^\d{4}$/.test(params.otp)) throw new Error('OTP_INVALID_FORMAT');
    this.assertSecurityScope(params.operationId, params.securityScope);
    const now = new Date();
    const result = await db.$transaction(async tx => {
      if (params.securityScope) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${params.userId}:OTP_SECURITY_SCOPE:${params.securityScope}`}))`;
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.otpId}))`;
      const record = await tx.otpRecord.findUnique({ where: { id: params.otpId } });
      if (!record) throw new Error('OTP_NOT_FOUND');
      if (record.operationId !== params.operationId || record.type !== params.type) throw new Error('OTP_MISMATCH');
      if (!record.userId || record.userId !== params.userId) throw new Error('OTP_USER_MISMATCH');
      if (record.isUsed) throw new Error('OTP_REPLAY');
      if (record.expiresAt <= now) throw new Error('OTP_EXPIRED');
      if (record.attempts >= record.maxAttempts) throw new Error('OTP_MAX_ATTEMPTS');

      const nextAttempts = record.attempts + 1;
      const valid = otpHashMatches(params.otp, params, record.otpHash);
      if (valid) {
        await tx.otpRecord.update({ where: { id: record.id }, data: { attempts: nextAttempts, isUsed: true, verifiedAt: now } });
        return { verified: true as const, error: null as string | null };
      }

      // Commit the failed-attempt counter before returning an error. Throwing
      // inside this transaction would roll the counter back and allow unlimited attempts.
      await tx.otpRecord.update({ where: { id: record.id }, data: { attempts: nextAttempts } });
      return { verified: false as const, error: nextAttempts >= record.maxAttempts ? 'OTP_MAX_ATTEMPTS' : 'OTP_INVALID' };
    });

    if (result.error) throw new Error(result.error);
    return { verified: true };
  }

  async cleanupExpired() { return db.otpRecord.deleteMany({ where: { isUsed: false, expiresAt: { lt: new Date() } } }).then(r => r.count); }
}

export const otpService = new OtpService();
