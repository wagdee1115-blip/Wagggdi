import { createHash } from 'crypto';
import { Prisma, SaleStatus } from '@prisma/client';
import { db } from './db';
import { FEES, calculateListingCommissionUsd } from './fees';
import { createDoubleEntry } from './ledger';
import { otpService } from './otp';

export const TRANSFER_FEE_USD = FEES.TRANSFER_USD;
export const PAYOUT_PROTECTION_MINUTES = Number(process.env.PAYOUT_PROTECTION_MINUTES ?? 15);
export const DIRECT_SALE_EXPIRATION_MS = 2 * 60 * 60 * 1000;

/** Canonical sale state machine. Legacy states remain in Prisma for backward compatibility. */
const TRANSITIONS: Record<SaleStatus, SaleStatus[]> = {
  SALE_CREATED: ['BUYER_PENDING', 'CANCELLED', 'EXPIRED'],
  BUYER_PENDING: ['BUYER_ACCEPTED', 'CANCELLED', 'EXPIRED'],
  BUYER_ACCEPTED: ['PAYMENT_PROCESSING', 'CANCELLED', 'EXPIRED'],
  PAYMENT_PROCESSING: ['PAYMENT_CONFIRMED', 'PAYMENT_PENDING_VERIFICATION', 'PAYMENT_FAILED', 'MANUAL_REVIEW'],
  PAYMENT_CONFIRMED: ['ESCROW_HELD', 'MANUAL_REVIEW'],
  ESCROW_HELD: ['TRANSFER_PENDING', 'TRANSFER_IN_PROGRESS', 'DISPUTED', 'CANCELLED'],
  TRANSFER_PENDING: ['TRANSFER_IN_PROGRESS', 'TRANSFER_BLOCKED', 'MANUAL_REVIEW'],
  TRANSFER_IN_PROGRESS: ['OWNERSHIP_TRANSFERRED', 'TRANSFER_BLOCKED', 'TRANSFER_FAILED', 'MANUAL_REVIEW'],
  OWNERSHIP_TRANSFERRED: ['HANDOVER_PENDING', 'MANUAL_REVIEW'],
  HANDOVER_PENDING: ['HANDOVER_CONFIRMED', 'DISPUTED', 'MANUAL_REVIEW'],
  HANDOVER_CONFIRMED: ['PAYOUT_PROTECTION'],
  PAYOUT_PROTECTION: ['PAYOUT_PENDING', 'DISPUTED', 'MANUAL_REVIEW'],
  PAYOUT_PENDING: ['PAYOUT_PROCESSING', 'DISPUTED', 'MANUAL_REVIEW'],
  PAYOUT_PROCESSING: ['PAYOUT_CONFIRMED', 'RELEASE_FAILED', 'MANUAL_REVIEW'],
  PAYOUT_CONFIRMED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: [],
  DISPUTED: ['MANUAL_REVIEW', 'PAYOUT_PENDING', 'CANCELLED'],
  MANUAL_REVIEW: ['PAYMENT_CONFIRMED', 'TRANSFER_IN_PROGRESS', 'PAYOUT_PENDING', 'CANCELLED', 'DISPUTED'],
  TRANSFER_BLOCKED: ['TRANSFER_IN_PROGRESS', 'CANCELLED', 'MANUAL_REVIEW'],
  PAYOUT_REVIEW_REQUIRED: ['PAYOUT_PENDING', 'MANUAL_REVIEW', 'DISPUTED'],

  // Legacy compatibility states. New operations do not create these states.
  PENDING_SELLER: ['BUYER_IDENTIFIED', 'CANCELLED', 'EXPIRED'],
  BUYER_IDENTIFIED: ['WAITING_BUYER_APPROVAL', 'BUYER_ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  WAITING_BUYER_APPROVAL: ['BUYER_APPROVED', 'BUYER_ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  BUYER_APPROVED: ['BUYER_OTP_VERIFIED', 'WAITING_PAYMENT', 'PAYMENT_PROCESSING', 'CANCELLED', 'EXPIRED'],
  BUYER_OTP_VERIFIED: ['WAITING_PAYMENT', 'PAYMENT_PROCESSING', 'CANCELLED', 'EXPIRED'],
  WAITING_SELLER_CONFIRMATION: ['SELLER_OTP_VERIFIED', 'TRANSFER_PENDING', 'CANCELLED', 'EXPIRED'],
  WAITING_PAYMENT: ['PAYMENT_PROCESSING', 'PAYMENT_PENDING_VERIFICATION', 'CANCELLED', 'EXPIRED'],
  PAYMENT_PENDING_VERIFICATION: ['PAYMENT_VERIFIED', 'PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'MANUAL_REVIEW'],
  PAYMENT_VERIFIED: ['FUNDS_SECURED', 'ESCROW_HELD', 'PAYMENT_CONFIRMED', 'MANUAL_REVIEW'],
  SELLER_OTP_VERIFIED: ['TRANSFER_IN_PROGRESS', 'TRANSFER_PENDING', 'TRANSFER_BLOCKED', 'MANUAL_REVIEW'],
  RELEASE_PENDING: ['RELEASE_READY', 'DISPUTED', 'MANUAL_REVIEW'],
  RELEASE_READY: ['RELEASE_PROCESSING', 'DISPUTED', 'MANUAL_REVIEW'],
  RELEASE_PROCESSING: ['FUNDS_RELEASED', 'RELEASE_FAILED', 'MANUAL_REVIEW'],
  RELEASE_FAILED: ['RELEASE_PROCESSING', 'MANUAL_REVIEW'],
  PAYMENT_FAILED: [],
  TRANSFER_FAILED: [],
  REJECTED: [],
  FUNDS_SECURED: ['ESCROW_HELD', 'SELLER_OTP_VERIFIED', 'TRANSFER_PENDING', 'CANCELLED', 'DISPUTED'],
  FUNDS_RELEASED: ['CONTRACT_GENERATED', 'COMPLETED'],
  CONTRACT_GENERATED: ['COMPLETED'],
};

export function isAllowedSaleTransition(current: SaleStatus, next: SaleStatus) {
  return current === next || Boolean(TRANSITIONS[current]?.includes(next));
}

const CUSTOMER_REQUESTABLE_STATUSES = new Set<SaleStatus>(['BUYER_ACCEPTED', 'CANCELLED', 'DISPUTED']);
const OPERATIONS_ROLES = new Set(['OWNER', 'SUPER_ADMIN', 'ADMIN', 'FINANCE', 'VERIFIER']);

/** Prevent customer-controlled PATCH requests from impersonating provider/escrow transitions. */
export function canRequestSaleStatus(role: string, status: SaleStatus) {
  return OPERATIONS_ROLES.has(role) || CUSTOMER_REQUESTABLE_STATUSES.has(status);
}

function ensureTransition(current: SaleStatus, next: SaleStatus) {
  if (current === next) return;
  if (!TRANSITIONS[current]?.includes(next)) throw new Error(`INVALID_SALE_TRANSITION:${current}->${next}`);
}

function normalizeRequestedStatus(nextStatus: SaleStatus): SaleStatus {
  if (nextStatus === 'BUYER_APPROVED') return 'BUYER_ACCEPTED';
  if (nextStatus === 'FUNDS_SECURED') return 'ESCROW_HELD';
  return nextStatus;
}

async function assertPayoutAccount(tx: Prisma.TransactionClient, userId: string) {
  const payout = await tx.payoutAccount.findFirst({ where: { userId, verified: true }, orderBy: { updatedAt: 'desc' } });
  if (!payout) throw new Error('PAYOUT_ACCOUNT_REQUIRED');
  if (payout.nameMatchStatus !== 'MATCH') throw new Error('PAYOUT_REVIEW_REQUIRED');
  return payout;
}

export async function createOwnershipTransfer(params: {
  vehicleId: string;
  sellerId: string;
  buyerId: string;
  salePrice: number;
  listingType?: 'DIRECT' | 'MARKET' | 'EXHIBITION' | 'AUCTION';
  soldThroughExhibitionService?: boolean;
  auctionFeeYer?: number;
  auctionId?: string;
}) {
  if (params.sellerId === params.buyerId) throw new Error('SELLER_AND_BUYER_MUST_DIFFER');
  if (!Number.isFinite(params.salePrice) || params.salePrice <= 0) throw new Error('INVALID_PRICE');
  return db.$transaction(async tx => {
    const vehicle = await tx.vehicle.findUnique({ where: { id: params.vehicleId }, include: { owner: true } });
    if (!vehicle) throw new Error('VEHICLE_NOT_FOUND');
    if (vehicle.status !== 'ACTIVE' || vehicle.isReserved) throw new Error('VEHICLE_NOT_AVAILABLE');
    if (vehicle.hasLegalBlock || ['BLOCKED', 'RESTRICTED'].includes(vehicle.governmentStatus)) throw new Error('VEHICLE_RESTRICTED');

    let authorityType: 'SELL_ONLY' | 'SELL_AND_RECEIVE' = 'SELL_AND_RECEIVE';
    let authorizationId: string | undefined;
    let sellerActor = vehicle.owner;
    if (vehicle.ownerId !== params.sellerId) {
      const auth = await tx.vehicleAuthorization.findFirst({
        where: { vehicleId: params.vehicleId, authorizedUserId: params.sellerId, ownerId: vehicle.ownerId, status: 'ACTIVE', validUntil: { gt: new Date() } },
        include: { authorizedUser: true },
      });
      if (!auth) throw new Error('VALID_AUTHORIZATION_REQUIRED');
      authorityType = auth.type;
      authorizationId = auth.id;
      sellerActor = auth.authorizedUser;
      if (auth.minPrice && new Prisma.Decimal(params.salePrice).lt(auth.minPrice)) throw new Error('AUTHORIZATION_MIN_PRICE_NOT_MET');
    }

    if (vehicle.owner.phoneStatus !== 'VERIFIED') throw new Error('SELLER_NOT_PHONE_VERIFIED');
    const buyer = await tx.user.findUnique({ where: { id: params.buyerId } });
    if (!buyer || buyer.status !== 'ACTIVE') throw new Error('BUYER_NOT_ACTIVE');
    if (buyer.phoneStatus !== 'VERIFIED') throw new Error('BUYER_NOT_PHONE_VERIFIED');

    const exchange = await tx.exchangeRate.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!exchange) throw new Error('EXCHANGE_RATE_NOT_CONFIGURED');

    const payoutUserId = authorityType === 'SELL_ONLY' ? vehicle.ownerId : params.sellerId;

    // The vehicleId predicate is the authoritative atomic reservation guard.
    const locked = await tx.vehicle.updateMany({ where: { id: params.vehicleId, status: 'ACTIVE', isReserved: false }, data: { status: 'PENDING', isReserved: true } });
    if (locked.count !== 1) throw new Error('VEHICLE_ALREADY_LOCKED');

    // Payout guard runs AFTER the atomic lock so lock-race semantics are unchanged
    // (the loser still gets VEHICLE_ALREADY_LOCKED). On failure the whole transaction
    // rolls back, which also reverts the reservation above — no leaked lock, no sale.
    await assertPayoutAccount(tx, payoutUserId);

    const price = new Prisma.Decimal(params.salePrice);
    const listingType = params.listingType ?? (params.auctionId ? 'AUCTION' : 'MARKET');
    const listingCommissionUSD = calculateListingCommissionUsd(listingType === 'EXHIBITION' ? 'EXHIBITION' : 'DIRECT_MARKET', Boolean(params.soldThroughExhibitionService));
    const auctionFeeYER = new Prisma.Decimal(params.auctionFeeYer ?? 0);
    if (listingType !== 'AUCTION' && auctionFeeYER.gt(0)) throw new Error('AUCTION_FEE_REQUIRES_AUCTION');
    const transferFeeYER = new Prisma.Decimal(TRANSFER_FEE_USD).mul(exchange.usdToYer);
    const platformFeeYER = new Prisma.Decimal(FEES.PLATFORM_USD).mul(exchange.usdToYer);
    const listingFeeYER = new Prisma.Decimal(listingCommissionUSD).mul(exchange.usdToYer);
    const total = price.add(auctionFeeYER).add(transferFeeYER).add(platformFeeYER).add(listingFeeYER);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DIRECT_SALE_EXPIRATION_MS);

    const sale = await tx.vehicleSale.create({ data: {
      vehicleId: params.vehicleId,
      sellerId: params.sellerId,
      sellerName: sellerActor.fullName,
      sellerNationalId: sellerActor.nationalId ?? '',
      sellerPhone: sellerActor.phone,
      sellerVerified: true,
      payoutUserId,
      buyerId: params.buyerId,
      buyerName: buyer.fullName,
      buyerNationalId: buyer.nationalId ?? '',
      buyerPhone: buyer.phone,
      buyerVerified: true,
      vehicleAmountYER: price,
      platformFeeUSD: FEES.PLATFORM_USD,
      platformFeeYER,
      transferFeeUSD: TRANSFER_FEE_USD,
      transferFeeYER,
      listingCommissionUSD,
      auctionFeeYER,
      governmentFeesYER: 0,
      totalPaidYER: total,
      sellerPayoutYER: price,
      platformRevenueYER: listingFeeYER.add(auctionFeeYER).add(transferFeeYER).add(platformFeeYER),
      exchangeRate: exchange.usdToYer,
      exchangeRateId: exchange.id,
      auctionId: params.auctionId,
      authorizationId,
      status: 'BUYER_PENDING',
      statusHistory: [{ event: 'SALE_CREATED', at: now.toISOString() }, { event: 'BUYER_PENDING', at: now.toISOString() }],
      expiresAt,
    }});
    await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: params.sellerId, userName: sellerActor.fullName, action: 'SALE_CREATED', newStatus: 'BUYER_PENDING', metadata: { legalOwnerId: vehicle.ownerId, sellerActorId: params.sellerId, authorizationId: authorizationId ?? null, expiresAt: expiresAt.toISOString() } } });
    return sale;
  });
}

