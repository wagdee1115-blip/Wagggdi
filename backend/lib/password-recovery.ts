import { db } from './db';
import { otpService } from './otp';
import { hashPassword, signPasswordResetJwt } from './auth';
import { consumeRateLimit } from './rate-limit';
import { rateLimitTarget } from './request-identity';
import { createHash, randomBytes } from 'crypto';
import { isIdentityVerified } from './identity-policy';

const ORDINARY_RECOVERY_ROLES = new Set(['USER', 'SELLER', 'BUYER', 'DEALER']);
export const PASSWORD_RESET_VERIFICATION_LIMIT = 5;
export const PASSWORD_RESET_VERIFICATION_WINDOW_MS = 15 * 60 * 1000;

export function passwordRecoveryRiskLevel(role: string): 'LOW' | 'HIGH' {
  // Any new or operational role fails closed until it is explicitly classified
  // as an ordinary customer role.
  return ORDINARY_RECOVERY_ROLES.has(role) ? 'LOW' : 'HIGH';
}

export function hashRecoveryToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function createRecoveryToken() {
  return randomBytes(32).toString('base64url');
}

export function passwordResetVerificationRateLimitKeys(userId: string, phone: string) {
  return [
    `forgot-password:verify:user:${rateLimitTarget(userId)}`,
    `forgot-password:verify:phone:${rateLimitTarget(phone)}`,
  ] as const;
}

async function consumePasswordResetVerificationBudget(userId: string, phone: string) {
  for (const key of passwordResetVerificationRateLimitKeys(userId, phone)) {
    await consumeRateLimit(key, PASSWORD_RESET_VERIFICATION_LIMIT, PASSWORD_RESET_VERIFICATION_WINDOW_MS);
  }
}

export async function requestPasswordReset(params: { phone: string; ip?: string }) {
  const recoveryToken = createRecoveryToken();
  await consumeRateLimit(`forgot-password:target:${rateLimitTarget(params.phone)}`, 5, 60 * 60 * 1000);
  if (params.ip) await consumeRateLimit(`forgot-password:ip:${params.ip}`, 10, 60 * 60 * 1000);
  const user = await db.user.findUnique({ where: { phone: params.phone } });
  if (!user || user.status !== 'ACTIVE') return { recoveryToken };
  const riskLevel = passwordRecoveryRiskLevel(user.role);
  const operationId = `PASSWORD_RESET:${user.id}:${hashRecoveryToken(recoveryToken).slice(0, 24)}`;
  const otp = await otpService.sendOtp({
    phone: user.phone,
    operationId,
    type: 'BUYER',
    ip: params.ip,
    userId: user.id,
    securityScope: 'PASSWORD_RESET',
  });
  try {
    await db.passwordResetRequest.create({ data: {
      userId: user.id,
      otpId: otp.otpId,
      operationId,
      recoveryTokenHash: hashRecoveryToken(recoveryToken),
      expectedSessionVersion: user.sessionVersion,
      riskLevel,
      expiresAt: otp.expiresAt,
    } });
  } catch (error) {
    // A delivered OTP without its opaque recovery request must never remain usable.
    await db.otpRecord.updateMany({ where: { id: otp.otpId }, data: { isUsed: true } }).catch(() => undefined);
    throw error;
  }
  return { recoveryToken };
}

export async function verifyPasswordResetOtp(params: { recoveryToken: string; otp: string }) {
  const request = await db.passwordResetRequest.findUnique({ where: { recoveryTokenHash: hashRecoveryToken(params.recoveryToken) }, include: { user: true } });
  if (!request) throw new Error('RESET_REQUEST_NOT_FOUND');
  if (request.completedAt || request.verifiedAt || request.expiresAt <= new Date()) throw new Error('RESET_REQUEST_EXPIRED');
  if (request.user.status !== 'ACTIVE') throw new Error('RESET_REQUEST_EXPIRED');
  if (request.expectedSessionVersion === null || request.expectedSessionVersion !== request.user.sessionVersion) {
    throw new Error('RESET_TOKEN_STALE');
  }

  await consumePasswordResetVerificationBudget(request.userId, request.user.phone);

  // OTP proves possession of the registered phone first; risk controls are applied after that proof.
  await otpService.verifyOtp({
    otpId: request.otpId,
    otp: params.otp,
    operationId: request.operationId,
    type: 'BUYER',
    userId: request.userId,
    securityScope: 'PASSWORD_RESET',
  });
  if (request.riskLevel === 'HIGH' && !isIdentityVerified(request.user)) {
    throw new Error('IDENTITY_VERIFICATION_REQUIRED');
  }

  const verifiedAt = new Date();
  const consumed = await db.passwordResetRequest.updateMany({
    where: { id: request.id, verifiedAt: null, completedAt: null, expiresAt: { gt: verifiedAt } },
    data: { verifiedAt },
  });
  if (consumed.count !== 1) throw new Error('RESET_REQUEST_EXPIRED');
  const resetToken = await signPasswordResetJwt({ sub: request.userId, resetRequestId: request.id, sessionVersion: request.expectedSessionVersion });
  return { resetToken, expiresAt: request.expiresAt };
}

export async function completePasswordReset(params: { resetRequestId: string; userId: string; expectedSessionVersion: number; password: string }) {
  const passwordHash = await hashPassword(params.password);
  return db.$transaction(async tx => {
    // Serialize reset-token consumption so concurrent requests cannot both
    // pass the completedAt check and apply two password changes.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`PASSWORD_RESET:${params.resetRequestId}`}))`;
    const request = await tx.passwordResetRequest.findUnique({ where: { id: params.resetRequestId } });
    if (!request || request.userId !== params.userId || !request.verifiedAt || request.completedAt || request.expiresAt <= new Date()) throw new Error('RESET_REQUEST_INVALID');
    if (request.expectedSessionVersion === null || request.expectedSessionVersion !== params.expectedSessionVersion) throw new Error('RESET_TOKEN_STALE');
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${params.userId} FOR UPDATE`;
    const currentUser = await tx.user.findUnique({ where: { id: params.userId } });
    if (!currentUser || currentUser.status !== 'ACTIVE') throw new Error('RESET_REQUEST_INVALID');
    if (!Number.isInteger(params.expectedSessionVersion) || currentUser.sessionVersion !== params.expectedSessionVersion) throw new Error('RESET_TOKEN_STALE');

    const completedAt = new Date();
    const user = await tx.user.update({ where: { id: params.userId }, data: { passwordHash, sessionVersion: { increment: 1 } } });
    await tx.passwordResetRequest.update({ where: { id: request.id }, data: { completedAt } });
    await tx.passwordResetRequest.updateMany({
      where: { userId: user.id, id: { not: request.id }, completedAt: null },
      data: { completedAt },
    });
    await tx.auditLog.create({ data: { userId: user.id, action: 'PASSWORD_RESET_COMPLETED', entityType: 'USER', entityId: user.id, metadata: { sessionVersionInvalidated: true, previousSessionVersion: currentUser.sessionVersion, newSessionVersion: user.sessionVersion } } });
    await tx.notification.create({ data: { userId: user.id, type: 'SECURITY_ALERT', title: 'تم تغيير كلمة المرور', message: 'تم تغيير كلمة مرور حسابك وإلغاء جميع الجلسات السابقة.', priority: 'CRITICAL' } });
    return { id: user.id, sessionVersion: user.sessionVersion };
  });
}
