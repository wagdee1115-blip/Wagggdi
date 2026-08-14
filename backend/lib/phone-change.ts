import bcrypt from 'bcryptjs';
import { createHash, randomInt, randomUUID } from 'crypto';
import { Prisma, type PhoneChangeRequest, type PhoneChangeStatus } from '@prisma/client';
import { db } from './db';
import { verifyPassword } from './auth';
import { readBoundedResponseText } from './http-bounds';
import { requireProviderEndpoint } from './provider-endpoint';

export const PHONE_CHANGE_SECURITY_DELAY_MS = 48 * 60 * 60 * 1000;
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const OTP_RESEND_DELAY_MS = 60 * 1000;
const REQUEST_EXPIRY_MS = 24 * 60 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

export type PublicPhoneChangeRequest = {
  id: string;
  status: PhoneChangeStatus;
  newPhoneMasked: string;
  otpExpiresAt: string | null;
  resendAvailableAt: string | null;
  activateAt: string | null;
  activatedAt: string | null;
  canCancel: boolean;
  canResend: boolean;
  createdAt: string;
};

export interface PhoneChangeOtpProvider {
  name: string;
  send(params: { phone: string; otp: string; requestId: string; deliveryId: string }): Promise<{ providerReference: string }>;
}

export class HttpPhoneChangeOtpProvider implements PhoneChangeOtpProvider {
  readonly name = 'SMS_HTTP_PROVIDER';

  constructor(
    private readonly endpoint: URL,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(params: { phone: string; otp: string; requestId: string; deliveryId: string }) {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.secret}`,
          'idempotency-key': params.deliveryId,
        },
        body: JSON.stringify({
          phone: params.phone,
          otp: params.otp,
          operationId: `PHONE_CHANGE:${params.requestId}:${params.deliveryId}`,
          purpose: 'PHONE_CHANGE',
        }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      throw new Error('SMS_DELIVERY_FAILED');
    }
    if (!response.ok) throw new Error('SMS_DELIVERY_FAILED');
    const body = await readBoundedResponseText(response, 64 * 1024, 'SMS_DELIVERY_FAILED');
    let payload: { providerReference?: unknown } | null = null;
    try { payload = body ? JSON.parse(body) as { providerReference?: unknown } : null; } catch { payload = null; }
    if (!payload || typeof payload.providerReference !== 'string' || !payload.providerReference.trim() || payload.providerReference.length > 300) {
      throw new Error('SMS_DELIVERY_FAILED');
    }
    return { providerReference: payload.providerReference.trim() };
  }
}

export function getPhoneChangeOtpProvider(): PhoneChangeOtpProvider {
  const secret = process.env.SMS_PROVIDER_SECRET?.trim();
  if (!secret) throw new Error('NOT_CONFIGURED:SMS_PROVIDER_REQUIRED');
  const endpoint = new URL(requireProviderEndpoint(process.env.SMS_PROVIDER_URL, 'SMS_PROVIDER'));
  return new HttpPhoneChangeOtpProvider(endpoint, secret);
}

export function normalizePhone(value: string) {
  const normalized = value.trim();
  if (!/^\+?[0-9]{9,15}$/.test(normalized)) throw new Error('INVALID_PHONE');
  return normalized;
}

export function maskPhone(value: string) {
  const normalized = normalizePhone(value);
  const digits = normalized.replace(/\D/g, '');
  return `${normalized.startsWith('+') ? '+' : ''}${'*'.repeat(Math.max(5, digits.length - 4))}${digits.slice(-4)}`;
}

function phoneVariants(value: string) {
  const normalized = normalizePhone(value);
  const digits = normalized.replace(/^\+/, '');
  return [digits, `+${digits}`];
}

function phoneReservationKey(value: string) {
  return normalizePhone(value).replace(/^\+/, '');
}

export function phoneChangeActivationAt(verifiedAt: Date) {
  return new Date(verifiedAt.getTime() + PHONE_CHANGE_SECURITY_DELAY_MS);
}

export function publicPhoneChangeRequest(request: PhoneChangeRequest): PublicPhoneChangeRequest {
  const active = request.status === 'OTP_PENDING' || request.status === 'SECURITY_DELAY';
  return {
    id: request.id,
    status: request.status,
    newPhoneMasked: request.newPhoneMasked,
    otpExpiresAt: request.status === 'OTP_PENDING' ? request.otpExpiresAt.toISOString() : null,
    resendAvailableAt: request.status === 'OTP_PENDING' ? request.resendAvailableAt.toISOString() : null,
    activateAt: request.activateAt?.toISOString() ?? null,
    activatedAt: request.activatedAt?.toISOString() ?? null,
    canCancel: active,
    canResend: request.status === 'OTP_PENDING',
    createdAt: request.createdAt.toISOString(),
  };
}

function hashOptional(value: string | undefined) {
  return value ? createHash('sha256').update(value).digest('hex') : null;
}

function generateOtp() {
  return randomInt(100_000, 1_000_000).toString();
}

function isUniqueError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function finishFailedDelivery(requestId: string, deliveryId: string) {
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PhoneChangeRequest" WHERE id = ${requestId} FOR UPDATE`;
    const request = await tx.phoneChangeRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== 'OTP_PENDING' || request.otpDeliveryId !== deliveryId) return;
    await tx.phoneChangeRequest.update({
      where: { id: request.id },
      data: {
        status: 'FAILED', activeUserKey: null, reservedPhoneKey: null, otpHash: null,
        expiredAt: new Date(), providerReference: null,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: request.userId, action: 'PHONE_CHANGE_SMS_FAILED', entityType: 'PHONE_CHANGE_REQUEST', entityId: request.id,
        metadata: { newPhoneMasked: request.newPhoneMasked },
      },
    });
  });
}

