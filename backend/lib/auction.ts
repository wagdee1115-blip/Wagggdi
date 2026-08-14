import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { FEES, calculateAuctionFeeYer } from './fees';
import { readBoundedResponseText } from './http-bounds';
import { isIdentityVerified } from './identity-policy';
import { requireProviderEndpoint } from './provider-endpoint';

export const AUCTION_ANTI_SNIPING_MS = 120_000;
export const AUCTION_EXTENSION_MS = 120_000;
export const AUCTION_PAYMENT_DEADLINE_HOURS = 2;

const depositSettlementResponseSchema = z.object({
  status: z.enum(['REFUNDED', 'FORFEITED']),
  providerReference: z.string().trim().min(1).max(300),
});

async function parseDepositSettlementResponse(response: Response) {
  const body = await readBoundedResponseText(response, 64 * 1024, 'BID_DEPOSIT_PROVIDER_INVALID_RESPONSE');
  if (!body) throw new Error('BID_DEPOSIT_PROVIDER_INVALID_RESPONSE');
  let json: unknown;
  try { json = JSON.parse(body); } catch { throw new Error('BID_DEPOSIT_PROVIDER_INVALID_RESPONSE'); }
  const parsed = depositSettlementResponseSchema.safeParse(json);
  if (!parsed.success) throw new Error('BID_DEPOSIT_PROVIDER_INVALID_RESPONSE');
  return parsed.data;
}

function lockAuction(tx: Prisma.TransactionClient, auctionId: string) {
  return tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Auction" WHERE id = ${auctionId} FOR UPDATE`;
}

export type AuctionCompetitionOffer = {
  bidderId: string;
  maxAmount: Prisma.Decimal | number | string;
  priorityAt: Date;
  tieBreaker: string;
};

export function resolveAuctionCompetition(params: {
  floorAmount: Prisma.Decimal | number | string;
  minimumIncrement: Prisma.Decimal | number | string;
  offers: AuctionCompetitionOffer[];
}) {
  const floor = new Prisma.Decimal(params.floorAmount);
  const increment = new Prisma.Decimal(params.minimumIncrement);
  if (!floor.isFinite() || floor.lt(0) || !increment.isFinite() || increment.lte(0)) {
    throw new Error('INVALID_AUCTION_COMPETITION');
  }

  const offersByBidder = new Map<string, AuctionCompetitionOffer & { max: Prisma.Decimal }>();
  for (const offer of params.offers) {
    const max = new Prisma.Decimal(offer.maxAmount);
    const priority = offer.priorityAt.getTime();
    if (!offer.bidderId || !offer.tieBreaker || !max.isFinite() || !Number.isFinite(priority)) {
      throw new Error('INVALID_AUCTION_COMPETITION');
    }
    if (max.lt(floor)) continue;
    const current = offersByBidder.get(offer.bidderId);
    const replacesCurrent = !current
      || max.gt(current.max)
      || (max.eq(current.max) && (
        priority < current.priorityAt.getTime()
        || (priority === current.priorityAt.getTime() && offer.tieBreaker < current.tieBreaker)
      ));
    if (replacesCurrent) offersByBidder.set(offer.bidderId, { ...offer, max });
  }

  const ranked = [...offersByBidder.values()].sort((left, right) => {
    const ceilingOrder = right.max.comparedTo(left.max);
    if (ceilingOrder !== 0) return ceilingOrder;
    const priorityOrder = left.priorityAt.getTime() - right.priorityAt.getTime();
    if (priorityOrder !== 0) return priorityOrder;
    const keyOrder = left.tieBreaker === right.tieBreaker ? 0 : left.tieBreaker < right.tieBreaker ? -1 : 1;
    if (keyOrder !== 0) return keyOrder;
    return left.bidderId === right.bidderId ? 0 : left.bidderId < right.bidderId ? -1 : 1;
  });
  const leader = ranked[0];
  const runnerUp = ranked[1];
  if (!leader) return { leaderId: null, runnerUpId: null, price: floor, leaderMax: null };

  const competitivePrice = runnerUp ? runnerUp.max.add(increment) : floor;
  const price = Prisma.Decimal.min(leader.max, Prisma.Decimal.max(floor, competitivePrice));
  return {
    leaderId: leader.bidderId,
    runnerUpId: runnerUp?.bidderId ?? null,
    price,
    leaderMax: leader.max,
  };
}