export async function verifySalePartyOtp(params: { saleId: string; actorId: string; otpId: string; otp: string; party: 'BUYER' | 'SELLER' }) {
  const sale = await db.vehicleSale.findUnique({ where: { id: params.saleId } });
  if (!sale) throw new Error('SALE_NOT_FOUND');
  const expectedUserId = params.party === 'BUYER' ? sale.buyerId : sale.sellerId;
  if (expectedUserId !== params.actorId) throw new Error('FORBIDDEN');
  if (sale.expiresAt <= new Date()) throw new Error('SALE_EXPIRED');
  await otpService.verifyOtp({ otpId: params.otpId, otp: params.otp, operationId: sale.id, type: params.party });
  const data = params.party === 'BUYER' ? { buyerOtpId: params.otpId, buyerOtpVerified: true } : { sellerOtpId: params.otpId, sellerOtpVerified: true };
  return db.vehicleSale.update({ where: { id: sale.id }, data });
}

export async function confirmSalePayment(saleId: string, providerReference: string, idempotencyKey: string, providerAmountYER?: Prisma.Decimal | number | string) {
  if (!process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET) throw new Error('NOT_CONFIGURED:PAYMENT_PROVIDER_REQUIRED');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: saleId } });
    if (!sale) throw new Error('SALE_NOT_FOUND');
    const now = new Date();
    if (sale.expiresAt <= now) throw new Error('SALE_EXPIRED');
    if (!providerReference || !idempotencyKey) throw new Error('PAYMENT_REFERENCE_REQUIRED');
    if (providerAmountYER === undefined) throw new Error('PAYMENT_AMOUNT_REQUIRED');
    if (!new Prisma.Decimal(providerAmountYER).eq(sale.totalPaidYER)) throw new Error('PAYMENT_AMOUNT_MISMATCH');

    const [existingByProvider, existingByIdempotency] = await Promise.all([
      tx.paymentTransaction.findUnique({ where: { providerReference } }),
      tx.paymentTransaction.findUnique({ where: { idempotencyKey } }),
    ]);
    const completed = sale.paymentVerified;
    if (completed) {
      if (!existingByProvider) throw new Error('PAYMENT_PROVIDER_REFERENCE_MISMATCH');
      if (!existingByIdempotency || existingByIdempotency.id !== existingByProvider.id) throw new Error('IDEMPOTENCY_KEY_REUSED');
      if (existingByProvider.vehicleSaleId !== sale.id || existingByProvider.userId !== sale.buyerId || existingByProvider.currency !== 'YER' || !existingByProvider.amount.eq(sale.totalPaidYER)) {
        throw new Error('PAYMENT_SALE_MISMATCH');
      }
      return sale;
    }
    if (!['BUYER_ACCEPTED', 'PAYMENT_PROCESSING', 'WAITING_PAYMENT', 'PAYMENT_PENDING_VERIFICATION', 'PAYMENT_VERIFIED'].includes(sale.status)) {
      throw new Error(`INVALID_PAYMENT_STATE:${sale.status}`);
    }
    if (!sale.buyerOtpVerified && !sale.auctionId) throw new Error('BUYER_OTP_REQUIRED');
    if (existingByProvider) throw new Error('ALREADY_PROCESSED');
    if (existingByIdempotency) {
      if (existingByIdempotency.providerReference !== providerReference) throw new Error('IDEMPOTENCY_KEY_REUSED');
      throw new Error('ALREADY_PROCESSED');
    }

    await tx.paymentTransaction.create({ data: { userId: sale.buyerId!, ownershipTransferId: null, vehicleSaleId: sale.id, amount: sale.totalPaidYER, currency: 'YER', provider: 'EXTERNAL', providerReference, idempotencyKey, status: 'SUCCESS' } });
    const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
    const nextHistory = [...history, { event: 'PAYMENT_CONFIRMED', at: now.toISOString(), providerReference }];
    const updated = await tx.vehicleSale.update({ where: { id: saleId }, data: { paymentVerified: true, fundsSecured: false, status: 'PAYMENT_CONFIRMED', statusHistory: nextHistory } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: saleId, userId: sale.buyerId!, userName: sale.buyerName ?? '', action: 'PAYMENT_CONFIRMED', oldStatus: sale.status, newStatus: 'PAYMENT_CONFIRMED', reference: providerReference, metadata: { idempotencyKey } } });
    return updated;
  });
}