export async function beginPhoneChange(params: {
  userId: string;
  expectedSessionVersion: number;
  currentPassword: string;
  newPhone: string;
  ip?: string;
  deviceId?: string;
  now?: Date;
  provider?: PhoneChangeOtpProvider;
}) {
  const now = params.now ?? new Date();
  const newPhone = normalizePhone(params.newPhone);
  const provider = params.provider ?? getPhoneChangeOtpProvider();
  const snapshot = await db.user.findUnique({ where: { id: params.userId } });
  if (!snapshot || snapshot.status !== 'ACTIVE') throw new Error('UNAUTHORIZED');
  if (snapshot.sessionVersion !== params.expectedSessionVersion) throw new Error('ACCOUNT_CHANGED_RETRY');
  if (!(await verifyPassword(params.currentPassword, snapshot.passwordHash))) throw new Error('CURRENT_PASSWORD_INVALID');
  if (phoneVariants(newPhone).includes(snapshot.phone)) throw new Error('PHONE_CHANGE_UNAVAILABLE');

  const requestId = randomUUID();
  const deliveryId = randomUUID();
  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, 12);
  const masked = maskPhone(newPhone);
  const otpExpiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
  const resendAvailableAt = new Date(now.getTime() + OTP_RESEND_DELAY_MS);
  const requestExpiresAt = new Date(now.getTime() + REQUEST_EXPIRY_MS);

  let request: PhoneChangeRequest;
  try {
    request = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${params.userId} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: params.userId } });
      if (!current || current.status !== 'ACTIVE') throw new Error('UNAUTHORIZED');
      if (current.sessionVersion !== snapshot.sessionVersion || current.passwordHash !== snapshot.passwordHash) throw new Error('ACCOUNT_CHANGED_RETRY');
      if (phoneVariants(newPhone).includes(current.phone)) throw new Error('PHONE_CHANGE_UNAVAILABLE');

      const active = await tx.phoneChangeRequest.findUnique({ where: { activeUserKey: params.userId } });
      if (active && active.status === 'OTP_PENDING' && active.requestExpiresAt <= now) {
        await tx.phoneChangeRequest.update({
          where: { id: active.id },
          data: { status: 'EXPIRED', activeUserKey: null, reservedPhoneKey: null, otpHash: null, expiredAt: now },
        });
      } else if (active) {
        throw new Error('PHONE_CHANGE_UNAVAILABLE');
      }

      const unavailable = await tx.user.findFirst({ where: { phone: { in: phoneVariants(newPhone) }, id: { not: current.id } }, select: { id: true } });
      if (unavailable) throw new Error('PHONE_CHANGE_UNAVAILABLE');
      return tx.phoneChangeRequest.create({
        data: {
          id: requestId,
          userId: current.id,
          oldPhone: current.phone,
          newPhone,
          newPhoneMasked: masked,
          activeUserKey: current.id,
          reservedPhoneKey: phoneReservationKey(newPhone),
          expectedSessionVersion: current.sessionVersion,
          otpDeliveryId: deliveryId,
          otpHash,
          otpMaxAttempts: OTP_MAX_ATTEMPTS,
          otpExpiresAt,
          resendAvailableAt,
          requestExpiresAt,
          provider: provider.name,
          requestIpHash: hashOptional(params.ip),
          deviceHash: hashOptional(params.deviceId),
        },
      });
    });
  } catch (error) {
    if (isUniqueError(error)) throw new Error('PHONE_CHANGE_UNAVAILABLE');
    throw error;
  }

  let providerReference: string;
  try {
    providerReference = (await provider.send({ phone: newPhone, otp, requestId, deliveryId })).providerReference;
  } catch (error) {
    await finishFailedDelivery(requestId, deliveryId);
    if (error instanceof Error && error.message.startsWith('NOT_CONFIGURED:')) throw error;
    throw new Error('SMS_DELIVERY_FAILED');
  }

  request = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PhoneChangeRequest" WHERE id = ${requestId} FOR UPDATE`;
    const current = await tx.phoneChangeRequest.findUnique({ where: { id: requestId } });
    if (!current || current.status !== 'OTP_PENDING' || current.otpDeliveryId !== deliveryId) throw new Error('PHONE_CHANGE_NOT_ACTIVE');
    const updated = await tx.phoneChangeRequest.update({ where: { id: requestId }, data: { providerReference } });
    await tx.auditLog.create({
      data: {
        userId: updated.userId, action: 'PHONE_CHANGE_OTP_SENT', entityType: 'PHONE_CHANGE_REQUEST', entityId: updated.id,
        metadata: { newPhoneMasked: updated.newPhoneMasked, requestExpiresAt: updated.requestExpiresAt.toISOString() },
      },
    });
    await tx.notification.create({
      data: {
        userId: updated.userId, type: 'SECURITY_ALERT', title: 'بدء طلب تغيير رقم الهاتف',
        message: `بدأ طلب تغيير رقم الهاتف إلى ${updated.newPhoneMasked}. لن يتغير الرقم قبل التحقق ومرور مهلة الأمان.`, priority: 'HIGH',
      },
    });
    return updated;
  });
  return publicPhoneChangeRequest(request);
}

