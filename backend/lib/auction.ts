import { Prisma } from '@prisma/client';
import { db } from './db';
import { FEES, calculateAuctionFeeYer } from './fees';
import { createDoubleEntry } from './ledger';

export const AUCTION_ANTI_SNIPING_MS = 120_000;
export const AUCTION_EXTENSION_MS = 120_000;
export const AUCTION_PAYMENT_DEADLINE_HOURS = 2;

function lockAuction(tx: Prisma.TransactionClient, auctionId: string) {
  return tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Auction" WHERE id = ${auctionId} FOR UPDATE`;
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
    if (existing) return { bid: existing, replayed: true };

    const auction = await tx.auction.findUnique({ where: { id: params.auctionId }, include: { vehicle: true } });
    if (!auction) throw new Error('AUCTION_NOT_FOUND');
    const now = new Date();
    if (auction.status !== 'ACTIVE' || auction.startAt > now || auction.endAt <= now) throw new Error('AUCTION_ENDED');
    if (auction.sellerId === params.bidderId) throw new Error('SELLER_CANNOT_BID');
    if (auction.vehicle.hasLegalBlock || ['BLOCKED', 'RESTRICTED'].includes(auction.vehicle.governmentStatus)) throw new Error('VEHICLE_RESTRICTED');
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
    let currentPrice = new Prisma.Decimal(params.amount);
    let leaderBidId = bid.id;
    let leaderId = params.bidderId;

    // Server-side proxy bidding: the highest active max is allowed to answer a new bid.
    for (let i = 0; i < 20; i++) {
      const opponent = await tx.auctionAutoBid.findFirst({
        where: { auctionId: auction.id, isActive: true, bidderId: { not: leaderId }, maxAmount: { gt: currentPrice } },
        orderBy: [{ maxAmount: 'desc' }, { createdAt: 'asc' }],
      });
      if (!opponent) break;
      const proxyAmount = Prisma.Decimal.min(opponent.maxAmount, currentPrice.add(auction.minimumIncrement));
      if (proxyAmount.lte(currentPrice)) break;
      const proxy = await tx.auctionBid.create({
        data: { auctionId: auction.id, bidderId: opponent.bidderId, amount: proxyAmount, idempotencyKey: `AUTO:${auction.id}:${opponent.bidderId}:${proxyAmount.toString()}:${Date.now()}:${i}` },
      });
      currentPrice = proxyAmount;
      leaderBidId = proxy.id;
      leaderId = opponent.bidderId;
    }

    const updated = await tx.auction.update({ where: { id: auction.id }, data: { currentPrice, endAt, winnerId: null, winnerBidId: null } });
    return { bid, leaderBidId, leaderId, auction: updated, replayed: false };
  });
}

export async function setAutoBid(params: { auctionId: string; bidderId: string; maxAmount: number }) {
  if (!Number.isFinite(params.maxAmount) || params.maxAmount <= 0) throw new Error('INVALID_AUTO_BID');
  return db.$transaction(async tx => {
    await lockAuction(tx, params.auctionId);
    const auction = await tx.auction.findUnique({ where: { id: params.auctionId } });
    if (!auction || auction.status !== 'ACTIVE') throw new Error('AUCTION_ENDED');
    if (auction.sellerId === params.bidderId) throw new Error('SELLER_CANNOT_BID');
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
    if (auction.status === 'ACTIVE' && auction.endAt > new Date()) throw new Error('AUCTION_NOT_ENDED');

    const winnerBid = await tx.auctionBid.findFirst({ where: { auctionId }, orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }] });
    if (!winnerBid) {
      await tx.auction.update({ where: { id: auctionId }, data: { status: 'ENDED', paymentDeadlineAt: null } });
      await tx.vehicle.updateMany({ where: { id: auction.vehicleId, isReserved: true, status: 'ACTIVE' }, data: { isReserved: false } });
      return tx.auction.findUniqueOrThrow({ where: { id: auctionId } });
    }

    const paymentDeadlineAt = new Date(Date.now() + AUCTION_PAYMENT_DEADLINE_HOURS * 60 * 60 * 1000);
    const claimed = await tx.auction.updateMany({ where: { id: auctionId, winnerId: null, saleId: null }, data: { winnerId: winnerBid.bidderId, winnerBidId: winnerBid.id, status: 'ENDED', paymentDeadlineAt } });
    if (claimed.count !== 1) return tx.auction.findUniqueOrThrow({ where: { id: auctionId } });

    const exchange = await tx.exchangeRate.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!exchange) throw new Error('EXCHANGE_RATE_NOT_CONFIGURED');
    const seller = await tx.user.findUniqueOrThrow({ where: { id: auction.sellerId } });
    const buyer = await tx.user.findUniqueOrThrow({ where: { id: winnerBid.bidderId } });
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
        vehicleEligible: !auction.vehicle.hasLegalBlock,
        auctionId,
        expiresAt: paymentDeadlineAt,
      },
    });
    await tx.auction.update({ where: { id: auctionId }, data: { status: 'SOLD', saleId: sale.id } });
    return tx.auction.findUniqueOrThrow({ where: { id: auctionId }, include: { sale: true, winnerBid: true } });
  });
}