export async function createVehicleAuction(params: {
  vehicleId: string;
  actorId: string;
  startingPrice: number;
  minimumIncrement: number;
  bidDepositAmount?: number;
  startAt?: Date;
  endAt: Date;
}) {
  if (!Number.isFinite(params.startingPrice) || params.startingPrice < 50_000) throw new Error('INVALID_STARTING_PRICE');
  if (!Number.isFinite(params.minimumIncrement) || params.minimumIncrement <= 0) throw new Error('INVALID_MINIMUM_INCREMENT');
  if (params.bidDepositAmount !== undefined && (
    !Number.isFinite(params.bidDepositAmount)
    || params.bidDepositAmount < 0
    || params.bidDepositAmount > params.startingPrice
  )) throw new Error('INVALID_BID_DEPOSIT');
  if (!Number.isFinite(params.endAt.getTime()) || (params.startAt && !Number.isFinite(params.startAt.getTime()))) {
    throw new Error('INVALID_AUCTION_WINDOW');
  }

  return db.$transaction(async tx => {
    await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Vehicle" WHERE id = ${params.vehicleId} FOR UPDATE`;
    const vehicle = await tx.vehicle.findUnique({
      where: { id: params.vehicleId },
      include: {
        violations: { where: { status: 'PENDING' }, select: { id: true } },
        auctions: { where: { status: { in: ['DRAFT', 'ACTIVE'] } }, select: { id: true } },
      },
    });
    if (!vehicle) throw new Error('VEHICLE_NOT_FOUND');
    await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${params.actorId} FOR SHARE`;
    const actor = await tx.user.findUnique({ where: { id: params.actorId } });
    if (!actor || actor.status !== 'ACTIVE') throw new Error('ACCOUNT_NOT_ACTIVE');
    if (actor.phoneStatus !== 'VERIFIED') throw new Error('PHONE_NOT_VERIFIED');
    if (!isIdentityVerified(actor)) throw new Error('IDENTITY_NOT_VERIFIED');
    if (vehicle.ownerId !== actor.id && !['ADMIN', 'SUPER_ADMIN', 'OWNER'].includes(actor.role)) {
      throw new Error('NOT_OWNER');
    }
    if (vehicle.status !== 'ACTIVE') throw new Error('VEHICLE_NOT_ACTIVE');
    if (vehicle.isReserved) throw new Error('VEHICLE_ALREADY_RESERVED');
    if (vehicle.hasLegalBlock || vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_RESTRICTED');
    if (vehicle.violations.length > 0) throw new Error('VEHICLE_HAS_PENDING_VIOLATIONS');
    if (vehicle.auctions.length > 0) throw new Error('VEHICLE_ALREADY_IN_AUCTION');

    const payoutAccounts = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "PayoutAccount"
      WHERE "userId" = ${vehicle.ownerId} AND verified = TRUE AND "nameMatchStatus" = 'MATCH'
      ORDER BY "updatedAt" DESC LIMIT 1 FOR SHARE
    `;
    if (payoutAccounts.length === 0) throw new Error('PAYOUT_ACCOUNT_REQUIRED');

    const now = new Date();
    const startAt = params.startAt ?? now;
    if (params.endAt <= startAt) throw new Error('INVALID_AUCTION_WINDOW');

    const reserved = await tx.vehicle.updateMany({
      where: { id: vehicle.id, ownerId: vehicle.ownerId, status: 'ACTIVE', isReserved: false },
      data: { isReserved: true },
    });
    if (reserved.count !== 1) throw new Error('VEHICLE_ALREADY_RESERVED');

    return tx.auction.create({
      data: {
        vehicleId: vehicle.id,
        sellerId: vehicle.ownerId,
        startingPrice: params.startingPrice,
        currentPrice: params.startingPrice,
        minimumIncrement: params.minimumIncrement,
        bidDepositAmount: params.bidDepositAmount ?? null,
        startAt,
        endAt: params.endAt,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        status: true,
        startAt: true,
        endAt: true,
        startingPrice: true,
        currentPrice: true,
        minimumIncrement: true,
        bidDepositAmount: true,
        bidDepositCurrency: true,
        createdAt: true,
      },
    });
  });
}