export async function confirmEscrowHeld(params: { saleId: string; escrowProviderReference: string; paymentProviderReference: string; amountYER: Prisma.Decimal | number | string; currency: string }) {
  if (!process.env.ESCROW_PROVIDER_URL || !process.env.ESCROW_PROVIDER_SECRET) throw new Error('NOT_CONFIGURED:ESCROW_PROVIDER_REQUIRED');
  if (params.currency !== 'YER') throw new Error('ESCROW_CURRENCY_MISMATCH');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${params.saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: params.saleId } });
    if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
    if (!new Prisma.Decimal(params.amountYER).eq(sale.totalPaidYER)) throw new Error('ESCROW_AMOUNT_MISMATCH');
    const payment = await tx.paymentTransaction.findUnique({ where: { providerReference: params.paymentProviderReference } });
    if (!payment || payment.vehicleSaleId !== sale.id || payment.userId !== sale.buyerId || !payment.amount.eq(sale.totalPaidYER) || payment.currency !== params.currency) throw new Error('ESCROW_PAYMENT_MISMATCH');
    if (sale.fundsSecured || sale.status === 'ESCROW_HELD') {
      if (sale.escrowTransactionId !== params.escrowProviderReference) throw new Error('ESCROW_PROVIDER_REFERENCE_MISMATCH');
      return sale;
    }
    if (sale.status !== 'PAYMENT_CONFIRMED') throw new Error(`INVALID_ESCROW_STATE:${sale.status}`);
    const replay = await tx.escrowTransaction.findFirst({ where: { escrowProviderReference: params.escrowProviderReference, vehicleSaleId: { not: sale.id } } });
    if (replay) throw new Error('ESCROW_PROVIDER_REFERENCE_REPLAY');
    await tx.escrowTransaction.create({ data: { vehicleSaleId: sale.id, vehicleAmountYER: sale.vehicleAmountYER, platformFeeUSD: sale.platformFeeUSD, platformFeeYER: sale.platformFeeYER, transferFeeUSD: sale.transferFeeUSD, transferFeeYER: sale.transferFeeYER, listingCommissionUSD: sale.listingCommissionUSD, auctionFeeYER: sale.auctionFeeYER, governmentFeesYER: sale.governmentFeesYER, totalPaidYER: sale.totalPaidYER, sellerPayoutYER: sale.sellerPayoutYER, platformRevenueYER: sale.platformRevenueYER, exchangeRate: sale.exchangeRate, status: 'HELD', paymentProviderReference: params.paymentProviderReference, escrowProviderReference: params.escrowProviderReference, securedAt: new Date() } });
    await createDoubleEntry({ transactionId: sale.id, entryGroupId: `ESCROW:${sale.id}`, amount: sale.totalPaidYER, currency: 'YER', debitType: 'CUSTOMER_FUNDS', creditType: 'ESCROW_FUNDS', userId: sale.buyerId, relatedOperationId: sale.id, providerRef: params.escrowProviderReference, idempotencyKey: `ESCROW:${sale.id}` }, tx);
    const fees: Array<[string, Prisma.Decimal, string]> = [['PLATFORM', sale.platformFeeYER, 'PLATFORM_FEES'], ['TRANSFER', sale.transferFeeYER, 'TRANSFER_FEES'], ['AUCTION', sale.auctionFeeYER, 'AUCTION_FEES'], ['EXHIBITION', new Prisma.Decimal(sale.listingCommissionUSD).mul(sale.exchangeRate), 'LISTING_SALES_COMMISSION'], ['GOVERNMENT', sale.governmentFeesYER, 'GOVERNMENT_FEES']];
    for (const [name, amount, creditType] of fees) if (amount.gt(0)) await createDoubleEntry({ transactionId: sale.id, entryGroupId: `FEE:${name}:${sale.id}`, amount, currency: 'YER', debitType: 'ESCROW_FUNDS', creditType, userId: sale.sellerId, relatedOperationId: sale.id, providerRef: params.escrowProviderReference, idempotencyKey: `FEE:${name}:${sale.id}` }, tx);
    if (sale.auctionId && sale.bidDepositYER.gt(0)) await tx.auctionBidDeposit.updateMany({ where: { auctionId: sale.auctionId, bidderId: sale.buyerId, status: 'HOLD' }, data: { status: 'APPLIED' } });
    const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
    const updated = await tx.vehicleSale.update({ where: { id: sale.id }, data: { fundsSecured: true, escrowTransactionId: params.escrowProviderReference, status: 'ESCROW_HELD', statusHistory: [...history, { event: 'ESCROW_HELD', at: new Date().toISOString(), providerReference: params.escrowProviderReference }] } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: sale.buyerId, userName: sale.buyerName ?? '', action: 'ESCROW_HELD', oldStatus: sale.status, newStatus: 'ESCROW_HELD', reference: params.escrowProviderReference, metadata: { paymentProviderReference: params.paymentProviderReference } } });
    return updated;
  });
}

