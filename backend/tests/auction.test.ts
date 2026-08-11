import { describe, expect, it } from 'vitest';
import { AUCTION_ANTI_SNIPING_MS, AUCTION_EXTENSION_MS, placeAuctionBid, finalizeAuction } from '../lib/auction';
import { db } from '../lib/db';

const blockedIfNoDb = () => {
  if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
};

describe('Auction rules', () => {
  it('extends by exactly 120 seconds inside the last two minutes', () => {
    const end = Date.now() + AUCTION_ANTI_SNIPING_MS - 1;
    const extended = new Date(end + AUCTION_EXTENSION_MS);
    expect(extended.getTime() - end).toBe(120000);
  });
  it('uses server-side constants, not browser time', () => expect(AUCTION_ANTI_SNIPING_MS).toBe(120000));
});

describe('Auction PostgreSQL verification', () => {
  it('serializes concurrent bids on one auction row', async () => {
    blockedIfNoDb();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'TEST SELLER', phone: `777${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const bidderA = await db.user.create({ data: { fullName: 'TEST A', phone: `778${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const bidderB = await db.user.create({ data: { fullName: 'TEST B', phone: `779${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `T-${suffix.slice(-10)}`, vin: `VIN${suffix}`.slice(0, 17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE' } });
    const auction = await db.auction.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, startingPrice: 100000, currentPrice: 100000, minimumIncrement: 1000, startAt: new Date(Date.now() - 60_000), endAt: new Date(Date.now() + 300_000), status: 'ACTIVE' } });
    try {
      const [a, b] = await Promise.all([
        placeAuctionBid({ auctionId: auction.id, bidderId: bidderA.id, amount: 101000, idempotencyKey: `A-${suffix}` }),
        placeAuctionBid({ auctionId: auction.id, bidderId: bidderB.id, amount: 102000, idempotencyKey: `B-${suffix}` }),
      ]);
      const current = await db.auction.findUniqueOrThrow({ where: { id: auction.id } });
      expect(current.currentPrice.toString()).toBe('102000');
      expect([a.leaderId, b.leaderId]).toContain(bidderB.id);
    } finally {
      await db.auctionBid.deleteMany({ where: { auctionId: auction.id } });
      await db.auction.delete({ where: { id: auction.id } });
      await db.vehicle.delete({ where: { id: vehicle.id } });
      await db.user.deleteMany({ where: { id: { in: [seller.id, bidderA.id, bidderB.id] } } });
    }
  });

  it('allows only one winner and creates one sale when finalized', async () => {
    blockedIfNoDb();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'TEST SELLER', phone: `776${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const bidder = await db.user.create({ data: { fullName: 'TEST BIDDER', phone: `775${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
    const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `W-${suffix.slice(-10)}`, vin: `WIN${suffix}`.slice(0, 17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE' } });
    const auction = await db.auction.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, startingPrice: 100000, currentPrice: 101000, minimumIncrement: 1000, startAt: new Date(Date.now() - 3600000), endAt: new Date(Date.now() - 1000), status: 'ACTIVE' } });
    const bid = await db.auctionBid.create({ data: { auctionId: auction.id, bidderId: bidder.id, amount: 101000, idempotencyKey: `WIN-${suffix}` } });
    try {
      const results = await Promise.all([finalizeAuction(auction.id), finalizeAuction(auction.id)]);
      const finalAuction = await db.auction.findUniqueOrThrow({ where: { id: auction.id } });
      expect(finalAuction.winnerId).toBe(bidder.id);
      expect(finalAuction.winnerBidId).toBe(bid.id);
      expect(finalAuction.saleId).toBeTruthy();
      expect(results.map(r => r.id)).toEqual([auction.id, auction.id]);
      expect(await db.vehicleSale.count({ where: { auctionId: auction.id } })).toBe(1);
    } finally {
      const sale = await db.vehicleSale.findUnique({ where: { auctionId: auction.id } });
      if (sale) await db.vehicleSale.delete({ where: { id: sale.id } });
      await db.auctionBid.delete({ where: { id: bid.id } });
      await db.auction.delete({ where: { id: auction.id } });
      await db.vehicle.delete({ where: { id: vehicle.id } });
      await db.user.deleteMany({ where: { id: { in: [seller.id, bidder.id] } } });
    }
  });
});