export async function placeAuctionBid(params: {
  auctionId: string;
  bidderId: string;
  amount: number;
  idempotencyKey: string;
}) {
  if (!Number.isFinite(params.amount) || params.amount <= 0) throw new Error('INVALID_BID_AMOUNT');
  return db.$transaction(async tx => {
    await lockAuction(tx, params.auctionId);
    const existing = await tx.auctionBid.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
    if (existing) {
      if (existing.auctionId !== params.auctionId || existing.bidderId !== params.bidderId || !existing.amount.equals(params.amount)) {
        throw new Error('IDEMPOTENCY_KEY_REUSED');
      }
      return { bid: existing, replayed: true };
    }

    const auction = await tx.auction.findUnique({ where: { id: params.auctionId }, include: { vehicle: true } });
    if (!auction) throw new Error('AUCTION_NOT_FOUND');
    const bidder = await tx.user.findUnique({ where: { id: params.bidderId } });
    if (!bidder || bidder.status !== 'ACTIVE') throw new Error('BIDDER_NOT_ELIGIBLE');
    if (bidder.phoneStatus !== 'VERIFIED') throw new Error('PHONE_NOT_VERIFIED');
    if (!isIdentityVerified(bidder)) throw new Error('IDENTITY_NOT_VERIFIED');
    const now = new Date();
    if (auction.status !== 'ACTIVE' || auction.startAt > now || auction.endAt <= now) throw new Error('AUCTION_ENDED');
    if (auction.sellerId === params.bidderId) throw new Error('SELLER_CANNOT_BID');
    if (auction.vehicle.hasLegalBlock || auction.vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_RESTRICTED');
    const minimum = new Prisma.Decimal(auction.currentPrice).add(auction.minimumIncrement);
    if (new Prisma.Decimal(params.amount).lt(minimum)) throw new Error(`MIN_BID:${minimum.toString()}`);

    if (auction.bidDepositAmount && new Prisma.Decimal(auction.bidDepositAmount).gt(0)) {
      const deposit = await tx.auctionBidDeposit.findFirst({ where: { auctionId: auction.id, bidderId: params.bidderId, status: 'HOLD' } });
      if (!deposit) throw new Error('BID_DEPOSIT_REQUIRED');
    }

    let endAt = auction.endAt;
    if (auction.endAt.getTime() - now.getTime() <= AUCTION_ANTI_SNIPING_MS) endAt = new Date(auction.endAt.getTime() + AUCTION_EXTENSION_MS);

    const bid = await tx.auctionBid.create({ data: { auctionId: auction.id, bidderId: params.bidderId, amount: params.amount, idempotencyKey: params.idempotencyKey } });
    if (auction.bidDepositAmount && new Prisma.Decimal(auction.bidDepositAmount).gt(0)) {
      await tx.auctionBidDeposit.updateMany({ where: { auctionId: auction.id, bidderId: params.bidderId, status: 'HOLD', bidId: null }, data: { bidId: bid.id } });
    }
    const autoBids = await tx.auctionAutoBid.findMany({
      where: { auctionId: auction.id, isActive: true },
      select: { id: true, bidderId: true, maxAmount: true, createdAt: true },
    });
    const competition = resolveAuctionCompetition({
      floorAmount: params.amount,
      minimumIncrement: auction.minimumIncrement,
      offers: [
        { bidderId: bid.bidderId, maxAmount: bid.amount, priorityAt: bid.createdAt, tieBreaker: `BID:${bid.id}` },
        ...autoBids.map(autoBid => ({
          bidderId: autoBid.bidderId,
          maxAmount: autoBid.maxAmount,
          priorityAt: autoBid.createdAt,
          tieBreaker: `AUTO:${autoBid.id}`,
        })),
      ],
    });
    if (!competition.leaderId) throw new Error('AUCTION_COMPETITION_INVALID');

    let leaderBidId = bid.id;
    const leaderId = competition.leaderId;
    if (leaderId !== bid.bidderId || !competition.price.eq(bid.amount)) {
      const proxy = await tx.auctionBid.create({
        data: {
          auctionId: auction.id,
          bidderId: leaderId,
          amount: competition.price,
          idempotencyKey: `AUTO:${auction.id}:${bid.id}:${leaderId}`,
        },
      });
      leaderBidId = proxy.id;
      if (auction.bidDepositAmount && new Prisma.Decimal(auction.bidDepositAmount).gt(0)) {
        await tx.auctionBidDeposit.updateMany({
          where: { auctionId: auction.id, bidderId: leaderId, status: 'HOLD', bidId: null },
          data: { bidId: proxy.id },
        });
      }
    }

    const updated = await tx.auction.update({ where: { id: auction.id }, data: { currentPrice: competition.price, endAt, winnerId: null, winnerBidId: null } });
    return { bid, leaderBidId, leaderId, auction: updated, replayed: false };
  });
}

export async function setAutoBid(params: { auctionId: string; bidderId: string; maxAmount: number }) {
  if (!Number.isFinite(params.maxAmount) || params.maxAmount <= 0) throw new Error('INVALID_AUTO_BID');
  return db.$transaction(async tx => {
    await lockAuction(tx, params.auctionId);
    const auction = await tx.auction.findUnique({ where: { id: params.auctionId }, include: { vehicle: true } });
    const bidder = await tx.user.findUnique({ where: { id: params.bidderId } });
    const now = new Date();
    if (!auction || auction.status !== 'ACTIVE' || auction.startAt > now || auction.endAt <= now) throw new Error('AUCTION_ENDED');
    if (!bidder || bidder.status !== 'ACTIVE') throw new Error('BIDDER_NOT_ELIGIBLE');
    if (bidder.phoneStatus !== 'VERIFIED') throw new Error('PHONE_NOT_VERIFIED');
    if (!isIdentityVerified(bidder)) throw new Error('IDENTITY_NOT_VERIFIED');
    if (auction.sellerId === params.bidderId) throw new Error('SELLER_CANNOT_BID');
    if (auction.vehicle.hasLegalBlock || auction.vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_RESTRICTED');
    const maxAmount = new Prisma.Decimal(params.maxAmount);
    const minimum = new Prisma.Decimal(auction.currentPrice).add(auction.minimumIncrement);
    if (maxAmount.lt(minimum)) throw new Error(`MIN_AUTO_BID:${minimum.toString()}`);
    if (auction.bidDepositAmount && new Prisma.Decimal(auction.bidDepositAmount).gt(0)) {
      const deposit = await tx.auctionBidDeposit.findFirst({ where: { auctionId: auction.id, bidderId: params.bidderId, status: 'HOLD' } });
      if (!deposit) throw new Error('BID_DEPOSIT_REQUIRED');
    }
    return tx.auctionAutoBid.upsert({
      where: { auctionId_bidderId: { auctionId: params.auctionId, bidderId: params.bidderId } },
      create: { auctionId: params.auctionId, bidderId: params.bidderId, maxAmount },
      update: { maxAmount, isActive: true },
    });
  });
}

export async function finalizeAuction(auctionId: string) {
  return db.$transaction(async tx => {
    await lockAuction(tx, auctionId);
    const auction = await tx.auction.findUnique({ where: { id: auctionId }, include: { vehicle: true } });
    if (!auction) throw new Error('AUCTION_NOT_FOUND');
    if (auction.status === 'SOLD' && auction.saleId) return auction;
    if (auction.vehicle.hasLegalBlock || auction.vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_RESTRICTED');
    if (auction.status === 'ACTIVE' && auction.endAt > new Date()) throw new Error('AUCTION_NOT_ENDED');

    const [bids, autoBids] = await Promise.all([
      tx.auctionBid.findMany({ where: { auctionId }, orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }] }),
      tx.auctionAutoBid.findMany({
        where: { auctionId, isActive: true },
        select: { id: true, bidderId: true, maxAmount: true, createdAt: true },
      }),
    ]);
    const materializedFloor = bids[0]
      ? Prisma.Decimal.max(auction.currentPrice, bids[0].amount)
      : new Prisma.Decimal(auction.currentPrice).add(auction.minimumIncrement);
    const competition = resolveAuctionCompetition({
      floorAmount: materializedFloor,
      minimumIncrement: auction.minimumIncrement,
      offers: [
        ...bids.map(bid => ({
          bidderId: bid.bidderId,
          maxAmount: bid.amount,
          priorityAt: bid.createdAt,
          tieBreaker: `BID:${bid.id}`,
        })),
        ...autoBids.map(autoBid => ({
          bidderId: autoBid.bidderId,
          maxAmount: autoBid.maxAmount,
          priorityAt: autoBid.createdAt,
          tieBreaker: `AUTO:${autoBid.id}`,
        })),
      ],
    });
    if (!competition.leaderId) {
      await tx.auction.update({ where: { id: auctionId }, data: { status: 'ENDED', paymentDeadlineAt: null } });
      await tx.vehicle.updateMany({ where: { id: auction.vehicleId, isReserved: true, status: 'ACTIVE' }, data: { isReserved: false } });
      return tx.auction.findUniqueOrThrow({ where: { id: auctionId } });
    }

    let winnerBid = bids.find(bid => bid.bidderId === competition.leaderId && bid.amount.eq(competition.price));
    if (!winnerBid) {
      winnerBid = await tx.auctionBid.create({
        data: {
          auctionId,
          bidderId: competition.leaderId,
          amount: competition.price,
          idempotencyKey: `AUTO_FINAL:${auctionId}:${competition.leaderId}:${competition.price.toString()}`,
        },
      });
      if (auction.bidDepositAmount && new Prisma.Decimal(auction.bidDepositAmount).gt(0)) {
        await tx.auctionBidDeposit.updateMany({
          where: { auctionId, bidderId: competition.leaderId, status: 'HOLD', bidId: null },
          data: { bidId: winnerBid.id },
        });
      }
    }

    const paymentDeadlineAt = new Date(Date.now() + AUCTION_PAYMENT_DEADLINE_HOURS * 60 * 60 * 1000);
    const claimed = await tx.auction.updateMany({ where: { id: auctionId, winnerId: null, saleId: null }, data: { winnerId: winnerBid.bidderId, winnerBidId: winnerBid.id, status: 'ENDED', paymentDeadlineAt } });
    if (claimed.count !== 1) return tx.auction.findUniqueOrThrow({ where: { id: auctionId } });

    const exchange = await tx.exchangeRate.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!exchange) throw new Error('EXCHANGE_RATE_NOT_CONFIGURED');
    const seller = await tx.user.findUniqueOrThrow({ where: { id: auction.sellerId } });
    const buyer = await tx.user.findUniqueOrThrow({ where: { id: winnerBid.bidderId } });
    if (seller.phoneStatus !== 'VERIFIED' || !isIdentityVerified(seller)) throw new Error('SELLER_NOT_VERIFIED');
    if (buyer.phoneStatus !== 'VERIFIED' || !isIdentityVerified(buyer)) throw new Error('BUYER_NOT_VERIFIED');
    const payoutAccount = await tx.payoutAccount.findFirst({ where: { userId: seller.id, verified: true, nameMatchStatus: 'MATCH' } });
    if (!payoutAccount) throw new Error('PAYOUT_ACCOUNT_REQUIRED');
    const salePrice = winnerBid.amount;
    const winningDeposit = await tx.auctionBidDeposit.findFirst({ where: { auctionId: auction.id, bidderId: winnerBid.bidderId, status: 'HOLD' } });
    const bidDepositYER = winningDeposit?.amount ?? new Prisma.Decimal(0);
    const auctionFeeYER = new Prisma.Decimal(calculateAuctionFeeYer(Number(salePrice)));
    const transferFeeYER = new Prisma.Decimal(FEES.TRANSFER_USD).mul(exchange.usdToYer);
    const platformFeeYER = new Prisma.Decimal(FEES.PLATFORM_USD).mul(exchange.usdToYer);
    const grossTotal = salePrice.add(auctionFeeYER).add(transferFeeYER).add(platformFeeYER);
    const total = grossTotal.sub(bidDepositYER);
    if (total.lt(0)) throw new Error('BID_DEPOSIT_EXCEEDS_TOTAL');
    const sale = await tx.vehicleSale.create({
      data: {
        vehicleId: auction.vehicleId,
        sellerId: auction.sellerId,
        sellerName: seller.fullName,
        sellerNationalId: seller.nationalId ?? '',
        sellerPhone: seller.phone,
        sellerVerified: true,
        buyerId: winnerBid.bidderId,
        buyerVerified: true,
        buyerApproved: true,
        buyerName: buyer.fullName,
        buyerNationalId: buyer.nationalId ?? '',
        buyerPhone: buyer.phone,
        vehicleAmountYER: salePrice,
        platformFeeUSD: FEES.PLATFORM_USD,
        platformFeeYER,
        transferFeeUSD: FEES.TRANSFER_USD,
        transferFeeYER,
        listingCommissionUSD: 0,
        auctionFeeYER,
        governmentFeesYER: 0,
        bidDepositYER,
        totalPaidYER: total,
        sellerPayoutYER: salePrice,
        platformRevenueYER: auctionFeeYER.add(transferFeeYER).add(platformFeeYER),
        exchangeRate: exchange.usdToYer,
        exchangeRateId: exchange.id,
        status: 'WAITING_PAYMENT',
        payoutUserId: seller.id,
        payoutAccountId: payoutAccount.id,
        vehicleEligible: !auction.vehicle.hasLegalBlock,
        auctionId,
        expiresAt: paymentDeadlineAt,
      },
    });
    await tx.auction.update({ where: { id: auctionId }, data: { status: 'SOLD', saleId: sale.id } });
    const reserved = await tx.vehicle.updateMany({ where: { id: auction.vehicleId, isReserved: true, status: 'ACTIVE' }, data: { status: 'PENDING' } });
    if (reserved.count !== 1) throw new Error('VEHICLE_RESERVATION_LOST');
    return tx.auction.findUniqueOrThrow({ where: { id: auctionId }, include: { sale: true, winnerBid: true } });
  });
}

