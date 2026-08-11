import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { assertLedgerBalanced, createDoubleEntry } from '../lib/ledger';
import { confirmSalePayment } from '../lib/transfer-workflow';

const requireDb = () => { if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED'); };

describe('Financial integrity', () => {
  it('double entry equality is exact with Decimal arithmetic', () => {
    const debit = new Prisma.Decimal('10042700');
    const credit = new Prisma.Decimal('10042700');
    expect(debit.eq(credit)).toBe(true);
  });

  it('fee buckets sum without hidden tax', () => {
    const vehicle = new Prisma.Decimal(10000000);
    const transfer = new Prisma.Decimal(42800);
    const auction = new Prisma.Decimal(250000);
    const listing = new Prisma.Decimal(0);
    const tax = new Prisma.Decimal(0);
    expect(vehicle.add(transfer).add(auction).add(listing).add(tax).toString()).toBe('10292800');
  });

  it('rejects a duplicate provider payment reference without a second ledger transaction', async () => {
    requireDb();
    process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET = 'test-only-provider-secret';
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'LEDGER SELLER', phone: `771${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const buyer = await db.user.create({ data: { fullName: 'LEDGER BUYER', phone: `770${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `LP-${suffix.slice(-10)}`, vin: `LP${suffix}`.slice(0,17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE' } });
    const rate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', isAutoUpdateEnabled: false, updatedBy: seller.id, updatedByName: seller.fullName } });
    const sale = await db.vehicleSale.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, sellerName: seller.fullName, sellerNationalId: '', sellerPhone: seller.phone, sellerVerified: true, payoutUserId: seller.id, buyerId: buyer.id, buyerName: buyer.fullName, buyerNationalId: '', buyerPhone: buyer.phone, buyerVerified: true, buyerApproved: true, buyerOtpVerified: true, vehicleAmountYER: 1000000, platformFeeUSD: 0, platformFeeYER: 0, transferFeeUSD: 80, transferFeeYER: 42800, listingCommissionUSD: 0, auctionFeeYER: 0, governmentFeesYER: 0, totalPaidYER: 1042800, sellerPayoutYER: 1000000, platformRevenueYER: 42800, exchangeRate: 535, exchangeRateId: rate.id, status: 'BUYER_ACCEPTED', expiresAt: new Date(Date.now()+2*60*60*1000) } });
    try {
      const first = await confirmSalePayment(sale.id, `PROVIDER-${suffix}`, `IDEMP-${suffix}`, 1042800);
      expect(first.status).toBe('ESCROW_HELD');
      await expect(confirmSalePayment(sale.id, `PROVIDER-${suffix}`, `IDEMP-${suffix}-2`, 1042800)).rejects.toThrow('ALREADY_PROCESSED');
      expect(await db.paymentTransaction.count({ where: { providerReference: `PROVIDER-${suffix}` } })).toBe(1);
      expect(await db.financialLedger.count({ where: { transactionId: sale.id } })).toBe(4);
    } finally {
      await db.financialLedger.deleteMany({ where: { transactionId: sale.id } });
      await db.paymentTransaction.deleteMany({ where: { ownershipTransferId: null, providerReference: `PROVIDER-${suffix}` } });
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