export async function resendPhoneChangeOtp(params: {
  userId: string;
  requestId: string;
  now?: Date;
  provider?: PhoneChangeOtpProvider;
}) {
  const now = params.now ?? new Date();
  const provider = params.provider ?? getPhoneChangeOtpProvider();
  const deliveryId = randomUUID();
  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, 12);
  const otpExpiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
  const resendAvailableAt = new Date(now.getTime() + OTP_RESEND_DELAY_MS);

  const request = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PhoneChangeRequest" WHERE id = ${params.requestId} FOR UPDATE`;
    const current = await tx.phoneChangeRequest.findUnique({ where: { id: params.requestId }, include: { user: true } });
    if (!current || current.userId !== params.userId) throw new Error('PHONE_CHANGE_NOT_FOUND');
    if (current.user.status !== 'ACTIVE' || current.user.sessionVersion !== current.expectedSessionVersion || current.user.phone !== current.oldPhone) {
      throw new Error('ACCOUNT_CHANGED_RETRY');
    }
    if (current.status !== 'OTP_PENDING') throw new Error('PHONE_CHANGE_NOT_ACTIVE');
    if (current.requestExpiresAt <= now) {
      await tx.phoneChangeRequest.update({ where: { id: current.id }, data: { status: 'EXPIRED', activeUserKey: null, reservedPhoneKey: null, otpHash: null, expiredAt: now } });
      return { request: current, error: 'OTP_EXPIRED' as string | null };
    }
    if (current.resendAvailableAt > now) throw new Error('OTP_RESEND_TOO_SOON');
    const updated = await tx.phoneChangeRequest.update({
      where: { id: current.id },
      data: { otpDeliveryId: deliveryId, otpHash, otpExpiresAt, resendAvailableAt, providerReference: null, provider: provider.name },
    });
    return { request: updated, error: null as string | null };
  });
  if (request.error) throw new Error(request.error);

  let providerReference: string;
  try {
    providerReference = (await provider.send({ phone: request.request.newPhone, otp, requestId: request.request.id, deliveryId })).providerReference;
  } catch {
    await finishFailedDelivery(request.request.id, deliveryId);
    throw new Error('SMS_DELIVERY_FAILED');
  }

  const updated = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PhoneChangeRequest" WHERE id = ${params.requestId} FOR UPDATE`;
    const current = await tx.phoneChangeRequest.findUnique({ where: { id: params.requestId } });
    if (!current || current.userId !== params.userId || current.status !== 'OTP_PENDING' || current.otpDeliveryId !== deliveryId) throw new Error('PHONE_CHANGE_NOT_ACTIVE');
    const saved = await tx.phoneChangeRequest.update({ where: { id: current.id }, data: { providerReference } });
    await tx.auditLog.create({ data: { userId: saved.userId, action: 'PHONE_CHANGE_OTP_RESENT', entityType: 'PHONE_CHANGE_REQUEST', entityId: saved.id, metadata: { newPhoneMasked: saved.newPhoneMasked } } });
    return saved;
  });
  return publicPhoneChangeRequest(updated);
}

