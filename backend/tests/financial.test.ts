import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { createHmac } from 'crypto';
import { db } from '../lib/db';
import { assertLedgerBalanced, createDoubleEntry } from '../lib/ledger';
import { confirmEscrowHeld, confirmSalePayment } from '../lib/transfer-workflow';
import { POST as escrowWebhook } from '../app/api/escrow/webhook/route';

const requireDb = () => { if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED'); };

describe('Financial integrity', () => {
  it('posts the approved platform fee once and remains idempotent for duplicate payment delivery', async () => {
    requireDb();
    process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET = 'test-only-provider-secret';
    process.env.ESCROW_PROVIDER_URL = 'https://escrow.test';
    process.env.ESCROW_PROVIDER_SECRET = 'test-only-escrow-secret';
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'LEDGER SELLER', phone: `771${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const buyer = await db.user.create({ data: { fullName: 'LEDGER BUYER', phone: `770${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `LP-${suffix.slice(-10)}`, vin: `LP${suffix}`.slice(0,17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE' } });
    const rate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', isAutoUpdateEnabled: false, updatedBy: seller.id, updatedByName: seller.fullName } });
    const platformFeeYER = new Prisma.Decimal(20).mul(rate.usdToYer);
    const transferFeeYER = new Prisma.Decimal(80).mul(rate.usdToYer);
    const totalPaidYER = new Prisma.Decimal(1000000).add(platformFeeYER).add(transferFeeYER);
    const sale = await db.vehicleSale.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, sellerName: seller.fullName, sellerNationalId: '', sellerPhone: seller.phone, sellerVerified: true, payoutUserId: seller.id, buyerId: buyer.id, buyerName: buyer.fullName, buyerNationalId: '', buyerPhone: buyer.phone, buyerVerified: true, buyerApproved: true, buyerOtpVerified: true, vehicleAmountYER: 1000000, platformFeeUSD: 20, platformFeeYER, transferFeeUSD: 80, transferFeeYER, listingCommissionUSD: 0, auctionFeeYER: 0, governmentFeesYER: 0, totalPaidYER, sellerPayoutYER: 1000000, platformRevenueYER: platformFeeYER.add(transferFeeYER), exchangeRate: 535, exchangeRateId: rate.id, status: 'BUYER_ACCEPTED', expiresAt: new Date(Date.now()+2*60*60*1000) } });
    try {
      expect(platformFeeYER.toString()).toBe('10700');
      expect(transferFeeYER.toString()).toBe('42800');
      expect(totalPaidYER.toString()).toBe('1053500');

      const providerReference = `PROVIDER-${suffix}`;
      const idempotencyKey = `IDEMP-${suffix}`;
      const first = await confirmSalePayment(sale.id, providerReference, idempotencyKey, totalPaidYER);
      expect(first.status).toBe('PAYMENT_CONFIRMED');
      expect(first.fundsSecured).toBe(false);
      expect(await db.financialLedger.count({ where: { transactionId: sale.id } })).toBe(0);

      const otherSale = await db.vehicleSale.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, sellerName: seller.fullName, sellerNationalId: '', sellerPhone: seller.phone, sellerVerified: true, payoutUserId: seller.id, buyerId: buyer.id, buyerName: buyer.fullName, buyerNationalId: '', buyerPhone: buyer.phone, buyerVerified: true, buyerApproved: true, buyerOtpVerified: true, vehicleAmountYER: 1000000, platformFeeUSD: 20, platformFeeYER, transferFeeUSD: 80, transferFeeYER, listingCommissionUSD: 0, auctionFeeYER: 0, governmentFeesYER: 0, totalPaidYER, sellerPayoutYER: 1000000, platformRevenueYER: platformFeeYER.add(transferFeeYER), exchangeRate: 535, exchangeRateId: rate.id, status: 'BUYER_ACCEPTED', expiresAt: new Date(Date.now()+2*60*60*1000) } });
      const otherPaymentReference = `PROVIDER-OTHER-SALE-${suffix}`;
      await confirmSalePayment(otherSale.id, otherPaymentReference, `IDEMP-OTHER-SALE-${suffix}`, totalPaidYER);
      await expect(confirmEscrowHeld({ saleId: sale.id, escrowProviderReference: `ESCROW-WRONG-${suffix}`, paymentProviderReference: otherPaymentReference, amountYER: totalPaidYER, currency: 'YER' })).rejects.toThrow('ESCROW_PAYMENT_MISMATCH');

      const escrowReference = `ESCROW-${suffix}`;
      const held = await confirmEscrowHeld({ saleId: sale.id, escrowProviderReference: escrowReference, paymentProviderReference: providerReference, amountYER: totalPaidYER, currency: 'YER' });
      expect(held.status).toBe('ESCROW_HELD');
      expect(held.fundsSecured).toBe(true);
      const escrowRecord = await db.escrowTransaction.findUniqueOrThrow({ where: { vehicleSaleId: sale.id } });
      expect(escrowRecord.paymentProviderReference).toBe(providerReference);
      expect(escrowRecord.escrowProviderReference).toBe(escrowReference);
      await expect(confirmEscrowHeld({ saleId: otherSale.id, escrowProviderReference: escrowReference, paymentProviderReference: otherPaymentReference, amountYER: totalPaidYER, currency: 'YER' })).rejects.toThrow('ESCROW_PROVIDER_REFERENCE_REPLAY');

      const platformGroup = `FEE:PLATFORM:${sale.id}`;
      const platformEntries = await db.financialLedger.findMany({ where: { entryGroupId: platformGroup }, orderBy: { direction: 'asc' } });
      expect(platformEntries).toHaveLength(2);
      expect(platformEntries.every(entry => entry.amount.eq(platformFeeYER))).toBe(true);
      expect(platformEntries.map(entry => entry.entryType).sort()).toEqual(['ESCROW_FUNDS', 'PLATFORM_FEES']);
      expect(platformEntries.map(entry => entry.direction).sort()).toEqual(['CREDIT', 'DEBIT']);
      expect((await assertLedgerBalanced(platformGroup)).balanced).toBe(true);

      const replay = await confirmSalePayment(sale.id, providerReference, idempotencyKey, totalPaidYER);
      expect(replay.status).toBe('ESCROW_HELD');
      const escrowReplay = await confirmEscrowHeld({ saleId: sale.id, escrowProviderReference: escrowReference, paymentProviderReference: providerReference, amountYER: totalPaidYER, currency: 'YER' });
      expect(escrowReplay.status).toBe('ESCROW_HELD');
      const webhookBody = JSON.stringify({ status: 'HELD', saleId: sale.id, escrowProviderReference: escrowReference, paymentProviderReference: providerReference, amountYER: Number(totalPaidYER), currency: 'YER' });
      const webhookSignature = createHmac('sha256', process.env.ESCROW_PROVIDER_SECRET!).update(webhookBody).digest('hex');
      for (let replay = 0; replay < 2; replay++) {
        const response = await escrowWebhook(new Request('https://markabat.test/api/escrow/webhook', { method: 'POST', headers: { 'x-escrow-signature': webhookSignature }, body: webhookBody }));
        expect(response.status).toBe(200);
        expect((await response.json()).status).toBe('ESCROW_HELD');
      }
      expect(await db.financialLedger.count({ where: { entryGroupId: platformGroup } })).toBe(2);

      await expect(confirmSalePayment(sale.id, providerReference, idempotencyKey, 1)).rejects.toThrow('PAYMENT_AMOUNT_MISMATCH');
      await expect(confirmSalePayment(sale.id, `PROVIDER-OTHER-${suffix}`, idempotencyKey, totalPaidYER)).rejects.toThrow('PAYMENT_PROVIDER_REFERENCE_MISMATCH');
      await expect(confirmSalePayment(sale.id, providerReference, `IDEMP-OTHER-${suffix}`, totalPaidYER)).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
      expect(await db.paymentTransaction.count({ where: { providerReference } })).toBe(1);
      // PAYMENT + PLATFORM_FEE + TRANSFER_FEE, each represented by two balanced ledger legs.
      expect(await db.financialLedger.count({ where: { transactionId: sale.id } })).toBe(6);

      await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: otherSale.id } });
      await db.paymentTransaction.deleteMany({ where: { vehicleSaleId: otherSale.id } });
      await db.vehicleSale.delete({ where: { id: otherSale.id } });

      const second = await db.vehicleSale.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, sellerName: seller.fullName, sellerNationalId: '', sellerPhone: seller.phone, sellerVerified: true, payoutUserId: seller.id, buyerId: buyer.id, buyerName: buyer.fullName, buyerNationalId: '', buyerPhone: buyer.phone, buyerVerified: true, buyerApproved: true, buyerOtpVerified: true, vehicleAmountYER: 1000000, platformFeeUSD: 20, platformFeeYER, transferFeeUSD: 80, transferFeeYER, listingCommissionUSD: 0, auctionFeeYER: 0, governmentFeesYER: 0, totalPaidYER, sellerPayoutYER: 1000000, platformRevenueYER: platformFeeYER.add(transferFeeYER), exchangeRate: 535, exchangeRateId: rate.id, status: 'BUYER_ACCEPTED', expiresAt: new Date(Date.now()+2*60*60*1000) } });
      try {
        await expect(confirmSalePayment(second.id, providerReference, `IDEMP-CROSS-${suffix}`, totalPaidYER)).rejects.toThrow('ALREADY_PROCESSED');
        await expect(confirmSalePayment(second.id, `PROVIDER-CROSS-${suffix}`, idempotencyKey, totalPaidYER)).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
      } finally {
        await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: second.id } });
        await db.vehicleSale.delete({ where: { id: second.id } });
      }
    } finally {
      await db.financialLedger.deleteMany({ where: { transactionId: sale.id } });
      await db.escrowTransaction.deleteMany({ where: { vehicleSaleId: sale.id } });
      await db.paymentTransaction.deleteMany({ where: { vehicleSaleId: sale.id } });
      await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: sale.id } });
      await db.salePayment.deleteMany({ where: { vehicleSaleId: sale.id } });
      await db.paymentReceipt.deleteMany({ where: { vehicleSaleId: sale.id } });
      await db.saleContract.deleteMany({ where: { vehicleSaleId: sale.id } });
      await db.vehicleSale.delete({ where: { id: sale.id } });
      await db.exchangeRateHistory.deleteMany({ where: { exchangeRateId: rate.id } });
      await db.exchangeRate.delete({ where: { id: rate.id } });
      await db.vehicle.delete({ where: { id: vehicle.id } });
      await db.user.deleteMany({ where: { id: { in: [seller.id, buyer.id] } } });
    }
  });

  it('persists balanced double-entry groups and remains idempotent under concurrent writers', async () => {
    requireDb();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const entryGroupId = `TEST:LEDGER:${suffix}`;
    try {
      const results = await Promise.all([
        createDoubleEntry({ transactionId: suffix, entryGroupId, amount: 1000, currency: 'YER', debitType: 'CUSTOMER_FUNDS', creditType: 'ESCROW_FUNDS', idempotencyKey: `LEDGER:${suffix}` }),
        createDoubleEntry({ transactionId: suffix, entryGroupId, amount: 1000, currency: 'YER', debitType: 'CUSTOMER_FUNDS', creditType: 'ESCROW_FUNDS', idempotencyKey: `LEDGER:${suffix}` }),
      ]);
      expect(results.filter(x => !x.replayed)).toHaveLength(1);
      expect(results.filter(x => x.replayed)).toHaveLength(1);
      const balanced = await assertLedgerBalanced(entryGroupId);
      expect(balanced.balanced).toBe(true);
    } finally {
      await db.financialLedger.deleteMany({ where: { entryGroupId } });
    }
  });
});