export async function settleLosingBidDeposits(auctionId: string, winnerId?: string) {
  const providerUrl = requireProviderEndpoint(process.env.AUCTION_DEPOSIT_PROVIDER_URL, 'AUCTION_DEPOSIT_PROVIDER');
  const secret = process.env.AUCTION_DEPOSIT_PROVIDER_SECRET;
  if (!secret) throw new Error('NOT_CONFIGURED:AUCTION_DEPOSIT_PROVIDER_REQUIRED');
  const deposits = await db.auctionBidDeposit.findMany({ where: { auctionId, status: 'HOLD', ...(winnerId ? { bidderId: { not: winnerId } } : {}) } });
  const results = [] as Array<{ id: string; status: string; providerReference?: string }>;
  for (const deposit of deposits) {
    const response = await fetch(providerUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ action: 'REFUND', auctionId, depositId: deposit.id, bidderId: deposit.bidderId, amount: deposit.amount, currency: deposit.currency, providerReference: deposit.providerReference, idempotencyKey: `BID_DEPOSIT_REFUND:${deposit.id}` }), signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error('BID_DEPOSIT_REFUND_FAILED');
    const result = await parseDepositSettlementResponse(response);
    if (result.status !== 'REFUNDED') throw new Error('BID_DEPOSIT_REFUND_NOT_CONFIRMED');
    await db.auctionBidDeposit.update({ where: { id: deposit.id }, data: { status: 'REFUNDED', providerReference: result.providerReference } });
    results.push({ id: deposit.id, status: 'REFUNDED', providerReference: result.providerReference });
  }
  return results;
}