export async function verifyPhoneChangeOtp(params: { userId: string; requestId: string; otp: string; now?: Date }) {
  if (!/^\d{6}$/.test(params.otp)) throw new Error('OTP_INVALID_FORMAT');
  const now = params.now ?? new Date();
  const outcome = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PhoneChangeRequest" WHERE id = ${params.requestId} FOR UPDATE`;
    const request = await tx.phoneChangeRequest.findUnique({ where: { id: params.requestId }, include: { user: true } });
    if (!request || request.userId !== params.userId) throw new Error('PHONE_CHANGE_NOT_FOUND');
    if (request.status === 'SECURITY_DELAY') return { request, error: null as string | null };
    if (request.status !== 'OTP_PENDING') throw new Error('PHONE_CHANGE_NOT_ACTIVE');
    if (request.user.status !== 'ACTIVE' || request.user.sessionVersion !== request.expectedSessionVersion || request.user.phone !== request.oldPhone) {
      const failed = await tx.phoneChangeRequest.update({ where: { id: request.id }, data: { status: 'FAILED', activeUserKey: null, reservedPhoneKey: null, otpHash: null, expiredAt: now } });
      await tx.auditLog.create({ data: { userId: request.userId, action: 'PHONE_CHANGE_ACCOUNT_CHANGED', entityType: 'PHONE_CHANGE_REQUEST', entityId: request.id, metadata: { newPhoneMasked: request.newPhoneMasked } } });
      return { request: failed, error: 'ACCOUNT_CHANGED_RETRY' };
    }
    if (request.requestExpiresAt <= now || request.otpExpiresAt <= now) {
      const expired = await tx.phoneChangeRequest.update({ where: { id: request.id }, data: { status: 'EXPIRED', activeUserKey: null, reservedPhoneKey: null, otpHash: null, expiredAt: now } });
      return { request: expired, error: 'OTP_EXPIRED' };
    }
    if (!request.providerReference || !request.otpHash) throw new Error('OTP_DELIVERY_PENDING');

    const valid = await bcrypt.compare(params.otp, request.otpHash);
    const attempts = request.otpAttempts + 1;
    if (!valid) {
      if (attempts >= request.otpMaxAttempts) {
        const failed = await tx.phoneChangeRequest.update({ where: { id: request.id }, data: { status: 'FAILED', otpAttempts: attempts, activeUserKey: null, reservedPhoneKey: null, otpHash: null, expiredAt: now } });
        await tx.auditLog.create({ data: { userId: request.userId, action: 'PHONE_CHANGE_OTP_LOCKED', entityType: 'PHONE_CHANGE_REQUEST', entityId: request.id, metadata: { newPhoneMasked: request.newPhoneMasked } } });
        return { request: failed, error: 'OTP_MAX_ATTEMPTS' };
      }
      const updated = await tx.phoneChangeRequest.update({ where: { id: request.id }, data: { otpAttempts: attempts } });
      return { request: updated, error: 'OTP_INVALID' };
    }

    const activateAt = phoneChangeActivationAt(now);
    const verified = await tx.phoneChangeRequest.update({
      where: { id: request.id },
      data: { status: 'SECURITY_DELAY', otpAttempts: attempts, otpHash: null, otpVerifiedAt: now, activateAt },
    });
    await tx.auditLog.create({
      data: {
        userId: request.userId, action: 'PHONE_CHANGE_OTP_VERIFIED', entityType: 'PHONE_CHANGE_REQUEST', entityId: request.id,
        metadata: { newPhoneMasked: request.newPhoneMasked, activateAt: activateAt.toISOString(), securityDelayHours: 48 },
      },
    });
    await tx.notification.create({
      data: {
        userId: request.userId, type: 'SECURITY_ALERT', title: 'تم التحقق من الرقم الجديد',
        message: `تم التحقق من ${request.newPhoneMasked}. سيُفعّل بعد 48 ساعة ويمكنك إلغاء الطلب قبل التفعيل.`, priority: 'CRITICAL',
      },
    });
    return { request: verified, error: null as string | null };
  });
  if (outcome.error) throw new Error(outcome.error);
  return publicPhoneChangeRequest(outcome.request);
}

