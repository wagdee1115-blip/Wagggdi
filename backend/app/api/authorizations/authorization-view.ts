import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getAuthorizationCapabilities, maskAuthorizationPhone } from '@/lib/authorization-policy';

export const authorizationViewSelect = {
  id: true,
  authorizationNumber: true,
  type: true,
  status: true,
  minPrice: true,
  validUntil: true,
  termsVersion: true,
  sha256Hash: true,
  acceptedAt: true,
  ownerConsentAt: true,
  ownerOtpVerifiedAt: true,
  authorizedOtpVerifiedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
  ownerId: true,
  authorizedUserId: true,
  owner: { select: { fullName: true, phone: true } },
  authorizedUser: { select: { fullName: true, phone: true } },
  vehicle: {
    select: {
      id: true,
      plateNumber: true,
      vin: true,
      make: true,
      model: true,
      year: true,
      color: true,
      city: true,
      status: true,
      isReserved: true,
      hasLegalBlock: true,
      governmentStatus: true,
    },
  },
} satisfies Prisma.VehicleAuthorizationSelect;

type AuthorizationViewRow = Prisma.VehicleAuthorizationGetPayload<{ select: typeof authorizationViewSelect }>;

function maskVin(vin: string) {
  return vin.length <= 6 ? '••••••' : `${'•'.repeat(Math.min(10, vin.length - 6))}${vin.slice(-6)}`;
}

export function serializeAuthorization(row: AuthorizationViewRow, viewerId: string, now = new Date()) {
  const viewerRole = row.ownerId === viewerId ? 'OWNER' as const : 'AUTHORIZED' as const;
  const capabilities = getAuthorizationCapabilities(row, now);
  return {
    id: row.id,
    authorizationNumber: row.authorizationNumber,
    viewerRole,
    type: row.type,
    status: capabilities.effectiveStatus,
    minPrice: row.minPrice?.toString() ?? null,
    validUntil: row.validUntil.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    owner: { fullName: row.owner.fullName, phoneMasked: maskAuthorizationPhone(row.owner.phone) },
    authorizedParty: { fullName: row.authorizedUser.fullName, phoneMasked: maskAuthorizationPhone(row.authorizedUser.phone) },
    vehicle: {
      id: row.vehicle.id,
      plateNumber: row.vehicle.plateNumber,
      vinMasked: maskVin(row.vehicle.vin),
      make: row.vehicle.make,
      model: row.vehicle.model,
      year: row.vehicle.year,
      color: row.vehicle.color,
      city: row.vehicle.city,
      status: row.vehicle.status,
      isReserved: row.vehicle.isReserved,
      hasLegalBlock: row.vehicle.hasLegalBlock,
      governmentStatus: row.vehicle.governmentStatus,
    },
    consent: {
      ownerVerified: capabilities.ownerConsented,
      authorizedVerified: capabilities.authorizedConsented,
      ownerVerifiedAt: row.ownerOtpVerifiedAt?.toISOString() ?? null,
      authorizedVerifiedAt: row.authorizedOtpVerifiedAt?.toISOString() ?? null,
    },
    capabilities: {
      canOwnerRequestOtp: viewerRole === 'OWNER' && capabilities.canOwnerRequestOtp,
      canAuthorizedRequestOtp: viewerRole === 'AUTHORIZED' && capabilities.canAuthorizedRequestOtp,
      canAuthorizedReject: viewerRole === 'AUTHORIZED' && capabilities.canAuthorizedReject,
      canOwnerRevoke: viewerRole === 'OWNER' && capabilities.canOwnerRevoke,
      canPrint: capabilities.canPrint,
    },
    integrity: { termsVersion: row.termsVersion, sha256: row.sha256Hash },
    printUrl: capabilities.canPrint ? `/api/authorizations/${row.id}/document` : null,
  };
}

