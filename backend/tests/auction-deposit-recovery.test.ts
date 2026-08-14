import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../lib/db';
import { AUCTION_DEPOSIT_PENDING_STALE_MS, holdAuctionDeposit } from '../lib/auction-deposit';

const requireDb = () => { if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED'); };
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

async function seed() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const seller = await db.user.create({ data: { fullName: 'DEPOSIT SELLER', phone: `761${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE' } });
  const bidder = await db.user.create({ data: { fullName: 'DEPOSIT BIDDER', phone: `762${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE' } });
  const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `D-${suffix.slice(-10)}`, vin: `DEP${suffix}`.slice(0, 17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE' } });
  const auction = await db.auction.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, startingPrice: 100000, currentPrice: 100000, startAt: new Date(Date.now() - 1000), endAt: new Date(Date.now() + 60000), status: 'ACTIVE', bidDepositAmount: 10000 } });
  return { seller, bidder, vehicle, auction };
}

async function cleanup(ctx: Awaited<ReturnType<typeof seed>>) {
  await db.financialLedger.deleteMany({ where: { relatedOperationId: ctx.auction.id } });
  await db.auctionBidDeposit.deleteMany({ where: { auctionId: ctx.auction.id } });
  await db.auction.delete({ where: { id: ctx.auction.id } });
  await db.vehicle.delete({ where: { id: ctx.vehicle.id } });
  await db.user.deleteMany({ where: { id: { in: [ctx.seller.id, ctx.bidder.id] } } });
}

describe('auction deposit recovery', () => {
  it('serializes concurrent initial requests into one provider hold and one ledger group', async () => {
    requireDb();
    process.env.AUCTION_DEPOSIT_PROVIDER_URL = 'https://deposit.test';
    process.env.AUCTION_DEPOSIT_PROVIDER_SECRET = 'test-secret';
    const ctx = await seed();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const keys: string[] = [];
    global.fetch = vi.fn(async (_url, init) => { keys.push(JSON.parse(String(init?.body)).idempotencyKey); await gate; return new Response(JSON.stringify({ status: 'HOLD', providerReference: 'HOLD-CONCURRENT' }), { status: 200 }); });
    try {
      const first = holdAuctionDeposit({ auctionId: ctx.auction.id, bidderId: ctx.bidder.id });
      while (keys.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
      const second = await holdAuctionDeposit({ auctionId: ctx.auction.id, bidderId: ctx.bidder.id });
      expect(second.deposit.status).toBe('PENDING');
      release();
      expect((await first).deposit.status).toBe('HOLD');
      expect(keys).toEqual([`AUCTION_DEPOSIT:${ctx.auction.id}:${ctx.bidder.id}`]);
      expect(await db.auctionBidDeposit.count({ where: { auctionId: ctx.auction.id, bidderId: ctx.bidder.id } })).toBe(1);
      expect(await db.financialLedger.count({ where: { entryGroupId: { startsWith: 'BID_DEPOSIT:' } , relatedOperationId: ctx.auction.id } })).toBe(2);
    } finally { release(); await cleanup(ctx); }
  });

  it('reconciles a stale pending after an ambiguous provider acceptance using the same key', async () => {
    requireDb();
    process.env.AUCTION_DEPOSIT_PROVIDER_URL = 'https://deposit.test';
    process.env.AUCTION_DEPOSIT_PROVIDER_SECRET = 'test-secret';
    const ctx = await seed();
    const keys: string[] = [];
    global.fetch = vi.fn(async (_url, init) => { keys.push(JSON.parse(String(init?.body)).idempotencyKey); throw new Error('CONNECTION_LOST_AFTER_ACCEPT'); });
    try {
      await expect(holdAuctionDeposit({ auctionId: ctx.auction.id, bidderId: ctx.bidder.id })).rejects.toThrow('CONNECTION_LOST_AFTER_ACCEPT');
      const pending = await db.auctionBidDeposit.findFirstOrThrow({ where: { auctionId: ctx.auction.id, bidderId: ctx.bidder.id } });
      expect(pending.status).toBe('PENDING');
      await db.auctionBidDeposit.update({ where: { id: pending.id }, data: { updatedAt: new Date(Date.now() - AUCTION_DEPOSIT_PENDING_STALE_MS - 1000) } });
      global.fetch = vi.fn(async (_url, init) => { keys.push(JSON.parse(String(init?.body)).idempotencyKey); return new Response(JSON.stringify({ status: 'HOLD', providerReference: 'HOLD-RECOVERED' }), { status: 200 }); });
      expect((await holdAuctionDeposit({ auctionId: ctx.auction.id, bidderId: ctx.bidder.id })).deposit.status).toBe('HOLD');
      expect((await holdAuctionDeposit({ auctionId: ctx.auction.id, bidderId: ctx.bidder.id })).replayed).toBe(true);
      expect(new Set(keys).size).toBe(1);
      expect(keys).toHaveLength(2);
      expect(await db.auctionBidDeposit.count({ where: { auctionId: ctx.auction.id, bidderId: ctx.bidder.id } })).toBe(1);
      expect(await db.financialLedger.count({ where: { relatedOperationId: ctx.auction.id } })).toBe(2);
    } finally { await cleanup(ctx); }
  });
});