export async function cancelPhoneChange(params: { userId: string; requestId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const request = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PhoneChangeRequest" WHERE id = ${params.requestId} FOR UPDATE`;
    const current = await tx.phoneChangeRequest.findUnique({ where: { id: params.requestId } });
    if (!current || current.userId !== params.userId) throw new Error('PHONE_CHANGE_NOT_FOUND');
    if (current.status === 'CANCELLED') return current;
    if (current.status === 'ACTIVATED') throw new Error('PHONE_CHANGE_ALREADY_ACTIVATED');
    if (!['OTP_PENDING', 'SECURITY_DELAY'].includes(current.status)) throw new Error('PHONE_CHANGE_NOT_ACTIVE');
    const cancelled = await tx.phoneChangeRequest.update({
      where: { id: current.id },
      data: { status: 'CANCELLED', activeUserKey: null, reservedPhoneKey: null, otpHash: null, cancelledAt: now },
    });
    await tx.auditLog.create({ data: { userId: current.userId, action: 'PHONE_CHANGE_CANCELLED', entityType: 'PHONE_CHANGE_REQUEST', entityId: current.id, metadata: { newPhoneMasked: current.newPhoneMasked } } });
    await tx.notification.create({ data: { userId: current.userId, type: 'SECURITY_ALERT', title: 'تم إلغاء تغيير رقم الهاتف', message: `أُلغي طلب التغيير إلى ${current.newPhoneMasked} ولم يتغير رقم حسابك.`, priority: 'HIGH' } });
    return cancelled;
  });
  return publicPhoneChangeRequest(request);
}

