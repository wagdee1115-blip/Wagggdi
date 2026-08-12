import { describe, expect, it } from 'vitest';
import { db } from '../lib/db';
import { createOwnershipTransfer } from '../lib/transfer-workflow';

async function seed(tag: string, opts: { payout: 'NONE' | 'VALID' | 'UNVERIFIED' | 'VERIFIED_NAME_MISMATCH' }) {
  const seller = await db.user.create({ data: { fullName: 'PG SELLER', phone: `771${tag.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
  const buyer = await db.user.create({ data: { fullName: 'PG BUYER', phone: `770${tag.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
  const payout = opts.payout === 'NONE' ? null : await db.payoutAccount.create({ data: {
    userId: seller.id, provider: 'TEST_BANK', accountIdentifierEncrypted: 'test-encrypted', accountIdentifierMasked: '****0002',
    accountHolderName: seller.fullName,
    verified: opts.payout === 'VALID' || opts.payout === 'VERIFIED_NAME_MISMATCH',
    nameMatchStatus: opts.payout === 'VALID' ? 'MATCH' : 'PENDING',
    providerReference: `PG-${tag}`,
  } });
  const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `PG-${tag.slice(-10)}`, vin: `PGRD${tag}`.slice(0, 17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE' } });
  const rate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', isAutoUpdateEnabled: false, updatedBy: seller.id, updatedByName: seller.fullName } });
  return { seller, buyer, payout, vehicle, rate };
}

async function cleanup(ctx: Awaited<ReturnType<typeof seed>>) {
  const sales = await db.vehicleSale.findMany({ where: { vehicleId: ctx.vehicle.id }, select: { id: true } });
  if (sales.length) await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: { in: sales.map(x => x.id) } } });
  await db.vehicleSale.deleteMany({ where: { vehicleId: ctx.vehicle.id } });
  await db.exchangeRateHistory.deleteMany({ where: { exchangeRateId: ctx.rate.id } });
  await db.exchangeRate.delete({ where: { id: ctx.rate.id } });
  await db.vehicle.delete({ where: { id: ctx.vehicle.id } });
  if (ctx.payout) await db.payoutAccount.delete({ where: { id: ctx.payout.id } });
  await db.user.deleteMany({ where: { id: { in: [ctx.seller.id, ctx.buyer.id] } } });
}

describe('Payout account guard on sale creation', () => {
  it('rejects sale when seller has no payout account, without side effects', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const ctx = await seed(String(Date.now()), { payout: 'NONE' });
    try {
      await expect(createOwnershipTransfer({ vehicleId: ctx.vehicle.id, sellerId: ctx.seller.id, buyerId: ctx.buyer.id, salePrice: 1000000 }))
        .rejects.toThrow('PAYOUT_ACCOUNT_REQUIRED');
      // No orphan sale, no lock leak, no payment, no ledger entry.
      expect(await db.vehicleSale.count({ where: { vehicleId: ctx.vehicle.id } })).toBe(0);
      const v = await db.vehicle.findUniqueOrThrow({ where: { id: ctx.vehicle.id } });
      expect(v.isReserved).toBe(false);
      expect(v.status).toBe('ACTIVE');
      expect(await db.salePayment.count({ where: { vehicleSale: { vehicleId: ctx.vehicle.id } } })).toBe(0);
      expect(await db.financialLedger.count({ where: { userId: { in: [ctx.seller.id, ctx.buyer.id] } } })).toBe(0);
    } finally {
      await cleanup(ctx);
    }
  });

  it('rejects sale when payout account exists but is not verified/matched', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const ctx = await seed(String(Date.now() + 1), { payout: 'UNVERIFIED' });
    try {
      await expect(createOwnershipTransfer({ vehicleId: ctx.vehicle.id, sellerId: ctx.seller.id, buyerId: ctx.buyer.id, salePrice: 1000000 }))
        .rejects.toThrow('PAYOUT_ACCOUNT_REQUIRED');
      const v = await db.vehicle.findUniqueOrThrow({ where: { id: ctx.vehicle.id } });
      expect(v.isReserved).toBe(false);
      expect(await db.vehicleSale.count({ where: { vehicleId: ctx.vehicle.id } })).toBe(0);
    } finally {
      await cleanup(ctx);
    }
  });

  it('rejects sale with PAYOUT_REVIEW_REQUIRED when account is verified but name not matched', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const ctx = await seed(String(Date.now() + 3), { payout: 'VERIFIED_NAME_MISMATCH' });
    try {
      await expect(createOwnershipTransfer({ vehicleId: ctx.vehicle.id, sellerId: ctx.seller.id, buyerId: ctx.buyer.id, salePrice: 1000000 }))
        .rejects.toThrow('PAYOUT_REVIEW_REQUIRED');
      const v = await db.vehicle.findUniqueOrThrow({ where: { id: ctx.vehicle.id } });
      expect(v.isReserved).toBe(false);
      expect(v.status).toBe('ACTIVE');
      expect(await db.vehicleSale.count({ where: { vehicleId: ctx.vehicle.id } })).toBe(0);
      expect(await db.salePayment.count({ where: { vehicleSale: { vehicleId: ctx.vehicle.id } } })).toBe(0);
      expect(await db.financialLedger.count({ where: { userId: { in: [ctx.seller.id, ctx.buyer.id] } } })).toBe(0);
    } finally {
      await cleanup(ctx);
    }
  });

  it('allows sale when seller has a verified, name-matched payout account', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const ctx = await seed(String(Date.now() + 2), { payout: 'VALID' });
    try {
      const sale = await createOwnershipTransfer({ vehicleId: ctx.vehicle.id, sellerId: ctx.seller.id, buyerId: ctx.buyer.id, salePrice: 1000000 });
      expect(sale.id).toBeTruthy();
      const v = await db.vehicle.findUniqueOrThrow({ where: { id: ctx.vehicle.id } });
      expect(v.isReserved).toBe(true);
      expect(v.status).toBe('PENDING');
    } finally {
      await cleanup(ctx);
    }
  });
});
