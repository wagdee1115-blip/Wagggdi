import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createHmac } from 'crypto';
import { db } from '../lib/db';
import { assertLedgerBalanced, createDoubleEntry } from '../lib/ledger';
import { confirmEscrowHeld, confirmSalePayment, processSaleRefund, queueSaleRefund } from '../lib/transfer-workflow';
import { POST as escrowWebhook } from '../app/api/escrow/webhook/route';

const dbIt = process.env.DATABASE_URL ? it : it.skip;

describe('Financial integrity', () => {
  dbIt('posts the inclusive transfer fee once, rejects mismatches, and refunds idempotently', async () => {
    process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET = 'test-only-provider-secret';
    process.env.ESCROW_PROVIDER_URL = 'https://escrow.test';
    process.env.ESCROW_PROVIDER_SECRET = 'test-only-escrow-secret';
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'LEDGER SELLER', phone: `771${suffix.slice(-7)}`, nationalId: `LEDGER-S-${suffix}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const buyer = await db.user.create({ data: { fullName: 'LEDGER BUYER', phone: `770${suffix.slice(-7)}`, nationalId: `LEDGER-B-${suffix}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `LP-${suffix.slice(-10)}`, vin: `LP${suffix}`.slice(0,17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE' } });
    const rate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', isAutoUpdateEnabled: false, updatedBy: seller.id, updatedByName: seller.fullName } });
    const platformFeeYER = new Prisma.Decimal(0);
    const transferFeeYER = new Prisma.Decimal(80).mul(rate.usdToYer);
    const totalPaidYER = new Prisma.Decimal(1000000).add(platformFeeYER).add(transferFeeYER);
    const sale = await db.vehicleSale.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, sellerName: seller.fullName, sellerNationalId: seller.nationalId!, sellerPhone: seller.phone, sellerVerified: true, payoutUserId: seller.id, buyerId: buyer.id, buyerName: buyer.fullName, buyerNationalId: buyer.nationalId!, buyerPhone: buyer.phone, buyerVerified: true, buyerApproved: true, buyerOtpVerified: true, sellerOtpVerified: true, vehicleAmountYER: 1000000, platformFeeUSD: 0, platformFeeYER, transferFeeUSD: 80, transferFeeYER, listingCommissionUSD: 0, auctionFeeYER: 0, governmentFeesYER: 0, totalPaidYER, sellerPayoutYER: 1000000, platformRevenueYER: transferFeeYER, exchangeRate: 535, exchangeRateId: rate.id, status: 'BUYER_ACCEPTED', expiresAt: new Date(Date.now()+2*60*60*1000) } });
    try {
      expect(platformFeeYER.toString()).toBe('0');
      expect(transferFeeYER.toString()).toBe('42800');
      expect(totalPaidYER.toString()).toBe('1042800');

      const providerReference = `PROVIDER-${suffix}`;
      const idempotencyKey = `IDEMP-${suffix}`;
      const first = await confirmSalePayment(sale.id, providerReference, idempotencyKey, totalPaidYER);
      expect(first.status).toBe('PAYMENT_CONFIRMED');
      expect(first.fundsSecured).toBe(false);
      expect(await db.financialLedger.count({ where: { transactionId: sale.id } })).toBe(0);

      await db.paymentTransaction.update({ where: { vehicleSaleId: sale.id }, data: { status: 'FAILED' } });
      await expect(confirmEscrowHeld({ saleId: sale.id, escrowProviderReference: `ESCROW-FAILED-PAYMENT-${suffix}`, paymentProviderReference: providerReference, amountYER: totalPaidYER, currency: 'YER' })).rejects.toThrow('ESCROW_PAYMENT_MISMATCH');
      await db.paymentTransaction.update({ where: { vehicleSaleId: sale.id }, data: { status: 'SUCCESS' } });

      const otherSale = await db.vehicleSale.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, sellerName: seller.fullName, sellerNationalId: seller.nationalId!, sellerPhone: seller.phone, sellerVerified: true, payoutUserId: seller.id, buyerId: buyer.id, buyerName: buyer.fullName, buyerNationalId: buyer.nationalId!, buyerPhone: buyer.phone, buyerVerified: true, buyerApproved: true, buyerOtpVerified: true, sellerOtpVerified: true, vehicleAmountYER: 1000000, platformFeeUSD: 0, platformFeeYER, transferFeeUSD: 80, transferFeeYER, listingCommissionUSD: 0, auctionFeeYER: 0, governmentFeesYER: 0, totalPaidYER, sellerPayoutYER: 1000000, platformRevenueYER: transferFeeYER, exchangeRate: 535, exchangeRateId: rate.id, status: 'BUYER_ACCEPTED', expiresAt: new Date(Date.now()+2*60*60*1000) } });
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
      expect(platformEntries).toHaveLength(0);
      const transferGroup = `FEE:TRANSFER:${sale.id}`;

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
      expect(await db.financialLedger.count({ where: { entryGroupId: transferGroup } })).toBe(2);

      await expect(confirmSalePayment(sale.id, providerReference, idempotencyKey, 1)).rejects.toThrow('PAYMENT_AMOUNT_MISMATCH');
      await expect(confirmSalePayment(sale.id, `PROVIDER-OTHER-${suffix}`, idempotencyKey, totalPaidYER)).rejects.toThrow('PAYMENT_PROVIDER_REFERENCE_MISMATCH');
      await expect(confirmSalePayment(sale.id, providerReference, `IDEMP-OTHER-${suffix}`, totalPaidYER)).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
      expect(await db.paymentTransaction.count({ where: { providerReference } })).toBe(1);
      // ESCROW capture + one inclusive TRANSFER fee, two balanced legs each.
      expect(await db.financialLedger.count({ where: { transactionId: sale.id } })).toBe(4);

      await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: otherSale.id } });
      await db.paymentTransaction.deleteMany({ where: { vehicleSaleId: otherSale.id } });
      await db.vehicleSale.delete({ where: { id: otherSale.id } });

      const second = await db.vehicleSale.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, sellerName: seller.fullName, sellerNationalId: seller.nationalId!, sellerPhone: seller.phone, sellerVerified: true, payoutUserId: seller.id, buyerId: buyer.id, buyerName: buyer.fullName, buyerNationalId: buyer.nationalId!, buyerPhone: buyer.phone, buyerVerified: true, buyerApproved: true, buyerOtpVerified: true, sellerOtpVerified: true, vehicleAmountYER: 1000000, platformFeeUSD: 0, platformFeeYER, transferFeeUSD: 80, transferFeeYER, listingCommissionUSD: 0, auctionFeeYER: 0, governmentFeesYER: 0, totalPaidYER, sellerPayoutYER: 1000000, platformRevenueYER: transferFeeYER, exchangeRate: 535, exchangeRateId: rate.id, status: 'BUYER_ACCEPTED', expiresAt: new Date(Date.now()+2*60*60*1000) } });
      try {
        await expect(confirmSalePayment(second.id, providerReference, `IDEMP-CROSS-${suffix}`, totalPaidYER)).rejects.toThrow('ALREADY_PROCESSED');
        await expect(confirmSalePayment(second.id, `PROVIDER-CROSS-${suffix}`, idempotencyKey, totalPaidYER)).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
      } finally {
        await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: second.id } });
        await db.vehicleSale.delete({ where: { id: second.id } });
      }

      process.env.PAYMENT_PROVIDER_URL = 'https://payments.test/refunds';
      process.env.PAYMENT_PROVIDER_API_SECRET = 'test-only-refund-secret';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'REFUNDED', providerReference: `REFUND-PROVIDER-${suffix}` }), { status: 200, headers: { 'content-type': 'application/json' } }));
      try {
        const pending = await queueSaleRefund(sale.id, 'TEST_REFUND', seller.id);
        expect(pending.status).toBe('REFUND_PENDING');
        const refunded = await processSaleRefund(sale.id, seller.id);
        expect(refunded.status).toBe('REFUNDED');
        expect((await db.paymentTransaction.findUniqueOrThrow({ where: { vehicleSaleId: sale.id } })).status).toBe('REFUNDED');
        expect((await db.escrowTransaction.findUniqueOrThrow({ where: { vehicleSaleId: sale.id } })).status).toBe('REFUNDED');
        expect((await assertLedgerBalanced(`REFUND:${sale.id}`)).balanced).toBe(true);
        expect((await assertLedgerBalanced(`REFUND:FEE:TRANSFER:${sale.id}`)).balanced).toBe(true);
        const replay = await processSaleRefund(sale.id, seller.id);
        expect(replay.status).toBe('REFUNDED');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally { fetchSpy.mockRestore(); }
    } finally {
      // A failed assertion can occur while one of the deliberately-created
      // secondary sales still exists. Clean every sale owned by this unique
      // fixture so teardown preserves the original failure instead of masking
      // it with VehicleSale_vehicleId_fkey.
      const saleIds = (await db.vehicleSale.findMany({ where: { vehicleId: vehicle.id }, select: { id: true } })).map(({ id }) => id);
      await db.notification.deleteMany({ where: { operationId: { in: saleIds } } });
      await db.financialLedger.deleteMany({ where: { transactionId: { in: saleIds } } });
      await db.escrowTransaction.deleteMany({ where: { vehicleSaleId: { in: saleIds } } });
      await db.paymentTransaction.deleteMany({ where: { vehicleSaleId: { in: saleIds } } });
      await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: { in: saleIds } } });
      await db.salePayment.deleteMany({ where: { vehicleSaleId: { in: saleIds } } });
      await db.paymentReceipt.deleteMany({ where: { vehicleSaleId: { in: saleIds } } });
      await db.saleContract.deleteMany({ where: { vehicleSaleId: { in: saleIds } } });
      await db.vehicleSale.deleteMany({ where: { id: { in: saleIds } } });
      await db.exchangeRateHistory.deleteMany({ where: { exchangeRateId: rate.id } });
      await db.exchangeRate.delete({ where: { id: rate.id } });
      await db.vehicle.delete({ where: { id: vehicle.id } });
      await db.user.deleteMany({ where: { id: { in: [seller.id, buyer.id] } } });
    }
  });

  dbIt('persists balanced double-entry groups and remains idempotent under concurrent writers', async () => {
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
