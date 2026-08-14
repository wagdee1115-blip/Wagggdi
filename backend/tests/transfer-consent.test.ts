import { describe, expect, it } from 'vitest';
import { db } from '../lib/db';
import { hashOtpForStorage } from '../lib/otp';
import { advanceSaleStatus, createOwnershipTransfer, DIRECT_SALE_EXPIRATION_MS, recordHandoverPartyConsent, verifySalePartyOtp } from '../lib/transfer-workflow';

const dbIt = process.env.DATABASE_URL ? it : it.skip;

describe('direct-sale consent boundary', () => {
  dbIt('requires verified identities and purpose-bound seller OTP before notifying or accepting handover', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'CONSENT SELLER', phone: `751${suffix.slice(-7)}`, nationalId: `CONSENT-S-${suffix}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const buyer = await db.user.create({ data: { fullName: 'CONSENT BUYER', phone: `752${suffix.slice(-7)}`, nationalId: `CONSENT-B-${suffix}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'UNVERIFIED' } });
    const attacker = await db.user.create({ data: { fullName: 'CONSENT ATTACKER', phone: `753${suffix.slice(-7)}`, nationalId: `CONSENT-X-${suffix}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const payout = await db.payoutAccount.create({ data: { userId: seller.id, provider: 'TEST', accountIdentifierEncrypted: 'encrypted', accountIdentifierMasked: '****1234', accountHolderName: seller.fullName, verified: true, nameMatchStatus: 'MATCH', providerReference: `CONSENT-PAYOUT-${suffix}` } });
    const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `CONSENT-${suffix.slice(-8)}`, vin: `CONSENT${suffix}`.slice(0, 17), make: 'TEST', model: 'TEST', year: 2026, price: 1_000_000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE', governmentStatus: 'UNKNOWN' } });
    const rate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', updatedBy: seller.id, updatedByName: seller.fullName } });
    let saleId: string | undefined;
    try {
      await expect(createOwnershipTransfer({ vehicleId: vehicle.id, sellerId: seller.id, buyerId: buyer.id, salePrice: 1_000_000 })).rejects.toThrow('VEHICLE_RESTRICTED');
      await db.vehicle.update({ where: { id: vehicle.id }, data: { governmentStatus: 'VERIFIED' } });
      await expect(createOwnershipTransfer({ vehicleId: vehicle.id, sellerId: seller.id, buyerId: buyer.id, salePrice: 1_000_000 })).rejects.toThrow('BUYER_IDENTITY_NOT_VERIFIED');
      expect((await db.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).isReserved).toBe(false);
      await db.user.update({ where: { id: buyer.id }, data: { identityStatus: 'VERIFIED' } });

      const createdAt = Date.now();
      const sale = await createOwnershipTransfer({ vehicleId: vehicle.id, sellerId: seller.id, buyerId: buyer.id, salePrice: 1_000_000 });
      saleId = sale.id;
      expect(sale.status).toBe('SALE_CREATED');
      expect(sale.sellerOtpVerified).toBe(false);
      expect(sale.platformFeeUSD).toBe(0);
      expect(sale.transferFeeUSD).toBe(80);
      expect(await db.notification.count({ where: { operationId: sale.id, userId: buyer.id } })).toBe(0);

      const otp = '4827';
      const consentOperationId = `${sale.id}:SALE_CONSENT`;
      const otpRecord = await db.otpRecord.create({ data: { operationId: consentOperationId, type: 'SELLER', phone: seller.phone, userId: seller.id, otpHash: hashOtpForStorage(otp, { userId: seller.id, operationId: consentOperationId, type: 'SELLER' }), resendAvailableAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
      await expect(verifySalePartyOtp({ saleId: sale.id, actorId: attacker.id, otpId: otpRecord.id, otp, party: 'SELLER' })).rejects.toThrow('FORBIDDEN');

      const approved = await verifySalePartyOtp({ saleId: sale.id, actorId: seller.id, otpId: otpRecord.id, otp, party: 'SELLER' });
      expect(approved.status).toBe('BUYER_PENDING');
      expect(approved.sellerOtpVerified).toBe(true);
      expect(approved.expiresAt.getTime()).toBeGreaterThanOrEqual(createdAt + DIRECT_SALE_EXPIRATION_MS);
      expect(await db.notification.count({ where: { operationId: sale.id, userId: buyer.id, type: 'TRANSFER_REQUEST' } })).toBe(1);

      const accepted = await advanceSaleStatus(sale.id, 'BUYER_ACCEPTED', buyer.id);
      expect(accepted.buyerApproved).toBe(true);

      await db.vehicleSale.update({ where: { id: sale.id }, data: { status: 'HANDOVER_PENDING' } });
      await expect(recordHandoverPartyConsent({ saleId: sale.id, actorId: seller.id, otpId: otpRecord.id, otp: '0000' }))
        .rejects.toThrow('OTP_MISMATCH');
      const handoverOtp = '5938';
      const handoverOperationId = `${sale.id}:HANDOVER`;
      const handoverRecord = await db.otpRecord.create({ data: { operationId: handoverOperationId, type: 'SELLER', phone: seller.phone, userId: seller.id, otpHash: hashOtpForStorage(handoverOtp, { userId: seller.id, operationId: handoverOperationId, type: 'SELLER' }), resendAvailableAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
      await expect(recordHandoverPartyConsent({ saleId: sale.id, actorId: seller.id, otpId: handoverRecord.id, otp: handoverOtp })).resolves.toMatchObject({ party: 'SELLER' });
      expect((await db.operation.findUniqueOrThrow({ where: { idempotencyKey: `HANDOVER_CONSENT:${sale.id}:SELLER` } })).status).toBe('SUCCESS');
      await db.operation.update({ where: { idempotencyKey: `HANDOVER_CONSENT:${sale.id}:SELLER` }, data: { providerReference: otpRecord.id } });
      await expect(recordHandoverPartyConsent({ saleId: sale.id, actorId: seller.id, otpId: otpRecord.id, otp }))
        .rejects.toThrow('HANDOVER_CONSENT_OTP_MISMATCH');
    } finally {
      if (saleId) {
        await db.notification.deleteMany({ where: { operationId: saleId } });
        await db.operation.deleteMany({ where: { idempotencyKey: { startsWith: `HANDOVER_CONSENT:${saleId}:` } } });
        await db.otpRecord.deleteMany({ where: { operationId: { startsWith: saleId } } });
        await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: saleId } });
        await db.vehicleSale.delete({ where: { id: saleId } });
      }
      await db.exchangeRateHistory.deleteMany({ where: { exchangeRateId: rate.id } });
      await db.exchangeRate.delete({ where: { id: rate.id } });
      await db.vehicle.delete({ where: { id: vehicle.id } });
      await db.payoutAccount.delete({ where: { id: payout.id } });
      await db.user.deleteMany({ where: { id: { in: [seller.id, buyer.id, attacker.id] } } });
    }
  });
});
