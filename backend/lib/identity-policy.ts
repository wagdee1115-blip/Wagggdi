import type { IdentityStatus } from '@prisma/client';

type IdentitySubject = {
  identityStatus: IdentityStatus;
  nationalId: string | null;
};

const ACCEPTED_IDENTITY_STATUSES = new Set<IdentityStatus>([
  'VERIFIED',
  'IDENTITY_VERIFIED',
  'IDENTITY_FACE_VERIFIED',
  'ADVANCED_VERIFIED',
]);

/** A verified status is only meaningful when it is bound to a national ID. */
export function isIdentityVerified(user: IdentitySubject): boolean {
  return ACCEPTED_IDENTITY_STATUSES.has(user.identityStatus) && Boolean(user.nationalId?.trim());
}
