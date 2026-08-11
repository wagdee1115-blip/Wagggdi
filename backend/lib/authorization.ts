import { createHash, randomUUID } from 'crypto';
import { db } from './db';
import { otpService } from './otp';
import { AuthorizationType } from '@prisma/client';
import { issueAuthorizationDocument } from './authorization-document';

function hashPayload(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export async function createAuthorization(params: { ownerId: string; authorizedUserId: string; vehicleId: string; type: AuthorizationType; minPrice?: number; validUntil: Date }) {
  if (params.ownerId === params.authorizedUserId) throw new Error('SELF_AUTHORIZATION_NOT_ALLOWED');
  if (params.validUntil <= new Date()) throw new Error('AUTHORIZATION_EXPIRED');
  return db.$transaction(async tx => {
    const vehicle = await tx.vehicle.findUnique({ where: { id: params.vehicleId } });
    if (!vehicle || vehicle.ownerId !== params.ownerId) throw new Error('NOT_VEHICLE_OWNER');
    const authorized = await tx.user.findUnique({ where: { id: params.authorizedUserId } });
    if (!authorized || authorized.status !== 'ACTIVE') throw new Error('AUTHORIZED_USER_NOT_ACTIVE');
    const active = await tx.vehicleAuthorization.findFirst({ where: { vehicleId: params.vehicleId, authorizedUserId: params.authorizedUserId, status: 'ACTIVE', validUntil: { gt: new Date() } } });
    if (active) throw new Error('ACTIVE_AUTHORIZATION_EXISTS');
    const authorizationNumber = `MRK-AUTH-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const qrValue = JSON.stringify({ authorizationNumber, vehicleId: params.vehicleId, ownerId: params.ownerId, authorizedUserId: params.authorizedUserId });
    const sha256Hash = hashPayload({ authorizationNumber, vehicleId: params.vehicleId, ownerId: params.ownerId, authorizedUserId: params.authorizedUserId, type: params.type, minPrice: params.minPrice ?? null, validUntil: params.validUntil.toISOString(), qrValue, termsVersion: '2026-08-11-v2' });
    return tx.vehicleAuthorization.create({ data: { authorizationNumber, vehicleId: params.vehicleId, ownerId: params.ownerId, authorizedUserId: params.authorizedUserId, type: params.type, minPrice: params.minPrice, validUntil: params.validUntil, termsVersion: '2026-08-11-v2', qrValue, sha256Hash } });
  });
}

export async function verifyAuthorizationOwnerOtp(params: { authorizationId: string; ownerId: string; otpId: string; otp: string }) {
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: params.authorizationId } });
  if (!auth || auth.ownerId !== params.ownerId) throw new Error('FORBIDDEN');
  if (auth.status !== 'PENDING' || auth.validUntil <= new Date()) throw new Error('AUTHORIZATION_NOT_ACTIVE');
  await otpService.verifyOtp({ otpId: params.otpId, otp: params.otp, operationId: auth.id, type: 'SELLER' });
  return db.vehicleAuthorization.update({ where: { id: auth.id }, data: { ownerConsentAt: new Date(), ownerOtpVerifiedAt: new Date() } });
}

export async function acceptAuthorizationByAuthorizedParty(params: { authorizationId: string; authorizedUserId: string; otpId: string; otp: string }) {
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: params.authorizationId } });
  if (!auth || auth.authorizedUserId !== params.authorizedUserId) throw new Error('FORBIDDEN');
  if (auth.status !== 'PENDING' || auth.validUntil <= new Date()) throw new Error('AUTHORIZATION_NOT_ACTIVE');
  if (!auth.ownerOtpVerifiedAt || !auth.ownerConsentAt) throw new Error('OWNER_CONSENT_REQUIRED');
  await otpService.verifyOtp({ otpId: params.otpId, otp: params.otp, operationId: auth.id, type: 'BUYER' });
  const now = new Date();
  const updated = await db.vehicleAuthorization.update({ where: { id: auth.id }, data: { status: 'ACTIVE', acceptedAt: now, authorizedOtpVerifiedAt: now } });
  try {
    return await issueAuthorizationDocument(updated.id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('NOT_CONFIGURED:')) return updated;
    throw error;
  }
}

/** Backward-compatible helper: both OTPs must be valid, but ownership and party roles are still enforced. */
export async function activateAuthorization(params: { authorizationId: string; ownerId: string; ownerOtpId: string; ownerOtp: string; authorizedOtpId: string; authorizedOtp: string }) {
  await verifyAuthorizationOwnerOtp({ authorizationId: params.authorizationId, ownerId: params.ownerId, otpId: params.ownerOtpId, otp: params.ownerOtp });
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: params.authorizationId } });
  if (!auth) throw new Error('AUTHORIZATION_NOT_FOUND');
  return acceptAuthorizationByAuthorizedParty({ authorizationId: auth.id, authorizedUserId: auth.authorizedUserId, otpId: params.authorizedOtpId, otp: params.authorizedOtp });
}

export async function revokeAuthorization(authorizationId: string, ownerId: string) {
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: authorizationId } });
  if (!auth || auth.ownerId !== ownerId) throw new Error('FORBIDDEN');
  return db.vehicleAuthorization.update({ where: { id: authorizationId }, data: { status: 'REVOKED', revokedAt: new Date() } });
}

export async function expireAuthorizations() {
  const result = await db.vehicleAuthorization.updateMany({ where: { status: 'ACTIVE', validUntil: { lte: new Date() } }, data: { status: 'EXPIRED' } });
  return result.count;
}
