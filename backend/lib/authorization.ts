import { randomUUID } from 'crypto';
import type { AuthorizationType, SaleStatus, User } from '@prisma/client';
import { db } from './db';
import { isIdentityVerified } from './identity-policy';
import { otpService } from './otp';
import {
  AUTHORIZATION_TERMS_VERSION,
  assertAuthorizationValidityWindow,
  authorizationTermsHash,
  buildAuthorizationTerms,
} from './authorization-policy';

export const AUTHORIZATION_SENSITIVE_SALE_STATUSES = [
  'SALE_CREATED',
  'BUYER_PENDING',
  'BUYER_ACCEPTED',
  'PAYMENT_PROCESSING',
  'PAYMENT_CONFIRMED',
  'ESCROW_HELD',
  'TRANSFER_PENDING',
  'TRANSFER_IN_PROGRESS',
  'TRANSFER_BLOCKED',
  // Legacy states are still accepted by the runtime and must not escape the
  // revocation sweep merely because new sales no longer create them.
  'PENDING_SELLER',
  'BUYER_IDENTIFIED',
  'WAITING_BUYER_APPROVAL',
  'BUYER_APPROVED',
  'BUYER_OTP_VERIFIED',
  'WAITING_SELLER_CONFIRMATION',
  'WAITING_PAYMENT',
  'PAYMENT_PENDING_VERIFICATION',
  'PAYMENT_VERIFIED',
  'SELLER_OTP_VERIFIED',
  'FUNDS_SECURED',
] as const satisfies readonly SaleStatus[];

function assertVerifiedParty(user: Pick<User, 'status' | 'phoneStatus' | 'identityStatus' | 'nationalId'> | null, party: 'OWNER' | 'AUTHORIZED') {
  if (!user || user.status !== 'ACTIVE') throw new Error(`${party}_NOT_ACTIVE`);
  if (user.phoneStatus !== 'VERIFIED') throw new Error(`${party}_PHONE_NOT_VERIFIED`);
  if (!isIdentityVerified(user)) throw new Error(`${party}_IDENTITY_NOT_VERIFIED`);
}

function assertPendingAuthorization(auth: { status: string; validUntil: Date }) {
  if (auth.validUntil <= new Date()) throw new Error('AUTHORIZATION_EXPIRED');
  if (auth.status !== 'PENDING') throw new Error('AUTHORIZATION_NOT_PENDING');
}