async function expirePhoneChangeRequest(requestId: string, now: Date) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PhoneChangeRequest" WHERE id = ${requestId} FOR UPDATE`;
    const request = await tx.phoneChangeRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== 'OTP_PENDING' || request.requestExpiresAt > now) return request;
    const expired = await tx.phoneChangeRequest.update({ where: { id: request.id }, data: { status: 'EXPIRED', activeUserKey: null, reservedPhoneKey: null, otpHash: null, expiredAt: now } });
    await tx.auditLog.create({ data: { userId: request.userId, action: 'PHONE_CHANGE_EXPIRED', entityType: 'PHONE_CHANGE_REQUEST', entityId: request.id, metadata: { newPhoneMasked: request.newPhoneMasked } } });
    return expired;
  });
}

export async function getLatestPhoneChange(userId: string, now = new Date()) {
  let request = await db.phoneChangeRequest.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  if (request?.status === 'OTP_PENDING' && request.requestExpiresAt <= now) request = await expirePhoneChangeRequest(request.id, now);
  return request ? publicPhoneChangeRequest(request) : null;
}

async function failActivation(requestId: string, now: Date, reason: string) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PhoneChangeRequest" WHERE id = ${requestId} FOR UPDATE`;
    const request = await tx.phoneChangeRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== 'SECURITY_DELAY') return request;
    const failed = await tx.phoneChangeRequest.update({ where: { id: request.id }, data: { status: 'FAILED', activeUserKey: null, reservedPhoneKey: null, otpHash: null, expiredAt: now } });
    await tx.auditLog.create({ data: { userId: request.userId, action: 'PHONE_CHANGE_ACTIVATION_BLOCKED', entityType: 'PHONE_CHANGE_REQUEST', entityId: request.id, metadata: { newPhoneMasked: request.newPhoneMasked, reason } } });
    await tx.notification.create({ data: { userId: request.userId, type: 'SECURITY_ALERT', title: 'تعذر تفعيل رقم الهاتف الجديد', message: `لم يُفعّل ${request.newPhoneMasked} بسبب تغير أمني في الحساب. ابدأ طلبًا جديدًا بعد مراجعة أمان حسابك.`, priority: 'CRITICAL' } });
    return failed;
  });
}