export async function confirmOwnershipTransfer(saleId: string, providerReference: string) {
  if (!process.env.TRAFFIC_PROVIDER_URL || !process.env.TRAFFIC_PROVIDER_SECRET) throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED');
  try { return await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: saleId } });
    if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
    if (sale.status === 'HANDOVER_PENDING' && sale.governmentReference === providerReference) return sale;
    if (!['ESCROW_HELD', 'TRANSFER_PENDING', 'TRANSFER_IN_PROGRESS'].includes(sale.status)) throw new Error(`INVALID_TRANSFER_STATE:${sale.status}`);
    if (!sale.sellerOtpVerified) throw new Error('SELLER_OTP_REQUIRED');
    if (!providerReference) throw new Error('TRAFFIC_PROVIDER_REFERENCE_REQUIRED');
    const replay = await tx.vehicleSale.findFirst({ where: { governmentReference: providerReference, id: { not: saleId } }, select: { id: true } });
    if (replay) throw new Error('TRAFFIC_PROVIDER_REFERENCE_REPLAY');
    const vehicle = await tx.vehicle.findUnique({ where: { id: sale.vehicleId } });
    if (!vehicle || vehicle.hasLegalBlock) throw new Error('TRANSFER_BLOCKED');
    await tx.vehicleOwnership.updateMany({ where: { vehicleId: sale.vehicleId, ownershipStatus: 'ACTIVE' }, data: { ownershipStatus: 'PREVIOUS' } });
    await tx.vehicleOwnership.create({ data: { vehicleId: sale.vehicleId, ownerId: sale.buyerId, ownershipStatus: 'ACTIVE', verifiedAt: new Date() } });
    await tx.vehicle.update({ where: { id: sale.vehicleId }, data: { ownerId: sale.buyerId, isReserved: true, status: 'SOLD' } });
    const now = new Date();
    const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
    return tx.vehicleSale.update({ where: { id: saleId }, data: { governmentReference: providerReference, governmentStatus: 'TRANSFERRED', status: 'HANDOVER_PENDING', statusHistory: [...history, { event: 'OWNERSHIP_TRANSFERRED', at: now.toISOString(), providerReference }, { event: 'HANDOVER_PENDING', at: now.toISOString(), providerReference }] } });
  }); } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new Error('TRAFFIC_PROVIDER_REFERENCE_REPLAY');
    throw error;
  }
}