export async function forfeitWinningBidDeposit(auctionId: string, winnerId: string) {
  const providerUrl = requireProviderEndpoint(process.env.AUCTION_DEPOSIT_PROVIDER_URL, 'AUCTION_DEPOSIT_PROVIDER');
  const secret = process.env.AUCTION_DEPOSIT_PROVIDER_SECRET;
  if (!secret) throw new Error('NOT_CONFIGURED:AUCTION_DEPOSIT_PROVIDER_REQUIRED');
  const deposit = await db.auctionBidDeposit.findFirst({ where: { auctionId, bidderId: winnerId, status: 'HOLD' } });
  if (!deposit) return null;
  const response = await fetch(providerUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ action: 'FORFEIT', auctionId, depositId: deposit.id, bidderId: deposit.bidderId, amount: deposit.amount, currency: deposit.currency, providerReference: deposit.providerReference, idempotencyKey: `BID_DEPOSIT_FORFEIT:${deposit.id}` }), signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw new Error('BID_DEPOSIT_FORFEIT_FAILED');
  const result = await parseDepositSettlementResponse(response);
  if (result.status !== 'FORFEITED') throw new Error('BID_DEPOSIT_FORFEIT_NOT_CONFIRMED');
  return db.auctionBidDeposit.update({ where: { id: deposit.id }, data: { status: 'FORFEITED', providerReference: result.providerReference } });
}