export async function activatePhoneChangeRequest(requestId: string, now = new Date()) {
  try {
    const outcome = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "PhoneChangeRequest" WHERE id = ${requestId} FOR UPDATE`;
      const request = await tx.phoneChangeRequest.findUnique({ where: { id: requestId } });
      if (!request) throw new Error('PHONE_CHANGE_NOT_FOUND');
      if (request.status === 'ACTIVATED') return { request, activated: false };
      if (request.status !== 'SECURITY_DELAY') throw new Error('PHONE_CHANGE_NOT_ACTIVE');
      if (!request.activateAt || request.activateAt > now) throw new Error('PHONE_CHANGE_NOT_DUE');

      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${request.userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: request.userId } });
      const collision = await tx.user.findFirst({ where: { phone: { in: phoneVariants(request.newPhone) }, id: { not: request.userId } }, select: { id: true } });
      if (!user || user.status !== 'ACTIVE' || user.phone !== request.oldPhone || user.sessionVersion !== request.expectedSessionVersion || collision) {
        return { request, activated: false, failure: 'ACCOUNT_OR_PHONE_CHANGED' as string | undefined };
      }

      const updatedUser = await tx.user.update({ where: { id: user.id }, data: { phone: request.newPhone, phoneStatus: 'VERIFIED', sessionVersion: { increment: 1 } } });
      const activated = await tx.phoneChangeRequest.update({
        where: { id: request.id },
        data: { status: 'ACTIVATED', activeUserKey: null, reservedPhoneKey: null, otpHash: null, activatedAt: now },
      });
      await tx.auditLog.create({
        data: {
          userId: user.id, action: 'PHONE_CHANGED', entityType: 'USER', entityId: user.id,
          metadata: {
            requestId: request.id, oldPhoneMasked: maskPhone(request.oldPhone), newPhoneMasked: request.newPhoneMasked,
            previousSessionVersion: user.sessionVersion, newSessionVersion: updatedUser.sessionVersion, sessionsInvalidated: true,
          },
        },
      });
      await tx.notification.create({
        data: {
          userId: user.id, type: 'SECURITY_ALERT', title: 'تم تغيير رقم الهاتف',
          message: `فُعّل رقم الهاتف ${request.newPhoneMasked} وأُلغيت جميع الجلسات. سجّل الدخول باستخدام الرقم الجديد.`, priority: 'CRITICAL',
        },
      });
      return { request: activated, activated: true };
    });
    if (outcome.failure) {
      const failed = await failActivation(requestId, now, outcome.failure);
      return { status: failed?.status ?? 'FAILED', activated: false };
    }
    return { status: outcome.request.status, activated: outcome.activated };
  } catch (error) {
    if (isUniqueError(error)) {
      const failed = await failActivation(requestId, now, 'PHONE_COLLISION');
      return { status: failed?.status ?? 'FAILED', activated: false };
    }
    throw error;
  }
}

export async function processDuePhoneChanges(now = new Date(), limit = 100) {
  const [due, stale] = await Promise.all([
    db.phoneChangeRequest.findMany({ where: { status: 'SECURITY_DELAY', activateAt: { lte: now } }, select: { id: true }, orderBy: { activateAt: 'asc' }, take: limit }),
    db.phoneChangeRequest.findMany({ where: { status: 'OTP_PENDING', requestExpiresAt: { lte: now } }, select: { id: true }, orderBy: { requestExpiresAt: 'asc' }, take: limit }),
  ]);
  let activated = 0;
  let failed = 0;
  let expired = 0;
  for (const candidate of stale) {
    const result = await expirePhoneChangeRequest(candidate.id, now);
    if (result?.status === 'EXPIRED') expired += 1;
  }
  for (const candidate of due) {
    try {
      const result = await activatePhoneChangeRequest(candidate.id, now);
      if (result.activated) activated += 1;
      else if (result.status === 'FAILED') failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: due.length + stale.length, activated, failed, expired };
}

export function phoneChangeError(error: unknown) {
  const raw = error instanceof Error ? error.message : '';
  const known = new Set([
    'UNAUTHORIZED', 'ACCOUNT_CHANGED_RETRY', 'CURRENT_PASSWORD_INVALID', 'INVALID_PHONE', 'PHONE_CHANGE_UNAVAILABLE',
    'PHONE_CHANGE_NOT_FOUND', 'PHONE_CHANGE_NOT_ACTIVE', 'PHONE_CHANGE_ALREADY_ACTIVATED', 'PHONE_CHANGE_NOT_DUE',
    'OTP_INVALID_FORMAT', 'OTP_INVALID', 'OTP_EXPIRED', 'OTP_MAX_ATTEMPTS', 'OTP_RESEND_TOO_SOON',
    'OTP_DELIVERY_PENDING', 'SMS_DELIVERY_FAILED', 'RATE_LIMITED',
  ]);
  const code = raw.startsWith('NOT_CONFIGURED:SMS_PROVIDER') ? raw : known.has(raw) ? raw : 'PHONE_CHANGE_FAILED';
  const status = code === 'UNAUTHORIZED' ? 401
    : code === 'PHONE_CHANGE_NOT_FOUND' ? 404
      : code === 'RATE_LIMITED' || code === 'OTP_RESEND_TOO_SOON' ? 429
        : code.startsWith('NOT_CONFIGURED:') ? 503
          : code === 'SMS_DELIVERY_FAILED' ? 502
            : ['PHONE_CHANGE_UNAVAILABLE', 'PHONE_CHANGE_NOT_ACTIVE', 'PHONE_CHANGE_ALREADY_ACTIVATED', 'PHONE_CHANGE_NOT_DUE', 'ACCOUNT_CHANGED_RETRY'].includes(code) ? 409
              : code === 'OTP_EXPIRED' || code === 'OTP_MAX_ATTEMPTS' ? 410
                : 400;
  return { code, status };
}
