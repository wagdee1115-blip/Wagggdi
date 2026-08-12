import { describe, expect, it } from 'vitest';
import { db } from '../lib/db';
import { confirmOwnershipTransfer } from '../lib/transfer-workflow';

describe('government reference concurrency', () => {
  it('allows one sale only to claim a provider reference', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    process.env.TRAFFIC_PROVIDER_URL = 'https://traffic.test';
    process.env.TRAFFIC_PROVIDER_SECRET = 'test-secret';
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'GOV SELLER', phone: `762${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const buyers = await Promise.all([0, 1].map(i => db.user.create({ data: { fullName: `GOV BUYER ${i}`, phone: `763${i}${suffix.slice(-6)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } })));
    const rate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', isAutoUpdateEnabled: false, updatedBy: seller.id, updatedByName: seller.fullName } });
    const vehicles = await Promise.all([0, 1].map(i => db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `GOV-${i}-${suffix.slice(-8)}`, vin: `GOV${i}${suffix}`.slice(0,17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'PENDING', isReserved: true } })));
    const sales = await Promise.all(vehicles.map((vehicle, i) => db.vehicleSale.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, sellerName: seller.fullName, sellerNationalId: '', sellerPhone: seller.phone, sellerVerified: true, buyerId: buyers[i].id, buyerName: buyers[i].fullName, buyerNationalId: '', buyerPhone: buyers[i].phone, buyerVerified: true, sellerOtpVerified: true, vehicleAmountYER: 1000000, totalPaidYER: 1042800, sellerPayoutYER: 1000000, platformRevenueYER: 42800, transferFeeYER: 42800, exchangeRate: 535, exchangeRateId: rate.id, status: 'ESCROW_HELD', expiresAt: new Date(Date.now() + 3600000) } })));
    const reference = `GOV-REF-${suffix}`;
    try {
      const results = await Promise.allSettled(sales.map(sale => confirmOwnershipTransfer(sale.id, reference)));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(await db.vehicleSale.count({ where: { governmentReference: reference } })).toBe(1);
    } finally {
      await db.vehicleOwnership.deleteMany({ where: { vehicleId: { in: vehicles.map(v => v.id) } } });
      await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: { in: sales.map(s => s.id) } } });
      await db.vehicleSale.deleteMany({ where: { id: { in: sales.map(s => s.id) } } });
      await db.vehicle.deleteMany({ where: { id: { in: vehicles.map(v => v.id) } } });
      await db.exchangeRateHistory.deleteMany({ where: { exchangeRateId: rate.id } });
      await db.exchangeRate.delete({ where: { id: rate.id } });
      await db.user.deleteMany({ where: { id: { in: [seller.id, ...buyers.map(b => b.id)] } } });
    }
  });
});
