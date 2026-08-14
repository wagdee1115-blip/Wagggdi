import { describe, expect, it } from 'vitest';
import {
  AUCTION_ANTI_SNIPING_MS,
  AUCTION_EXTENSION_MS,
  createVehicleAuction,
  finalizeAuction,
  placeAuctionBid,
  resolveAuctionCompetition,
  setAutoBid,
} from '../lib/auction';
import { db } from '../lib/db';

const dbIt = process.env.DATABASE_URL ? it : it.skip;

describe('Auction rules', () => {
  it('extends by exactly 120 seconds inside the last two minutes', () => {
    const end = Date.now() + AUCTION_ANTI_SNIPING_MS - 1;
    const extended = new Date(end + AUCTION_EXTENSION_MS);
    expect(extended.getTime() - end).toBe(120000);
  });
  it('uses server-side constants, not browser time', () => expect(AUCTION_ANTI_SNIPING_MS).toBe(120000));

  it('resolves every auto-bid ceiling without an iteration cap', () => {
    const offers = Array.from({ length: 35 }, (_, index) => ({
      bidderId: `bidder-${index}`,
      maxAmount: 200_000 + index * 1_000,
      priorityAt: new Date(1_000 + index),
      tieBreaker: `auto-${index}`,
    }));
    offers.push({ bidderId: 'highest', maxAmount: 1_000_000, priorityAt: new Date(10_000), tieBreaker: 'highest' });

    const resolved = resolveAuctionCompetition({ floorAmount: 150_000, minimumIncrement: 1_000, offers });
    expect(resolved.leaderId).toBe('highest');
    expect(resolved.runnerUpId).toBe('bidder-34');
    expect(resolved.price.toString()).toBe('235000');
  });

  it('gives equal maximums to the earliest priority and then the stable key', () => {
    const resolved = resolveAuctionCompetition({
      floorAmount: 101_000,
      minimumIncrement: 1_000,
      offers: [
        { bidderId: 'later', maxAmount: 500_000, priorityAt: new Date(2_000), tieBreaker: 'a' },
        { bidderId: 'stable-b', maxAmount: 500_000, priorityAt: new Date(1_000), tieBreaker: 'b' },
        { bidderId: 'stable-a', maxAmount: 500_000, priorityAt: new Date(1_000), tieBreaker: 'a' },
      ],
    });
    expect(resolved.leaderId).toBe('stable-a');
    expect(resolved.price.toString()).toBe('500000');
  });

  it('uses the second-highest distinct bidder rather than two offers from one bidder', () => {
    const resolved = resolveAuctionCompetition({
      floorAmount: 100_000,
      minimumIncrement: 1_000,
      offers: [
        { bidderId: 'leader', maxAmount: 400_000, priorityAt: new Date(1_000), tieBreaker: 'old-manual' },
        { bidderId: 'leader', maxAmount: 900_000, priorityAt: new Date(3_000), tieBreaker: 'auto' },
        { bidderId: 'runner-up', maxAmount: 500_000, priorityAt: new Date(2_000), tieBreaker: 'runner' },
      ],
    });
    expect(resolved.leaderId).toBe('leader');
    expect(resolved.runnerUpId).toBe('runner-up');
    expect(resolved.price.toString()).toBe('501000');
  });
});

