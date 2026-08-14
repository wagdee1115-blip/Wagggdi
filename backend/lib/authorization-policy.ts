import { createHash } from 'crypto';
import type { AuthorizationStatus, AuthorizationType } from '@prisma/client';

export const AUTHORIZATION_TERMS_VERSION = '2026-08-14-v3';
export const MAX_AUTHORIZATION_VALIDITY_MS = 366 * 24 * 60 * 60 * 1000;

export type AuthorizationTerms = {
  authorizationNumber: string;
  vehicleId: string;
  ownerId: string;
  authorizedUserId: string;
  type: AuthorizationType;
  minPrice: string | null;
  validUntil: string;
  termsVersion: string;
};

export type AuthorizationCapabilityInput = {
  status: AuthorizationStatus;
  validUntil: Date;
  ownerConsentAt: Date | null;
  ownerOtpVerifiedAt: Date | null;
  authorizedOtpVerifiedAt: Date | null;
};

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
}

export function authorizationTermsHash(terms: AuthorizationTerms) {
  return createHash('sha256').update(canonicalize(terms)).digest('hex');
}

export function buildAuthorizationTerms(input: {
  authorizationNumber: string;
  vehicleId: string;
  ownerId: string;
  authorizedUserId: string;
  type: AuthorizationType;
  minPrice: { toString(): string } | number | string | null | undefined;
  validUntil: Date;
  termsVersion: string;
}): AuthorizationTerms {
  return {
    authorizationNumber: input.authorizationNumber,
    vehicleId: input.vehicleId,
    ownerId: input.ownerId,
    authorizedUserId: input.authorizedUserId,
    type: input.type,
    minPrice: input.minPrice === null || input.minPrice === undefined ? null : input.minPrice.toString(),
    validUntil: input.validUntil.toISOString(),
    termsVersion: input.termsVersion,
  };
}

export function assertAuthorizationValidityWindow(validUntil: Date, now = new Date()) {
  if (Number.isNaN(validUntil.getTime()) || validUntil <= now) throw new Error('AUTHORIZATION_EXPIRY_REQUIRED');
  if (validUntil.getTime() - now.getTime() > MAX_AUTHORIZATION_VALIDITY_MS) throw new Error('AUTHORIZATION_VALIDITY_TOO_LONG');
}

export function getAuthorizationCapabilities(input: AuthorizationCapabilityInput, now = new Date()) {
  const expired = input.validUntil <= now || input.status === 'EXPIRED';
  const pending = input.status === 'PENDING' && !expired;
  const ownerConsented = Boolean(input.ownerConsentAt && input.ownerOtpVerifiedAt);
  return {
    effectiveStatus: expired && ['PENDING', 'ACTIVE'].includes(input.status) ? 'EXPIRED' as const : input.status,
    ownerConsented,
    authorizedConsented: Boolean(input.authorizedOtpVerifiedAt),
    canOwnerRequestOtp: pending && !ownerConsented,
    canAuthorizedRequestOtp: pending && ownerConsented,
    canAuthorizedReject: pending,
    canOwnerRevoke: pending || (input.status === 'ACTIVE' && !expired),
    canPrint: Boolean(input.authorizedOtpVerifiedAt) && ['ACTIVE', 'REVOKED', 'EXPIRED'].includes(expired ? 'EXPIRED' : input.status),
  };
}

export function maskAuthorizationPhone(phone: string) {
  const compact = phone.trim();
  if (compact.length <= 6) return '***';
  return `${compact.slice(0, 3)}***${compact.slice(-3)}`;
}

export function maskAuthorizationNationalId(nationalId: string | null) {
  if (!nationalId) return 'غير متاح';
  const compact = nationalId.trim();
  if (compact.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, compact.length - 4))}${compact.slice(-4)}`;
}