export async function settleLosingBidDeposits(auctionId: string, winnerId?: string) {
  const providerUrl = process.env.AUCTION_DEPOSIT_PROVIDER_URL;
  const secret = process.env.AUCTION_DEPOSIT_PROVIDER_SECRET;
  if (!providerUrl || !secret) throw new Error('NOT_CONFIGURED:AUCTION_DEPOSIT_PROVIDER_REQUIRED');
  const deposits = await db.auctionBidDeposit.findMany({ where: { auctionId, status: 'HOLD', ...(winnerId ? { bidderId: { not: winnerId } } : {}) } });
  const results = [] as Array<{ id: string; status: string; providerReference?: string }>;
  for (const deposit of deposits) {
    const response = await fetch(providerUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ action: 'REFUND', auctionId, depositId: deposit.id, bidderId: deposit.bidderId, amount: deposit.amount, currency: deposit.currency, providerReference: deposit.providerReference, idempotencyKey: `BID_DEPOSIT_REFUND:${deposit.id}` }) });
    if (!response.ok) throw new Error('BID_DEPOSIT_REFUND_FAILED');
    const result = await response.json() as { status?: string; providerReference?: string };
    if (result.status !== 'REFUNDED') throw new Error('BID_DEPOSIT_REFUND_NOT_CONFIRMED');
    await db.auctionBidDeposit.update({ where: { id: deposit.id }, data: { status: 'REFUNDED', providerReference: result.providerReference ?? deposit.providerReference } });
    results.push({ id: deposit.id, status: 'REFUNDED', providerReference: result.providerReference });
  }
  return results;
}

export async function forfeitWinningBidDeposit(auctionId: string, winnerId: string) {
  const providerUrl = process.env.AUCTION_DEPOSIT_PROVIDER_URL;
  const secret = process.env.AUCTION_DEPOSIT_PROVIDER_SECRET;
  if (!providerUrl || !secret) throw new Error('NOT_CONFIGURED:AUCTION_DEPOSIT_PROVIDER_REQUIRED');
  const deposit = await db.auctionBidDeposit.findFirst({ where: { auctionId, bidderId: winnerId, status: 'HOLD' } });
  if (!deposit) return null;
  const response = await fetch(providerUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ action: 'FORFEIT', auctionId, depositId: deposit.id, bidderId: deposit.bidderId, amount: deposit.amount, currency: deposit.currency, providerReference: deposit.providerReference, idempotencyKey: `BID_DEPOSIT_FORFEIT:${deposit.id}` }) });
  if (!response.ok) throw new Error('BID_DEPOSIT_FORFEIT_FAILED');
  const result = await response.json() as { status?: string; providerReference?: string };
  if (result.status !== 'FORFEITED') throw new Error('BID_DEPOSIT_FORFEIT_NOT_CONFIRMED');
  return db.auctionBidDeposit.update({ where: { id: deposit.id }, data: { status: 'FORFEITED', providerReference: result.providerReference ?? deposit.providerReference } });
}
