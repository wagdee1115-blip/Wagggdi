import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_TERMS_VERSION,
  assertAuthorizationValidityWindow,
  authorizationTermsHash,
  buildAuthorizationTerms,
  getAuthorizationCapabilities,
  maskAuthorizationNationalId,
  maskAuthorizationPhone,
} from '../lib/authorization-policy';
import {
  renderAuthorizationDocumentHtml,
  verifyAuthorizationIntegrity,
  type AuthorizationDocumentRecord,
} from '../lib/authorization-document';
import { serializeAuthorization } from '../app/api/authorizations/authorization-view';
import { AUTHORIZATION_SENSITIVE_SALE_STATUSES } from '../lib/authorization';

function activeDocument(): AuthorizationDocumentRecord {
  const input = {
    authorizationNumber: 'MRK-AUTH-2026-TEST',
    vehicleId: 'vehicle-1',
    ownerId: 'owner-1',
    authorizedUserId: 'authorized-1',
    type: 'SELL_ONLY' as const,
    minPrice: new Prisma.Decimal(1_000_000),
    validUntil: new Date('2026-10-01T00:00:00.000Z'),
    termsVersion: AUTHORIZATION_TERMS_VERSION,
  };
  const sha256Hash = authorizationTermsHash(buildAuthorizationTerms(input));
  return {
    id: 'auth-1', ...input, status: 'ACTIVE', pdfUrl: null,
    qrValue: JSON.stringify({ authorizationNumber: input.authorizationNumber, sha256Hash }), sha256Hash,
    acceptedAt: new Date('2026-08-15T00:00:00.000Z'), authorizedOtpVerifiedAt: new Date('2026-08-15T00:00:00.000Z'),
    revokedAt: null, createdAt: new Date('2026-08-14T00:00:00.000Z'),
    owner: { fullName: '<script>alert(1)</script>', nationalId: '123456789012', phone: '777123456' },
    authorizedUser: { fullName: 'المفوض', nationalId: '987654321098', phone: '733987654' },
    vehicle: { plateNumber: 'أ ب 123', vin: 'VIN1234567890', make: 'تويوتا', model: 'كامري', year: 2024, color: 'أبيض' },
  } as AuthorizationDocumentRecord;
}

describe('authorization policy', () => {
  it('keeps revocation effective for legacy payable sale states', () => {
    expect(AUTHORIZATION_SENSITIVE_SALE_STATUSES).toContain('WAITING_PAYMENT');
    expect(AUTHORIZATION_SENSITIVE_SALE_STATUSES).toContain('PAYMENT_PENDING_VERIFICATION');
    expect(AUTHORIZATION_SENSITIVE_SALE_STATUSES).toContain('FUNDS_SECURED');
  });

  it('allows only a future validity window no longer than one year', () => {
    const now = new Date('2026-08-14T00:00:00.000Z');
    expect(() => assertAuthorizationValidityWindow(new Date('2026-08-15T00:00:00.000Z'), now)).not.toThrow();
    expect(() => assertAuthorizationValidityWindow(new Date('2026-08-13T00:00:00.000Z'), now)).toThrow('AUTHORIZATION_EXPIRY_REQUIRED');
    expect(() => assertAuthorizationValidityWindow(new Date('2027-09-01T00:00:00.000Z'), now)).toThrow('AUTHORIZATION_VALIDITY_TOO_LONG');
  });

  it('does not make a pending or unsigned expired request printable', () => {
    const now = new Date('2026-08-14T00:00:00.000Z');
    const pending = getAuthorizationCapabilities({ status: 'PENDING', validUntil: new Date('2026-09-01T00:00:00.000Z'), ownerConsentAt: null, ownerOtpVerifiedAt: null, authorizedOtpVerifiedAt: null }, now);
    expect(pending).toMatchObject({ canOwnerRequestOtp: true, canAuthorizedRequestOtp: false, canPrint: false, effectiveStatus: 'PENDING' });
    const expiredUnsigned = getAuthorizationCapabilities({ status: 'PENDING', validUntil: new Date('2026-08-01T00:00:00.000Z'), ownerConsentAt: new Date(), ownerOtpVerifiedAt: new Date(), authorizedOtpVerifiedAt: null }, now);
    expect(expiredUnsigned).toMatchObject({ effectiveStatus: 'EXPIRED', canPrint: false });
    const active = getAuthorizationCapabilities({ status: 'ACTIVE', validUntil: new Date('2026-09-01T00:00:00.000Z'), ownerConsentAt: new Date(), ownerOtpVerifiedAt: new Date(), authorizedOtpVerifiedAt: new Date() }, now);
    expect(active.canPrint).toBe(true);
  });

  it('masks party identifiers to the minimum useful display', () => {
    expect(maskAuthorizationPhone('777123456')).toBe('777***456');
    expect(maskAuthorizationNationalId('123456789012')).toBe('********9012');
    expect(maskAuthorizationNationalId(null)).toBe('غير متاح');
  });

  it('binds the integrity hash to immutable authorization terms', () => {
    const auth = activeDocument();
    expect(verifyAuthorizationIntegrity(auth)).toBe(true);
    expect(verifyAuthorizationIntegrity({ ...auth, minPrice: new Prisma.Decimal(2_000_000) })).toBe(false);
  });

  it('renders a safe non-government printable summary without full party identifiers', () => {
    const html = renderAuthorizationDocumentHtml(activeDocument());
    expect(html).toContain('ليس وثيقة حكومية');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('123456789012');
    expect(html).not.toContain('777123456');
    expect(html).not.toContain('owner-1');
    expect(html).not.toContain('authorized-1');
  });

  it('serializes participant views without raw phones, party ids, QR data, or document URLs', () => {
    const record = activeDocument();
    const view = serializeAuthorization({
      id: record.id,
      authorizationNumber: record.authorizationNumber,
      type: record.type,
      status: record.status,
      minPrice: record.minPrice,
      validUntil: record.validUntil,
      termsVersion: record.termsVersion,
      sha256Hash: record.sha256Hash,
      acceptedAt: record.acceptedAt,
      ownerConsentAt: record.acceptedAt,
      ownerOtpVerifiedAt: record.acceptedAt,
      authorizedOtpVerifiedAt: record.authorizedOtpVerifiedAt,
      revokedAt: record.revokedAt,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      ownerId: record.ownerId,
      authorizedUserId: record.authorizedUserId,
      owner: { fullName: record.owner.fullName, phone: record.owner.phone },
      authorizedUser: { fullName: record.authorizedUser.fullName, phone: record.authorizedUser.phone },
      vehicle: { id: record.vehicleId, ...record.vehicle, city: 'صنعاء', status: 'ACTIVE', isReserved: false, hasLegalBlock: false, governmentStatus: 'VERIFIED' },
    }, record.ownerId, new Date('2026-08-20T00:00:00.000Z'));
    const json = JSON.stringify(view);
    expect(json).not.toContain(record.owner.phone);
    expect(json).not.toContain(record.authorizedUser.phone);
    expect(json).not.toContain(record.ownerId);
    expect(json).not.toContain(record.authorizedUserId);
    expect(json).not.toContain('qrValue');
    expect(json).not.toContain('pdfUrl');
    expect(view.owner.phoneMasked).toBe('777***456');
  });
});