export async function createAuthorization(params: {
  ownerId: string;
  authorizedUserId: string;
  vehicleId: string;
  type: AuthorizationType;
  minPrice?: number;
  validUntil: Date;
}) {
  if (params.ownerId === params.authorizedUserId) throw new Error('SELF_AUTHORIZATION_NOT_ALLOWED');
  if (params.minPrice !== undefined && (!Number.isFinite(params.minPrice) || params.minPrice <= 0)) throw new Error('INVALID_MIN_PRICE');
  assertAuthorizationValidityWindow(params.validUntil);

  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${params.vehicleId}:${params.authorizedUserId}`}))`;
    const [vehicle, authorized] = await Promise.all([
      tx.vehicle.findUnique({ where: { id: params.vehicleId }, include: { owner: true } }),
      tx.user.findUnique({ where: { id: params.authorizedUserId } }),
    ]);
    if (!vehicle || vehicle.ownerId !== params.ownerId) throw new Error('NOT_VEHICLE_OWNER');
    if (vehicle.status !== 'ACTIVE' || vehicle.isReserved) throw new Error('VEHICLE_NOT_AVAILABLE');
    if (vehicle.hasLegalBlock || vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_RESTRICTED');
    assertVerifiedParty(vehicle.owner, 'OWNER');
    assertVerifiedParty(authorized, 'AUTHORIZED');

    const live = await tx.vehicleAuthorization.findFirst({
      where: {
        vehicleId: params.vehicleId,
        authorizedUserId: params.authorizedUserId,
        status: { in: ['PENDING', 'ACTIVE'] },
        validUntil: { gt: new Date() },
      },
      select: { id: true },
    });
    if (live) throw new Error('LIVE_AUTHORIZATION_EXISTS');

    const authorizationNumber = `MRK-AUTH-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const terms = buildAuthorizationTerms({
      authorizationNumber,
      vehicleId: params.vehicleId,
      ownerId: params.ownerId,
      authorizedUserId: params.authorizedUserId,
      type: params.type,
      minPrice: params.minPrice,
      validUntil: params.validUntil,
      termsVersion: AUTHORIZATION_TERMS_VERSION,
    });
    const sha256Hash = authorizationTermsHash(terms);
    const qrValue = JSON.stringify({ authorizationNumber, sha256Hash, termsVersion: AUTHORIZATION_TERMS_VERSION });
    return tx.vehicleAuthorization.create({
      data: {
        authorizationNumber,
        vehicleId: params.vehicleId,
        ownerId: params.ownerId,
        authorizedUserId: params.authorizedUserId,
        type: params.type,
        minPrice: params.minPrice,
        validUntil: params.validUntil,
        termsVersion: AUTHORIZATION_TERMS_VERSION,
        qrValue,
        sha256Hash,
      },
    });
  });
}

export async function requestAuthorizationOtp(params: {
  authorizationId: string;
  actorId: string;
  party: 'OWNER' | 'AUTHORIZED';
  ip?: string;
  deviceId?: string;
}) {
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: params.authorizationId }, include: { owner: true, authorizedUser: true } });
  if (!auth) throw new Error('AUTHORIZATION_NOT_FOUND');
  const isOwner = params.party === 'OWNER';
  const actor = isOwner ? auth.owner : auth.authorizedUser;
  if (actor.id !== params.actorId) throw new Error('AUTHORIZATION_NOT_FOUND');
  assertPendingAuthorization(auth);
  assertVerifiedParty(actor, isOwner ? 'OWNER' : 'AUTHORIZED');

  if (isOwner) {
    if (auth.ownerConsentAt || auth.ownerOtpVerifiedAt) throw new Error('OWNER_CONSENT_ALREADY_RECORDED');
  } else {
    assertVerifiedParty(auth.owner, 'OWNER');
    if (!auth.ownerConsentAt || !auth.ownerOtpVerifiedAt) throw new Error('OWNER_CONSENT_REQUIRED');
    if (auth.authorizedOtpVerifiedAt) throw new Error('AUTHORIZATION_ALREADY_ACCEPTED');
  }

  return otpService.sendOtp({
    phone: actor.phone,
    operationId: auth.id,
    type: isOwner ? 'SELLER' : 'BUYER',
    userId: actor.id,
    ip: params.ip,
    deviceId: params.deviceId,
  });
}

export async function verifyAuthorizationOwnerOtp(params: { authorizationId: string; ownerId: string; otpId: string; otp: string }) {
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: params.authorizationId }, include: { owner: true } });
  if (!auth) throw new Error('AUTHORIZATION_NOT_FOUND');
  if (auth.ownerId !== params.ownerId) throw new Error('AUTHORIZATION_NOT_FOUND');
  assertPendingAuthorization(auth);
  assertVerifiedParty(auth.owner, 'OWNER');
  if (auth.ownerConsentAt || auth.ownerOtpVerifiedAt) throw new Error('OWNER_CONSENT_ALREADY_RECORDED');

  await otpService.verifyOtp({ otpId: params.otpId, otp: params.otp, operationId: auth.id, type: 'SELLER', userId: params.ownerId });
  return db.$transaction(async tx => {
    const updated = await tx.vehicleAuthorization.updateMany({
      where: { id: auth.id, status: 'PENDING', validUntil: { gt: new Date() }, ownerConsentAt: null, ownerOtpVerifiedAt: null },
      data: { ownerConsentAt: new Date(), ownerOtpVerifiedAt: new Date() },
    });
    if (updated.count !== 1) throw new Error('AUTHORIZATION_STATE_CHANGED');
    await tx.notification.create({
      data: {
        userId: auth.authorizedUserId,
        type: 'AUTHORIZATION',
        title: 'تفويض بانتظار موافقتك',
        message: `وافق المالك على التفويض ${auth.authorizationNumber}. راجع الشروط وأكّد قبولك برمز هاتفك.`,
        priority: 'HIGH',
        operationId: auth.id,
        data: { authorizationId: auth.id },
      },
    });
    return tx.vehicleAuthorization.findUniqueOrThrow({ where: { id: auth.id } });
  });
}

export async function acceptAuthorizationByAuthorizedParty(params: { authorizationId: string; authorizedUserId: string; otpId: string; otp: string }) {
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: params.authorizationId }, include: { owner: true, authorizedUser: true } });
  if (!auth) throw new Error('AUTHORIZATION_NOT_FOUND');
  if (auth.authorizedUserId !== params.authorizedUserId) throw new Error('AUTHORIZATION_NOT_FOUND');
  assertPendingAuthorization(auth);
  assertVerifiedParty(auth.owner, 'OWNER');
  assertVerifiedParty(auth.authorizedUser, 'AUTHORIZED');
  if (!auth.ownerOtpVerifiedAt || !auth.ownerConsentAt) throw new Error('OWNER_CONSENT_REQUIRED');

  await otpService.verifyOtp({ otpId: params.otpId, otp: params.otp, operationId: auth.id, type: 'BUYER', userId: params.authorizedUserId });
  const now = new Date();
  return db.$transaction(async tx => {
    const updated = await tx.vehicleAuthorization.updateMany({
      where: {
        id: auth.id,
        status: 'PENDING',
        validUntil: { gt: now },
        ownerConsentAt: { not: null },
        ownerOtpVerifiedAt: { not: null },
        authorizedOtpVerifiedAt: null,
      },
      data: { status: 'ACTIVE', acceptedAt: now, authorizedOtpVerifiedAt: now },
    });
    if (updated.count !== 1) throw new Error('AUTHORIZATION_STATE_CHANGED');
    await tx.notification.create({
      data: {
        userId: auth.ownerId,
        type: 'AUTHORIZATION',
        title: 'تم تفعيل التفويض',
        message: `قبل الطرف المفوض التفويض ${auth.authorizationNumber} وأصبح ساريًا حتى تاريخ انتهائه أو إلغائه.`,
        priority: 'HIGH',
        operationId: auth.id,
        data: { authorizationId: auth.id },
      },
    });
    return tx.vehicleAuthorization.findUniqueOrThrow({ where: { id: auth.id } });
  });
}

/** Backward-compatible helper with the same party-bound OTP guarantees. */
export async function activateAuthorization(params: { authorizationId: string; ownerId: string; ownerOtpId: string; ownerOtp: string; authorizedOtpId: string; authorizedOtp: string }) {
  await verifyAuthorizationOwnerOtp({ authorizationId: params.authorizationId, ownerId: params.ownerId, otpId: params.ownerOtpId, otp: params.ownerOtp });
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: params.authorizationId } });
  if (!auth) throw new Error('AUTHORIZATION_NOT_FOUND');
  return acceptAuthorizationByAuthorizedParty({ authorizationId: auth.id, authorizedUserId: auth.authorizedUserId, otpId: params.authorizedOtpId, otp: params.authorizedOtp });
}

export async function rejectAuthorization(authorizationId: string, authorizedUserId: string) {
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: authorizationId }, include: { authorizedUser: true } });
  if (!auth) throw new Error('AUTHORIZATION_NOT_FOUND');
  if (auth.authorizedUserId !== authorizedUserId) throw new Error('AUTHORIZATION_NOT_FOUND');
  assertPendingAuthorization(auth);
  assertVerifiedParty(auth.authorizedUser, 'AUTHORIZED');
  return db.$transaction(async tx => {
    const updated = await tx.vehicleAuthorization.updateMany({ where: { id: auth.id, status: 'PENDING' }, data: { status: 'REJECTED' } });
    if (updated.count !== 1) throw new Error('AUTHORIZATION_STATE_CHANGED');
    await tx.notification.create({
      data: {
        userId: auth.ownerId,
        type: 'AUTHORIZATION',
        title: 'رُفض طلب التفويض',
        message: `رفض الطرف المحدد التفويض ${auth.authorizationNumber}.`,
        priority: 'NORMAL',
        operationId: auth.id,
        data: { authorizationId: auth.id },
      },
    });
    return tx.vehicleAuthorization.findUniqueOrThrow({ where: { id: auth.id } });
  });
}

export async function revokeAuthorization(authorizationId: string, ownerId: string) {
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: authorizationId }, include: { owner: true } });
  if (!auth) throw new Error('AUTHORIZATION_NOT_FOUND');
  if (auth.ownerId !== ownerId) throw new Error('AUTHORIZATION_NOT_FOUND');
  if (auth.validUntil <= new Date()) throw new Error('AUTHORIZATION_EXPIRED');
  if (!['PENDING', 'ACTIVE'].includes(auth.status)) throw new Error('AUTHORIZATION_CANNOT_BE_REVOKED');
  assertVerifiedParty(auth.owner, 'OWNER');

  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`AUTHORIZATION:${auth.id}`}))`;
    const current = await tx.vehicleAuthorization.findUnique({ where: { id: auth.id } });
    if (!current || current.ownerId !== ownerId) throw new Error('AUTHORIZATION_NOT_FOUND');
    if (current.validUntil <= new Date()) throw new Error('AUTHORIZATION_EXPIRED');
    if (!['PENDING', 'ACTIVE'].includes(current.status)) throw new Error('AUTHORIZATION_STATE_CHANGED');
    const updated = await tx.vehicleAuthorization.updateMany({
      where: { id: current.id, status: { in: ['PENDING', 'ACTIVE'] } },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    if (updated.count !== 1) throw new Error('AUTHORIZATION_STATE_CHANGED');

    const affectedSales = await tx.vehicleSale.findMany({
      where: { authorizationId: current.id, status: { in: [...AUTHORIZATION_SENSITIVE_SALE_STATUSES] } },
      select: { id: true, status: true },
    });
    for (const sale of affectedSales) {
      await tx.vehicleSale.update({ where: { id: sale.id }, data: { status: 'MANUAL_REVIEW' } });
      await tx.saleAuditLog.create({
        data: {
          vehicleSaleId: sale.id,
          userId: ownerId,
          userName: auth.owner.fullName,
          action: 'AUTHORIZATION_REVOKED',
          oldStatus: sale.status,
          newStatus: 'MANUAL_REVIEW',
          metadata: { authorizationId: auth.id },
        },
      });
    }
    await tx.notification.create({
      data: {
        userId: auth.authorizedUserId,
        type: 'AUTHORIZATION',
        title: 'أُلغي التفويض',
        message: `ألغى المالك التفويض ${auth.authorizationNumber}. لم يعد صالحًا لبدء عمليات بيع جديدة.`,
        priority: 'HIGH',
        operationId: auth.id,
        data: { authorizationId: auth.id },
      },
    });
    return tx.vehicleAuthorization.findUniqueOrThrow({ where: { id: auth.id } });
  });
}

export async function expireAuthorizations() {
  const result = await db.vehicleAuthorization.updateMany({
    where: { status: { in: ['PENDING', 'ACTIVE'] }, validUntil: { lte: new Date() } },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}
