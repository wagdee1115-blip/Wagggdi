import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { createDoubleEntry } from './ledger';
import { readBoundedResponseText } from './http-bounds';
import { isIdentityVerified } from './identity-policy';
import { requireProviderEndpoint } from './provider-endpoint';

export const AUCTION_DEPOSIT_PENDING_STALE_MS = 2 * 60 * 1000;

const depositProviderResponseSchema = z.object({
  status: z.literal('HOLD'),
  providerReference: z.string().trim().min(1).max(300),
});

export async function holdAuctionDeposit(params: { auctionId: string; bidderId: string }) {
  const auction = await db.auction.findUnique({ where: { id: params.auctionId }, include: { vehicle: true } });
  if (!auction) throw new Error('AUCTION_NOT_FOUND');
  const bidder = await db.user.findUnique({ where: { id: params.bidderId } });
  if (!bidder || bidder.status !== 'ACTIVE') throw new Error('BIDDER_NOT_ELIGIBLE');
  if (bidder.phoneStatus !== 'VERIFIED') throw new Error('PHONE_NOT_VERIFIED');
  if (!isIdentityVerified(bidder)) throw new Error('IDENTITY_NOT_VERIFIED');
  const now = new Date();
  if (auction.status !== 'ACTIVE' || auction.startAt > now || auction.endAt <= now) throw new Error('AUCTION_ENDED');
  if (auction.sellerId === params.bidderId) throw new Error('SELLER_CANNOT_DEPOSIT');
  if (auction.vehicle.hasLegalBlock || ['BLOCKED', 'RESTRICTED'].includes(auction.vehicle.governmentStatus)) throw new Error('VEHICLE_RESTRICTED');
  if (!auction.bidDepositAmount || new Prisma.Decimal(auction.bidDepositAmount).lte(0)) throw new Error('DEPOSIT_NOT_REQUIRED');
  if (new Prisma.Decimal(auction.bidDepositAmount).gt(auction.startingPrice)) throw new Error('BID_DEPOSIT_EXCEEDS_STARTING_PRICE');
  const providerUrl = requireProviderEndpoint(process.env.AUCTION_DEPOSIT_PROVIDER_URL, 'AUCTION_DEPOSIT_PROVIDER');
  const secret = process.env.AUCTION_DEPOSIT_PROVIDER_SECRET;
  if (!secret) throw new Error('NOT_CONFIGURED:AUCTION_DEPOSIT_PROVIDER_REQUIRED');

  const logicalKey = `AUCTION_DEPOSIT:${auction.id}:${params.bidderId}`;
  const claim = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${logicalKey}))`;
    const existing = await tx.auctionBidDeposit.findUnique({ where: { auctionId_bidderId: { auctionId: auction.id, bidderId: params.bidderId } } });
    if (existing && existing.status !== 'FAILED' && existing.status !== 'PENDING') return { deposit: existing, invoke: false };
    if (existing?.status === 'PENDING' && existing.updatedAt.getTime() > Date.now() - AUCTION_DEPOSIT_PENDING_STALE_MS) return { deposit: existing, invoke: false };
    // A stale PENDING may mean the provider accepted the hold before this
    // process crashed. Reconcile with the exact same provider idempotency key.
    if (existing) return { deposit: await tx.auctionBidDeposit.update({ where: { id: existing.id }, data: { status: 'PENDING' } }), invoke: true };
    return { deposit: await tx.auctionBidDeposit.create({ data: { auctionId: auction.id, bidderId: params.bidderId, amount: auction.bidDepositAmount!, currency: auction.bidDepositCurrency, status: 'PENDING', idempotencyKey: logicalKey } }), invoke: true };
  });
  if (!claim.invoke) return { deposit: claim.deposit, replayed: true };

  let response: Response;
  try {
    response = await fetch(providerUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ auctionId: auction.id, bidderId: params.bidderId, amount: auction.bidDepositAmount, currency: auction.bidDepositCurrency, idempotencyKey: logicalKey }), signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
  } catch (error) {
    // The provider may have accepted the stable idempotency key. Keep PENDING
    // for stale reconciliation instead of incorrectly declaring the hold failed.
    throw error;
  }
  if (!response.ok) {
    await db.auctionBidDeposit.updateMany({ where: { id: claim.deposit.id, status: 'PENDING' }, data: { status: 'FAILED' } });
    throw new Error('BID_DEPOSIT_PROVIDER_FAILED');
  }
  let body: string;
  try {
    body = await readBoundedResponseText(response, 64 * 1024, 'BID_DEPOSIT_NOT_HELD');
  } catch {
    await db.auctionBidDeposit.updateMany({ where: { id: claim.deposit.id, status: 'PENDING' }, data: { status: 'FAILED' } });
    throw new Error('BID_DEPOSIT_NOT_HELD');
  }
  let rawResult: unknown;
  try { rawResult = body ? JSON.parse(body) : null; } catch { rawResult = null; }
  const parsedResult = depositProviderResponseSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    await db.auctionBidDeposit.updateMany({ where: { id: claim.deposit.id, status: 'PENDING' }, data: { status: 'FAILED' } });
    throw new Error('BID_DEPOSIT_NOT_HELD');
  }
  const result = parsedResult.data;

  let deposit;
  try {
    deposit = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${logicalKey}))`;
      const current = await tx.auctionBidDeposit.findUniqueOrThrow({ where: { id: claim.deposit.id } });
      if (current.status === 'HOLD') return current;
      if (current.status !== 'PENDING') throw new Error(`BID_DEPOSIT_STATE_CHANGED:${current.status}`);
      const referenceOwner = await tx.auctionBidDeposit.findUnique({ where: { providerReference: result.providerReference } });
      if (referenceOwner && referenceOwner.id !== current.id) throw new Error('BID_DEPOSIT_PROVIDER_REFERENCE_REPLAY');
      const held = await tx.auctionBidDeposit.update({ where: { id: current.id }, data: { status: 'HOLD', providerReference: result.providerReference } });
      await createDoubleEntry({ transactionId: auction.id, entryGroupId: `BID_DEPOSIT:${held.id}`, amount: held.amount, currency: held.currency, debitType: 'CUSTOMER_FUNDS', creditType: 'ESCROW_FUNDS', userId: params.bidderId, relatedOperationId: auction.id, providerRef: result.providerReference, idempotencyKey: `BID_DEPOSIT:${held.id}` }, tx);
      return held;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new Error('BID_DEPOSIT_PROVIDER_REFERENCE_REPLAY');
    }
    throw error;
  }
  return { deposit, replayed: false };
}