export async function listAuthorizationViews(viewerId: string) {
  const rows = await db.vehicleAuthorization.findMany({
    where: { OR: [{ ownerId: viewerId }, { authorizedUserId: viewerId }] },
    select: authorizationViewSelect,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return rows.map(row => serializeAuthorization(row, viewerId));
}

export async function getAuthorizationView(authorizationId: string, viewerId: string) {
  const row = await db.vehicleAuthorization.findFirst({
    where: { id: authorizationId, OR: [{ ownerId: viewerId }, { authorizedUserId: viewerId }] },
    select: authorizationViewSelect,
  });
  return row ? serializeAuthorization(row, viewerId) : null;
}

const PUBLIC_ERROR_CODES = new Set([
  'AUTHORIZATION_NOT_FOUND', 'AUTHORIZATION_EXPIRED', 'AUTHORIZATION_NOT_PENDING', 'AUTHORIZATION_STATE_CHANGED',
  'AUTHORIZATION_CANNOT_BE_REVOKED', 'AUTHORIZATION_ALREADY_ACCEPTED', 'AUTHORIZATION_EXPIRY_REQUIRED',
  'AUTHORIZATION_VALIDITY_TOO_LONG', 'SELF_AUTHORIZATION_NOT_ALLOWED', 'INVALID_MIN_PRICE', 'INVALID_INPUT',
  'NOT_VEHICLE_OWNER', 'VEHICLE_NOT_AVAILABLE', 'VEHICLE_RESTRICTED', 'LIVE_AUTHORIZATION_EXISTS',
  'OWNER_NOT_ACTIVE', 'OWNER_PHONE_NOT_VERIFIED', 'OWNER_IDENTITY_NOT_VERIFIED',
  'AUTHORIZED_NOT_ACTIVE', 'AUTHORIZED_PHONE_NOT_VERIFIED', 'AUTHORIZED_IDENTITY_NOT_VERIFIED',
  'OWNER_CONSENT_REQUIRED', 'OWNER_CONSENT_ALREADY_RECORDED', 'FORBIDDEN', 'RATE_LIMITED',
  'OTP_RESEND_TOO_SOON', 'OTP_PHONE_RATE_LIMIT', 'OTP_IP_RATE_LIMIT', 'OTP_DEVICE_RATE_LIMIT', 'OTP_USER_RATE_LIMIT',
  'OTP_NOT_FOUND', 'OTP_MISMATCH', 'OTP_USER_MISMATCH', 'OTP_REPLAY', 'OTP_EXPIRED', 'OTP_MAX_ATTEMPTS', 'OTP_INVALID',
  'NOT_CONFIGURED:SMS_PROVIDER_REQUIRED', 'NOT_CONFIGURED:AUTHORIZATION_DOCUMENT_STORAGE_REQUIRED',
  'AUTHORIZATION_DOCUMENT_UPLOAD_FAILED', 'AUTHORIZATION_DOCUMENT_URL_MISSING', 'AUTHORIZATION_DOCUMENT_NOT_AVAILABLE',
  'AUTHORIZATION_INTEGRITY_FAILED', 'AUTHORIZATION_DOCUMENT_STORAGE_URL_INVALID', 'AUTHORIZATION_DOCUMENT_URL_INVALID',
]);

export function authorizationErrorResponse(error: unknown, fallback: string, options?: { hideAuthorizedEligibility?: boolean }) {
  let message = error instanceof Error ? error.message : fallback;
  if (options?.hideAuthorizedEligibility && message.startsWith('AUTHORIZED_')) message = 'AUTHORIZED_PARTY_NOT_ELIGIBLE';
  if (!PUBLIC_ERROR_CODES.has(message) && message !== 'AUTHORIZED_PARTY_NOT_ELIGIBLE') message = fallback;
  const status = message === 'FORBIDDEN' ? 403
    : message === 'AUTHORIZATION_NOT_FOUND' ? 404
      : message === 'RATE_LIMITED' ? 429
        : message.startsWith('NOT_CONFIGURED:') ? 503
          : message.endsWith('_URL_INVALID') ? 503
            : ['AUTHORIZATION_DOCUMENT_UPLOAD_FAILED', 'AUTHORIZATION_DOCUMENT_URL_MISSING'].includes(message) ? 502
              : ['LIVE_AUTHORIZATION_EXISTS', 'AUTHORIZATION_STATE_CHANGED', 'AUTHORIZATION_NOT_PENDING', 'AUTHORIZATION_EXPIRED', 'AUTHORIZATION_CANNOT_BE_REVOKED', 'OWNER_CONSENT_REQUIRED', 'OWNER_CONSENT_ALREADY_RECORDED', 'AUTHORIZATION_ALREADY_ACCEPTED', 'AUTHORIZATION_DOCUMENT_NOT_AVAILABLE', 'AUTHORIZATION_INTEGRITY_FAILED'].includes(message) || message.endsWith('_NOT_VERIFIED') || message.endsWith('_NOT_ACTIVE') || message === 'AUTHORIZED_PARTY_NOT_ELIGIBLE' ? 409
                : message === fallback ? 500 : 400;
  return Response.json({ ok: false, error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}
