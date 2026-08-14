import { describe, expect, it } from 'vitest';
import { db } from '../lib/db';
import { confirmOwnershipTransfer } from '../lib/transfer-workflow';

const dbIt = process.env.DATABASE_URL ? it : it.skip;

describe('government reference concurrency', () => {
  dbIt('allows one sale only to claim a provider reference', async () => {
    process.env.TRAFFIC_PROVIDER_URL = 'https://traffic.test';
    process.env.TRAFFIC_PROVIDER_SECRET = 'test-secret';
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'GOV SELLER', phone: `762${suffix.slice(-7)}`, nationalId: `GOV-S-${suffix}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const buyers = await Promise.all([0, 1].map(i => db.user.create({ data: { fullName: `GOV BUYER ${i}`, phone: `763${i}${suffix.slice(-6)}`, nationalId: `GOV-B-${i}-${suffix}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } })));
    const rate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', isAutoUpdateEnabled: false, updatedBy: seller.id, updatedByName: seller.fullName } });
    const vehicles = await Promise.all([0, 1].map(i => db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `GOV-${i}-${suffix.slice(-8)}`, vin: `GOV${i}${suffix}`.slice(0,17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'PENDING', isReserved: true } })));
    const reference = `GOV-REF-${suffix}`;
    const sales = await Promise.all(vehicles.map(async (vehicle, i) => {
      const paymentReference = `PAY-GOV-${i}-${suffix}`;
      const escrowReference = `ESC-GOV-${i}-${suffix}`;
      const transferReference = i === 0 ? reference : `OTHER-${reference}`;
      const sale = await db.vehicleSale.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, sellerName: seller.fullName, sellerNationalId: seller.nationalId!, sellerPhone: seller.phone, sellerVerified: true, buyerId: buyers[i].id, buyerName: buyers[i].fullName, buyerNationalId: buyers[i].nationalId!, buyerPhone: buyers[i].phone, buyerVerified: true, buyerOtpVerified: true, sellerOtpVerified: true, paymentVerified: true, fundsSecured: true, escrowTransactionId: escrowReference, governmentReference: transferReference, vehicleAmountYER: 1000000, platformFeeUSD: 0, platformFeeYER: 0, transferFeeUSD: 80, totalPaidYER: 1042800, sellerPayoutYER: 1000000, platformRevenueYER: 42800, transferFeeYER: 42800, exchangeRate: 535, exchangeRateId: rate.id, status: 'TRANSFER_PENDING', expiresAt: new Date(Date.now() + 3600000) } });
      await db.paymentTransaction.create({ data: { userId: buyers[i].id, vehicleSaleId: sale.id, amount: sale.totalPaidYER, currency: 'YER', provider: 'TEST', providerReference: paymentReference, idempotencyKey: `IDEMP-${paymentReference}`, status: 'SUCCESS' } });
      await db.escrowTransaction.create({ data: { vehicleSaleId: sale.id, vehicleAmountYER: sale.vehicleAmountYER, platformFeeUSD: sale.platformFeeUSD, platformFeeYER: sale.platformFeeYER, transferFeeUSD: sale.transferFeeUSD, transferFeeYER: sale.transferFeeYER, listingCommissionUSD: sale.listingCommissionUSD, auctionFeeYER: sale.auctionFeeYER, governmentFeesYER: sale.governmentFeesYER, totalPaidYER: sale.totalPaidYER, sellerPayoutYER: sale.sellerPayoutYER, platformRevenueYER: sale.platformRevenueYER, exchangeRate: sale.exchangeRate, status: 'HELD', paymentProviderReference: paymentReference, escrowProviderReference: escrowReference } });
      await db.operation.create({ data: { operationNumber: `TRF-TEST-${i}-${suffix}`, type: 'TRAFFIC_TRANSFER_REQUEST', userId: seller.id, status: 'SUCCESS', idempotencyKey: `TRAFFIC:${sale.id}`, providerReference: transferReference, metadata: { saleId: sale.id } } });
      return sale;
    }));
    try {
      const results = await Promise.allSettled(sales.map(sale => confirmOwnershipTransfer(sale.id, reference)));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(await db.vehicleSale.count({ where: { governmentReference: reference } })).toBe(1);
      await db.operation.update({ where: { idempotencyKey: `TRAFFIC:${sales[0].id}` }, data: { metadata: { saleId: 'another-sale' } } });
      await expect(confirmOwnershipTransfer(sales[0].id, reference)).rejects.toThrow('TRAFFIC_TRANSFER_REQUEST_MISMATCH');
    } finally {
      await db.vehicleOwnership.deleteMany({ where: { vehicleId: { in: vehicles.map(v => v.id) } } });
      await db.operation.deleteMany({ where: { idempotencyKey: { in: sales.map(s => `TRAFFIC:${s.id}`) } } });
      await db.escrowTransaction.deleteMany({ where: { vehicleSaleId: { in: sales.map(s => s.id) } } });
      await db.paymentTransaction.deleteMany({ where: { vehicleSaleId: { in: sales.map(s => s.id) } } });
      await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: { in: sales.map(s => s.id) } } });
      await db.vehicleSale.deleteMany({ where: { id: { in: sales.map(s => s.id) } } });
      await db.vehicle.deleteMany({ where: { id: { in: vehicles.map(v => v.id) } } });
      await db.exchangeRateHistory.deleteMany({ where: { exchangeRateId: rate.id } });
      await db.exchangeRate.delete({ where: { id: rate.id } });
      await db.user.deleteMany({ where: { id: { in: [seller.id, ...buyers.map(b => b.id)] } } });
    }
  });
});