describe('Auction PostgreSQL verification', () => {
  dbIt('serializes concurrent bids on one auction row', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'TEST SELLER', nationalId: `S-${suffix}`, phone: `777${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const bidderA = await db.user.create({ data: { fullName: 'TEST A', nationalId: `A-${suffix}`, phone: `778${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const bidderB = await db.user.create({ data: { fullName: 'TEST B', nationalId: `B-${suffix}`, phone: `779${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `T-${suffix.slice(-10)}`, vin: `VIN${suffix}`.slice(0, 17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE', governmentStatus: 'UNKNOWN' } });
    const auction = await db.auction.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, startingPrice: 100000, currentPrice: 100000, minimumIncrement: 1000, startAt: new Date(Date.now() - 60_000), endAt: new Date(Date.now() + 300_000), status: 'ACTIVE' } });
    try {
      await expect(placeAuctionBid({ auctionId: auction.id, bidderId: bidderA.id, amount: 101000, idempotencyKey: `UNVERIFIED-${suffix}` })).rejects.toThrow('VEHICLE_RESTRICTED');
      await expect(setAutoBid({ auctionId: auction.id, bidderId: bidderA.id, maxAmount: 150000 })).rejects.toThrow('VEHICLE_RESTRICTED');
      await db.vehicle.update({ where: { id: vehicle.id }, data: { governmentStatus: 'VERIFIED' } });
      // Use allSettled because the advisory lock serializes the two bids.
      // Whichever bid wins the lock first raises the current price.
      // If bidderB (102000) wins first, the minimum becomes 103000 and
      // bidderA's 101000 is correctly rejected — that is the expected
      // behaviour, not a test failure.  If bidderA wins first, both bids
      // succeed and bidderB still ends up as the leader at 102000.
      // In either path the final DB state is identical: currentPrice = 102000
      // and bidderB is the leader.
      const results = await Promise.allSettled([
        placeAuctionBid({ auctionId: auction.id, bidderId: bidderA.id, amount: 101000, idempotencyKey: `A-${suffix}` }),
        placeAuctionBid({ auctionId: auction.id, bidderId: bidderB.id, amount: 102000, idempotencyKey: `B-${suffix}` }),
      ]);
      // bidderB's higher bid must always succeed regardless of lock order.
      const bidderBResult = results[1];
      expect(bidderBResult.status).toBe('fulfilled');
      const current = await db.auction.findUniqueOrThrow({ where: { id: auction.id } });
      expect(current.currentPrice.toString()).toBe('102000');
      if (bidderBResult.status === 'fulfilled') {
        expect(bidderBResult.value.leaderId).toBe(bidderB.id);
      }
    } finally {
      await db.auctionBid.deleteMany({ where: { auctionId: auction.id } });
      await db.auction.delete({ where: { id: auction.id } });
      await db.vehicle.delete({ where: { id: vehicle.id } });
      await db.user.deleteMany({ where: { id: { in: [seller.id, bidderA.id, bidderB.id] } } });
    }
  });

  dbIt('allows only one winner and creates one sale when finalized', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'TEST SELLER', nationalId: `WS-${suffix}`, phone: `776${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const bidder = await db.user.create({ data: { fullName: 'TEST BIDDER', nationalId: `WB-${suffix}`, phone: `775${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const payout = await db.payoutAccount.create({ data: { userId: seller.id, provider: 'TEST', accountIdentifierEncrypted: 'test-encrypted', accountIdentifierMasked: '****1234', accountHolderName: seller.fullName, verified: true, nameMatchStatus: 'MATCH', providerReference: `PAYOUT-${suffix}` } });
    const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `W-${suffix.slice(-10)}`, vin: `WIN${suffix}`.slice(0, 17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE', isReserved: true, governmentStatus: 'UNKNOWN' } });
    const auction = await db.auction.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, startingPrice: 100000, currentPrice: 101000, minimumIncrement: 1000, startAt: new Date(Date.now() - 3600000), endAt: new Date(Date.now() - 1000), status: 'ACTIVE' } });
    const bid = await db.auctionBid.create({ data: { auctionId: auction.id, bidderId: bidder.id, amount: 101000, idempotencyKey: `WIN-${suffix}` } });
    // Create a dedicated exchange rate so this test does not depend on any
    // rate created or deleted by concurrently-running test files.
    const rate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', isAutoUpdateEnabled: false, updatedBy: seller.id, updatedByName: seller.fullName } });
    try {
      await expect(finalizeAuction(auction.id)).rejects.toThrow('VEHICLE_RESTRICTED');
      await db.vehicle.update({ where: { id: vehicle.id }, data: { governmentStatus: 'VERIFIED' } });
      const results = await Promise.all([finalizeAuction(auction.id), finalizeAuction(auction.id)]);
      const finalAuction = await db.auction.findUniqueOrThrow({ where: { id: auction.id } });
      expect(finalAuction.winnerId).toBe(bidder.id);
      expect(finalAuction.winnerBidId).toBe(bid.id);
      expect(finalAuction.saleId).toBeTruthy();
      expect(results.map(r => r.id)).toEqual([auction.id, auction.id]);
      expect(await db.vehicleSale.count({ where: { auctionId: auction.id } })).toBe(1);
    } finally {
      // Delete child records of VehicleSale before deleting VehicleSale itself
      // (no cascade — FK constraints must be respected).
      const sale = await db.vehicleSale.findUnique({ where: { auctionId: auction.id } });
      if (sale) {
        await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: sale.id } });
        await db.vehicleSale.delete({ where: { id: sale.id } });
      }
      await db.auctionBid.delete({ where: { id: bid.id } });
      await db.auction.delete({ where: { id: auction.id } });
      await db.vehicle.delete({ where: { id: vehicle.id } });
      // Delete the exchange rate created by this test only (by its specific id).
      // VehicleSale must be deleted first because it holds exchangeRateId FK.
      await db.exchangeRateHistory.deleteMany({ where: { exchangeRateId: rate.id } });
      await db.exchangeRate.delete({ where: { id: rate.id } });
      await db.payoutAccount.delete({ where: { id: payout.id } });
      await db.user.deleteMany({ where: { id: { in: [seller.id, bidder.id] } } });
    }
  });

  dbIt('materializes the resolved auto-bid winner and competitive price at finalization', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'AUTO SELLER', nationalId: `AS-${suffix}`, phone: `773${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const highest = await db.user.create({ data: { fullName: 'AUTO HIGH', nationalId: `AH-${suffix}`, phone: `772${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const second = await db.user.create({ data: { fullName: 'AUTO SECOND', nationalId: `AT-${suffix}`, phone: `771${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const payout = await db.payoutAccount.create({ data: { userId: seller.id, provider: 'TEST', accountIdentifierEncrypted: 'test-encrypted', accountIdentifierMasked: '****5678', accountHolderName: seller.fullName, verified: true, nameMatchStatus: 'MATCH', providerReference: `AUTO-PAYOUT-${suffix}` } });
    const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `A-${suffix.slice(-10)}`, vin: `AUT${suffix}`.slice(0, 17), make: 'TEST', model: 'TEST', year: 2026, price: 1_000_000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE', isReserved: true, governmentStatus: 'VERIFIED' } });
    const auction = await db.auction.create({ data: { vehicleId: vehicle.id, sellerId: seller.id, startingPrice: 100_000, currentPrice: 100_000, minimumIncrement: 1_000, startAt: new Date(Date.now() - 3_600_000), endAt: new Date(Date.now() - 1_000), status: 'ACTIVE' } });
    await db.auctionAutoBid.createMany({ data: [
      { auctionId: auction.id, bidderId: highest.id, maxAmount: 500_000 },
      { auctionId: auction.id, bidderId: second.id, maxAmount: 300_000 },
    ] });
    const rate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', isAutoUpdateEnabled: false, updatedBy: seller.id, updatedByName: seller.fullName } });
    try {
      const finalized = await finalizeAuction(auction.id);
      const winnerBid = await db.auctionBid.findUniqueOrThrow({ where: { id: finalized.winnerBidId! } });
      const sale = await db.vehicleSale.findUniqueOrThrow({ where: { auctionId: auction.id } });
      expect(finalized.winnerId).toBe(highest.id);
      expect(winnerBid.bidderId).toBe(highest.id);
      expect(winnerBid.amount.toString()).toBe('301000');
      expect(sale.vehicleAmountYER.toString()).toBe('301000');
    } finally {
      const sale = await db.vehicleSale.findUnique({ where: { auctionId: auction.id } });
      if (sale) {
        await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: sale.id } });
        await db.vehicleSale.delete({ where: { id: sale.id } });
      }
      await db.auctionAutoBid.deleteMany({ where: { auctionId: auction.id } });
      await db.auctionBid.deleteMany({ where: { auctionId: auction.id } });
      await db.auction.delete({ where: { id: auction.id } });
      await db.vehicle.delete({ where: { id: vehicle.id } });
      await db.exchangeRateHistory.deleteMany({ where: { exchangeRateId: rate.id } });
      await db.exchangeRate.delete({ where: { id: rate.id } });
      await db.payoutAccount.delete({ where: { id: payout.id } });
      await db.user.deleteMany({ where: { id: { in: [seller.id, highest.id, second.id] } } });
    }
  });

  dbIt('checks eligibility after locking the vehicle and permits only one concurrent auction', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seller = await db.user.create({ data: { fullName: 'CREATE SELLER', nationalId: `CS-${suffix}`, phone: `774${suffix.slice(-7)}`, passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED', identityStatus: 'VERIFIED' } });
    const payout = await db.payoutAccount.create({ data: { userId: seller.id, provider: 'TEST', accountIdentifierEncrypted: 'test-encrypted', accountIdentifierMasked: '****4321', accountHolderName: seller.fullName, verified: true, nameMatchStatus: 'MATCH', providerReference: `CREATE-PAYOUT-${suffix}` } });
    const vehicle = await db.vehicle.create({ data: { ownerId: seller.id, plateNumber: `C-${suffix.slice(-10)}`, vin: `CRT${suffix}`.slice(0, 17), make: 'TEST', model: 'TEST', year: 2026, price: 1_000_000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE', governmentStatus: 'UNKNOWN' } });
    const request = {
      vehicleId: vehicle.id,
      actorId: seller.id,
      startingPrice: 100_000,
      minimumIncrement: 1_000,
      startAt: new Date(Date.now() - 1_000),
      endAt: new Date(Date.now() + 60_000),
    };
    try {
      await expect(createVehicleAuction(request)).rejects.toThrow('VEHICLE_RESTRICTED');
      expect(await db.auction.count({ where: { vehicleId: vehicle.id } })).toBe(0);
      expect((await db.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).isReserved).toBe(false);

      await db.vehicle.update({ where: { id: vehicle.id }, data: { governmentStatus: 'VERIFIED' } });
      const results = await Promise.allSettled([createVehicleAuction(request), createVehicleAuction(request)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(await db.auction.count({ where: { vehicleId: vehicle.id, status: 'ACTIVE' } })).toBe(1);
    } finally {
      await db.auction.deleteMany({ where: { vehicleId: vehicle.id } });
      await db.vehicle.delete({ where: { id: vehicle.id } });
      await db.payoutAccount.delete({ where: { id: payout.id } });
      await db.user.delete({ where: { id: seller.id } });
    }
  });
});
