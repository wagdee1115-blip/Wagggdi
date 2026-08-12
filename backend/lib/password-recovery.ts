import { db } from './db';
import { otpService } from './otp';
import { hashPassword, signPasswordResetJwt } from './auth';
import { consumeRateLimit } from './rate-limit';
import { rateLimitTarget } from './request-identity';
import { createHash, randomBytes } from 'crypto';

const SENSITIVE_ROLES = new Set(['OWNER', 'SUPER_ADMIN', 'ADMIN', 'FINANCE', 'SUPPORT']);

export function hashRecoveryToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function createRecoveryToken() {
  return randomBytes(32).toString('base64url');
}

export async function requestPasswordReset(params: { phone: string; ip?: string }) {
  const recoveryToken = createRecoveryToken();
  await consumeRateLimit(`forgot-password:target:${rateLimitTarget(params.phone)}`, 5, 60 * 60 * 1000);
  if (params.ip) await consumeRateLimit(`forgot-password:ip:${params.ip}`, 10, 60 * 60 * 1000);
  const user = await db.user.findUnique({ where: { phone: params.phone } });
  if (!user) return { recoveryToken };
  const riskLevel = SENSITIVE_ROLES.has(user.role) ? 'HIGH' : 'LOW';
  const operationId = `PASSWORD_RESET:${user.id}:${Date.now()}`;
  const otp = await otpService.sendOtp({ phone: user.phone, operationId, type: 'BUYER', ip: params.ip, userId: user.id });
  await db.passwordResetRequest.create({ data: { userId: user.id, otpId: otp.otpId, operationId, recoveryTokenHash: hashRecoveryToken(recoveryToken), riskLevel, expiresAt: otp.expiresAt } });
  return { recoveryToken };
}

export async function verifyPasswordResetOtp(params: { recoveryToken: string; otp: string }) {
  const request = await db.passwordResetRequest.findUnique({ where: { recoveryTokenHash: hashRecoveryToken(params.recoveryToken) }, include: { user: true } });
  if (!request) throw new Error('RESET_REQUEST_NOT_FOUND');
  if (request.completedAt || request.verifiedAt || request.expiresAt <= new Date()) throw new Error('RESET_REQUEST_EXPIRED');

  // OTP proves possession of the registered phone first; risk controls are applied after that proof.
  await otpService.verifyOtp({ otpId: request.otpId, otp: params.otp, operationId: request.operationId, type: 'BUYER' });
  if (request.riskLevel === 'HIGH' && request.user.identityStatus !== 'IDENTITY_FACE_VERIFIED' && request.user.identityStatus !== 'ADVANCED_VERIFIED') {
    throw new Error('IDENTITY_VERIFICATION_REQUIRED');
  }

  const updated = await db.passwordResetRequest.update({ where: { id: request.id }, data: { verifiedAt: new Date() } });
  const resetToken = await signPasswordResetJwt({ sub: request.userId, resetRequestId: request.id, sessionVersion: request.user.sessionVersion });
  return { resetToken, expiresAt: updated.expiresAt };
}

export async function completePasswordReset(params: { resetRequestId: string; userId: string; password: string }) {
  const request = await db.passwordResetRequest.findUnique({ where: { id: params.resetRequestId } });
  if (!request || request.userId !== params.userId || !request.verifiedAt || request.completedAt || request.expiresAt <= new Date()) throw new Error('RESET_REQUEST_INVALID');
  const passwordHash = await hashPassword(params.password);
  return db.$transaction(async tx => {
    const user = await tx.user.update({ where: { id: params.userId }, data: { passwordHash, sessionVersion: { increment: 1 } } });
    await tx.passwordResetRequest.update({ where: { id: request.id }, data: { completedAt: new Date() } });
    await tx.auditLog.create({ data: { userId: user.id, action: 'PASSWORD_RESET_COMPLETED', entityType: 'USER', entityId: user.id, metadata: { sessionVersionInvalidated: true } } });
    await tx.notification.create({ data: { userId: user.id, type: 'SECURITY_ALERT', title: 'تم تغيير كلمة المرور', message: 'تم تغيير كلمة مرور حسابك وإلغاء الجلسات السابقة.', priority: 'CRITICAL' } });
    return user;
  });
}