export async function confirmHandover(params: { saleId: string; actorId: string; buyerOtpId: string; buyerOtp: string; sellerOtpId: string; sellerOtp: string; qrValue: string; mileage: number; photos?: Prisma.InputJsonValue; notes?: string }) {
  const sale = await db.vehicleSale.findUnique({ where: { id: params.saleId } });
  if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
  if (![sale.buyerId, sale.sellerId, sale.payoutUserId].includes(params.actorId)) throw new Error('FORBIDDEN');
  if (sale.status !== 'HANDOVER_PENDING') throw new Error(`INVALID_HANDOVER_STATE:${sale.status}`);
  const expectedQr = createHash('sha256').update(`${sale.id}|${sale.vehicleId}|HANDOVER`).digest('hex');
  if (params.qrValue !== expectedQr) throw new Error('HANDOVER_QR_INVALID');
  if (!Number.isInteger(params.mileage) || params.mileage < 0) throw new Error('INVALID_MILEAGE');

  // OTPs are consumed exactly once in PostgreSQL; no OTP value is returned/logged.
  await otpService.verifyOtp({ otpId: params.buyerOtpId, otp: params.buyerOtp, operationId: sale.id, type: 'BUYER' });
  await otpService.verifyOtp({ otpId: params.sellerOtpId, otp: params.sellerOtp, operationId: sale.id, type: 'SELLER' });

  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${params.saleId} FOR UPDATE`;
    const current = await tx.vehicleSale.findUnique({ where: { id: params.saleId } });
    if (!current || current.status !== 'HANDOVER_PENDING' || !current.buyerId) throw new Error('HANDOVER_STATE_CHANGED');
    const now = new Date();
    const protection = new Date(now.getTime() + PAYOUT_PROTECTION_MINUTES * 60 * 1000);
    await tx.handoverEvidence.create({ data: { saleTransactionId: current.id, vehicleId: current.vehicleId, buyerId: current.buyerId, sellerId: current.sellerId, buyerOtpVerifiedAt: now, sellerOtpVerifiedAt: now, buyerNotes: params.notes, recordedMileage: params.mileage, photoUrls: params.photos } });
    const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
    return tx.vehicleSale.update({ where: { id: current.id }, data: { handoverConfirmedAt: now, payoutProtectionUntil: protection, status: 'PAYOUT_PROTECTION', statusHistory: [...history, { event: 'HANDOVER_CONFIRMED', at: now.toISOString(), actorId: params.actorId }, { event: 'PAYOUT_PROTECTION', at: now.toISOString(), until: protection.toISOString() }] } });
  });
}

export async function releasePayout(saleId: string, actorId: string) {
  const providerUrl = process.env.PAYOUT_PROVIDER_URL;
  const providerSecret = process.env.PAYOUT_PROVIDER_SECRET;
  if (!providerUrl || !providerSecret) throw new Error('NOT_CONFIGURED:PAYOUT_PROVIDER_REQUIRED');

  const claimed = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: saleId } });
    if (!sale) throw new Error('SALE_NOT_FOUND');
    if (sale.status === 'PAYOUT_CONFIRMED') return { blocked: false as const, alreadyConfirmed: true as const, sale };
    if (sale.status === 'DISPUTED' || sale.status === 'MANUAL_REVIEW' || sale.status === 'PAYOUT_REVIEW_REQUIRED') throw new Error('PAYOUT_FROZEN');
    if (!sale.payoutProtectionUntil || sale.payoutProtectionUntil > new Date()) throw new Error('PAYOUT_PROTECTION_ACTIVE');
    if (!['PAYOUT_PROTECTION', 'PAYOUT_PENDING', 'RELEASE_FAILED'].includes(sale.status)) throw new Error('INVALID_PAYOUT_STATE');
    const payoutUserId = sale.payoutUserId ?? sale.sellerId;
    try {
      await assertPayoutAccount(tx, payoutUserId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'PAYOUT_REVIEW_REQUIRED';
      if (reason === 'PAYOUT_ACCOUNT_REQUIRED' || reason === 'PAYOUT_REVIEW_REQUIRED') {
        const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
        const blocked = await tx.vehicleSale.update({ where: { id: saleId }, data: { status: 'PAYOUT_REVIEW_REQUIRED', statusHistory: [...history, { event: 'PAYOUT_REVIEW_REQUIRED', at: new Date().toISOString(), reason }] } });
        await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: actorId, userName: actorId, action: 'PAYOUT_REVIEW_REQUIRED', oldStatus: sale.status, newStatus: 'PAYOUT_REVIEW_REQUIRED', metadata: { reason } } });
        return { blocked: true as const, alreadyConfirmed: false as const, sale: blocked };
      }
      throw error;
    }
    const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
    const processing = await tx.vehicleSale.update({ where: { id: saleId }, data: { status: 'PAYOUT_PROCESSING', releaseReadyAt: new Date(), statusHistory: [...history, { event: sale.status === 'RELEASE_FAILED' ? 'PAYOUT_RETRY_STARTED' : 'PAYOUT_PROCESSING', at: new Date().toISOString(), actorId }] } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: actorId, userName: actorId, action: sale.status === 'RELEASE_FAILED' ? 'PAYOUT_RETRY_STARTED' : 'PAYOUT_PROCESSING', oldStatus: sale.status, newStatus: 'PAYOUT_PROCESSING' } });
    return { blocked: false as const, alreadyConfirmed: false as const, sale: processing };
  });

  if (claimed.blocked) throw new Error('PAYOUT_REVIEW_REQUIRED');
  if (claimed.alreadyConfirmed) return claimed.sale;
  let providerReference = '';
  try {
    const response = await fetch(providerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${providerSecret}` },
      body: JSON.stringify({ saleId: claimed.sale.id, recipientUserId: claimed.sale.payoutUserId ?? claimed.sale.sellerId, amount: claimed.sale.sellerPayoutYER.toString(), currency: 'YER', idempotencyKey: `PAYOUT:${claimed.sale.id}` }),
    });
    if (!response.ok) throw new Error('PAYOUT_PROVIDER_FAILED');
    const result = await response.json() as { status?: string; providerReference?: string };
    if (result.status !== 'SUCCESS' || !result.providerReference) throw new Error('PAYOUT_NOT_CONFIRMED');
    providerReference = result.providerReference;
  } catch (error) {
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${claimed.sale.id} FOR UPDATE`;
      const current = await tx.vehicleSale.findUnique({ where: { id: claimed.sale.id } });
      if (!current || current.status !== 'PAYOUT_PROCESSING') return;
      const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
      await tx.vehicleSale.update({ where: { id: current.id }, data: { status: 'RELEASE_FAILED', statusHistory: [...history, { event: 'PAYOUT_FAILED', at: new Date().toISOString(), actorId }] } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: current.id, userId: actorId, userName: actorId, action: 'PAYOUT_FAILED', oldStatus: 'PAYOUT_PROCESSING', newStatus: 'RELEASE_FAILED' } });
    });
    throw error;
  }

  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
    const current = await tx.vehicleSale.findUnique({ where: { id: saleId } });
    if (!current) throw new Error('SALE_NOT_FOUND');
    if (current.status === 'PAYOUT_CONFIRMED') return current;
    if (current.status !== 'PAYOUT_PROCESSING') throw new Error('PAYOUT_STATE_CHANGED');
    await createDoubleEntry({ transactionId: current.id, entryGroupId: `PAYOUT:${current.id}`, amount: current.sellerPayoutYER, currency: 'YER', debitType: 'ESCROW_FUNDS', creditType: 'SELLER_PAYOUTS', userId: current.payoutUserId ?? current.sellerId, relatedOperationId: current.id, providerRef: providerReference, idempotencyKey: `PAYOUT:${current.id}` }, tx);
    const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
    const final = await tx.vehicleSale.update({ where: { id: current.id }, data: { status: 'PAYOUT_CONFIRMED', statusHistory: [...history, { event: 'PAYOUT_CONFIRMED', at: new Date().toISOString(), providerReference }] } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: current.id, userId: actorId, userName: actorId, action: 'PAYOUT_CONFIRMED', oldStatus: 'PAYOUT_PROCESSING', newStatus: 'PAYOUT_CONFIRMED', reference: providerReference } });
    return final;
  });
}

export async function advanceSaleStatus(saleId: string, requestedStatus: SaleStatus, actorId: string, metadata?: Prisma.InputJsonValue) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: saleId } });
    if (!sale) throw new Error('SALE_NOT_FOUND');
    const actor = await tx.user.findUnique({ where: { id: actorId } });
    if (!actor) throw new Error('ACTOR_NOT_FOUND');
    const nextStatus = normalizeRequestedStatus(requestedStatus);

    if (sale.expiresAt <= new Date() && !['COMPLETED', 'OWNERSHIP_TRANSFERRED', 'PAYOUT_PROTECTION', 'PAYOUT_PENDING', 'PAYOUT_PROCESSING', 'PAYOUT_CONFIRMED'].includes(nextStatus)) {
      if (!['EXPIRED', 'CANCELLED'].includes(nextStatus)) throw new Error('SALE_EXPIRED');
    }
    ensureTransition(sale.status, nextStatus);

    if (nextStatus === 'BUYER_ACCEPTED' && sale.buyerId !== actorId && !['ADMIN', 'SUPER_ADMIN', 'OWNER'].includes(actor.role)) throw new Error('BUYER_APPROVAL_REQUIRED');
    if (nextStatus === 'CANCELLED' && !OPERATIONS_ROLES.has(actor.role) && ![
      'SALE_CREATED', 'BUYER_PENDING', 'BUYER_ACCEPTED', 'PAYMENT_PROCESSING', 'WAITING_BUYER_APPROVAL',
      'BUYER_APPROVED', 'BUYER_OTP_VERIFIED', 'WAITING_PAYMENT',
    ].includes(sale.status)) throw new Error('FUNDED_SALE_REQUIRES_DISPUTE');
    if (nextStatus === 'OWNERSHIP_TRANSFERRED') throw new Error('USE_GOVERNMENT_PROVIDER_TRANSFER');
    if (['PAYOUT_PENDING', 'PAYOUT_PROCESSING', 'PAYOUT_CONFIRMED'].includes(nextStatus)) {
      const payoutUserId = sale.payoutUserId ?? sale.sellerId;
      await assertPayoutAccount(tx, payoutUserId);
    }

    const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
    const updated = await tx.vehicleSale.update({ where: { id: saleId }, data: { status: nextStatus, statusHistory: [...history, { event: nextStatus, at: new Date().toISOString(), actorId, ...(metadata ? { metadata } : {}) }] } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: saleId, userId: actorId, userName: actor.fullName, action: 'STATUS_CHANGE', oldStatus: sale.status, newStatus: nextStatus, metadata } });
    if (['CANCELLED', 'REJECTED', 'EXPIRED', 'PAYMENT_FAILED', 'TRANSFER_FAILED'].includes(nextStatus)) await tx.vehicle.updateMany({ where: { id: sale.vehicleId, isReserved: true, status: 'PENDING' }, data: { isReserved: false, status: 'ACTIVE' } });
    return updated;
  });
}
