import { createHash } from 'crypto';
import { Prisma, SaleStatus, type LedgerEntryType } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { FEES, calculateListingCommissionUsd } from './fees';
import { readBoundedResponseText } from './http-bounds';
import { isIdentityVerified } from './identity-policy';
import { createDoubleEntry } from './ledger';
import { otpService } from './otp';
import { requireProviderEndpoint } from './provider-endpoint';

export const TRANSFER_FEE_USD = FEES.TRANSFER_USD;
export const PAYOUT_PROTECTION_MINUTES = Number(process.env.PAYOUT_PROTECTION_MINUTES ?? 15);
export const DIRECT_SALE_EXPIRATION_MS = 2 * 60 * 60 * 1000;
export const SELLER_CONFIRMATION_EXPIRATION_MS = Number(process.env.SELLER_CONFIRMATION_EXPIRY_MINUTES ?? 10) * 60 * 1000;

export type SaleOtpPurpose = 'SALE_CONSENT' | 'HANDOVER';

export function saleOtpOperationId(saleId: string, purpose: SaleOtpPurpose) {
  return `${saleId}:${purpose}`;
}

export function isHandoverConsentBound(params: {
  saleId: string;
  party: 'BUYER' | 'SELLER';
  userId: string;
  operation: { type: string; status: string; userId: string; providerReference: string | null; metadata: Prisma.JsonValue | null } | null;
  otp: { id: string; operationId: string; type: string; userId: string | null; isUsed: boolean; verifiedAt: Date | null } | null;
}) {
  const metadata = params.operation?.metadata && typeof params.operation.metadata === 'object' && !Array.isArray(params.operation.metadata)
    ? params.operation.metadata as Record<string, unknown>
    : null;
  return params.operation?.type === 'HANDOVER_PARTY_CONSENT'
    && params.operation.status === 'SUCCESS'
    && params.operation.userId === params.userId
    && metadata?.saleId === params.saleId
    && metadata?.party === params.party
    && Boolean(params.operation.providerReference)
    && params.otp?.id === params.operation.providerReference
    && params.otp.operationId === saleOtpOperationId(params.saleId, 'HANDOVER')
    && params.otp.type === params.party
    && params.otp.userId === params.userId
    && params.otp.isUsed
    && Boolean(params.otp.verifiedAt);
}

export function assertTrafficTransferRequestBinding(params: {
  saleId: string;
  saleGovernmentReference: string | null;
  providerReference: string;
  operation: { type: string; status: string; providerReference: string | null; metadata: Prisma.JsonValue | null } | null;
}) {
  const operation = params.operation;
  const metadata = operation?.metadata && typeof operation.metadata === 'object' && !Array.isArray(operation.metadata)
    ? operation.metadata as Record<string, unknown>
    : null;
  if (!operation || operation.type !== 'TRAFFIC_TRANSFER_REQUEST' || operation.status !== 'SUCCESS' || operation.providerReference !== params.providerReference || metadata?.saleId !== params.saleId || params.saleGovernmentReference !== params.providerReference) {
    throw new Error('TRAFFIC_TRANSFER_REQUEST_MISMATCH');
  }
}

const financialProviderResponseSchema = z.object({
  status: z.string().max(40).optional(),
  providerReference: z.string().trim().min(1).max(300).optional(),
});

async function parseFinancialProviderResponse(response: Response, errorCode: string) {
  const body = await readBoundedResponseText(response, 64 * 1024, errorCode);
  if (!body) throw new Error(errorCode);
  let json: unknown;
  try { json = JSON.parse(body); } catch { throw new Error(errorCode); }
  const parsed = financialProviderResponseSchema.safeParse(json);
  if (!parsed.success) throw new Error(errorCode);
  return parsed.data;
}

/** Canonical sale state machine. Legacy states remain in Prisma for backward compatibility. */
const TRANSITIONS: Record<SaleStatus, SaleStatus[]> = {
  SALE_CREATED: ['BUYER_PENDING', 'CANCELLED', 'EXPIRED'],
  BUYER_PENDING: ['BUYER_ACCEPTED', 'CANCELLED', 'EXPIRED'],
  BUYER_ACCEPTED: ['PAYMENT_PROCESSING', 'CANCELLED', 'EXPIRED'],
  PAYMENT_PROCESSING: ['PAYMENT_CONFIRMED', 'PAYMENT_PENDING_VERIFICATION', 'PAYMENT_FAILED', 'REFUND_PENDING', 'MANUAL_REVIEW'],
  PAYMENT_CONFIRMED: ['ESCROW_HELD', 'REFUND_PENDING', 'MANUAL_REVIEW'],
  ESCROW_HELD: ['TRANSFER_PENDING', 'TRANSFER_IN_PROGRESS', 'DISPUTED', 'REFUND_PENDING', 'CANCELLED'],
  TRANSFER_PENDING: ['TRANSFER_IN_PROGRESS', 'TRANSFER_BLOCKED', 'REFUND_PENDING', 'MANUAL_REVIEW'],
  TRANSFER_IN_PROGRESS: ['OWNERSHIP_TRANSFERRED', 'TRANSFER_BLOCKED', 'TRANSFER_FAILED', 'REFUND_PENDING', 'MANUAL_REVIEW'],
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
  REFUND_PENDING: ['REFUND_PROCESSING', 'MANUAL_REVIEW'],
  REFUND_PROCESSING: ['REFUNDED', 'REFUND_FAILED', 'MANUAL_REVIEW'],
  REFUND_FAILED: ['REFUND_PROCESSING', 'MANUAL_REVIEW'],
  REFUNDED: [],

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
  const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true, phoneStatus: true, identityStatus: true, nationalId: true } });
  if (!user || user.status !== 'ACTIVE') throw new Error('PAYOUT_USER_NOT_ACTIVE');
  if (user.phoneStatus !== 'VERIFIED') throw new Error('PAYOUT_USER_PHONE_NOT_VERIFIED');
  if (!isIdentityVerified(user)) throw new Error('PAYOUT_USER_IDENTITY_NOT_VERIFIED');
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
    if (vehicle.hasLegalBlock || vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_RESTRICTED');

    let authorityType: 'SELL_ONLY' | 'SELL_AND_RECEIVE' = 'SELL_AND_RECEIVE';
    let authorizationId: string | undefined;
    let sellerActor = vehicle.owner;
    if (vehicle.ownerId !== params.sellerId) {
      const candidate = await tx.vehicleAuthorization.findFirst({
        where: { vehicleId: params.vehicleId, authorizedUserId: params.sellerId, ownerId: vehicle.ownerId, status: 'ACTIVE', validUntil: { gt: new Date() } },
        select: { id: true },
      });
      if (!candidate) throw new Error('VALID_AUTHORIZATION_REQUIRED');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`AUTHORIZATION:${candidate.id}`}))`;
      const auth = await tx.vehicleAuthorization.findFirst({
        where: { id: candidate.id, vehicleId: params.vehicleId, authorizedUserId: params.sellerId, ownerId: vehicle.ownerId, status: 'ACTIVE', validUntil: { gt: new Date() } },
        include: { authorizedUser: true },
      });
      if (!auth) throw new Error('VALID_AUTHORIZATION_REQUIRED');
      authorityType = auth.type;
      authorizationId = auth.id;
      sellerActor = auth.authorizedUser;
      if (auth.minPrice && new Prisma.Decimal(params.salePrice).lt(auth.minPrice)) throw new Error('AUTHORIZATION_MIN_PRICE_NOT_MET');
    }

    if (vehicle.owner.status !== 'ACTIVE') throw new Error('VEHICLE_OWNER_NOT_ACTIVE');
    if (vehicle.owner.phoneStatus !== 'VERIFIED') throw new Error('SELLER_NOT_PHONE_VERIFIED');
    if (!isIdentityVerified(vehicle.owner)) throw new Error('SELLER_IDENTITY_NOT_VERIFIED');
    if (sellerActor.status !== 'ACTIVE') throw new Error('SELLER_NOT_ACTIVE');
    if (sellerActor.phoneStatus !== 'VERIFIED') throw new Error('SELLER_NOT_PHONE_VERIFIED');
    if (!isIdentityVerified(sellerActor)) throw new Error('SELLER_IDENTITY_NOT_VERIFIED');
    const buyer = await tx.user.findUnique({ where: { id: params.buyerId } });
    if (!buyer || buyer.status !== 'ACTIVE') throw new Error('BUYER_NOT_ACTIVE');
    if (buyer.phoneStatus !== 'VERIFIED') throw new Error('BUYER_NOT_PHONE_VERIFIED');
    if (!isIdentityVerified(buyer)) throw new Error('BUYER_IDENTITY_NOT_VERIFIED');

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
    // The buyer's two-hour decision/payment window starts only after the seller
    // proves possession of their registered phone.
    const expiresAt = new Date(now.getTime() + SELLER_CONFIRMATION_EXPIRATION_MS);

    const sale = await tx.vehicleSale.create({ data: {
      vehicleId: params.vehicleId,
      sellerId: params.sellerId,
      sellerName: sellerActor.fullName,
      sellerNationalId: sellerActor.nationalId ?? '',
      sellerPhone: sellerActor.phone,
      sellerVerified: isIdentityVerified(sellerActor) && sellerActor.phoneStatus === 'VERIFIED',
      payoutUserId,
      buyerId: params.buyerId,
      buyerName: buyer.fullName,
      buyerNationalId: buyer.nationalId ?? '',
      buyerPhone: buyer.phone,
      buyerVerified: isIdentityVerified(buyer) && buyer.phoneStatus === 'VERIFIED',
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
      status: 'SALE_CREATED',
      statusHistory: [{ event: 'SALE_CREATED', at: now.toISOString(), sellerOtpRequired: true }],
      expiresAt,
    }});
    await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: params.sellerId, userName: sellerActor.fullName, action: 'SALE_CREATED', newStatus: 'SALE_CREATED', metadata: { legalOwnerId: vehicle.ownerId, sellerActorId: params.sellerId, authorizationId: authorizationId ?? null, sellerOtpDeadline: expiresAt.toISOString() } } });
    return sale;
  });
}

export async function requestSalePartyOtp(params: { saleId: string; actorId: string; ip?: string; deviceId?: string }) {
  const sale = await db.vehicleSale.findUnique({ where: { id: params.saleId } });
  if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
  const party = sale.sellerId === params.actorId ? 'SELLER' : sale.buyerId === params.actorId ? 'BUYER' : null;
  if (!party) throw new Error('FORBIDDEN');
  const allowed = party === 'SELLER'
    ? ['SALE_CREATED', 'HANDOVER_PENDING'].includes(sale.status) || Boolean(sale.auctionId && sale.status === 'WAITING_PAYMENT' && !sale.sellerOtpVerified)
    : ['BUYER_ACCEPTED', 'HANDOVER_PENDING'].includes(sale.status);
  if (!allowed) throw new Error(`OTP_NOT_ALLOWED_IN_STATE:${sale.status}`);
  if (sale.status !== 'HANDOVER_PENDING' && sale.expiresAt <= new Date()) throw new Error('SALE_EXPIRED');
  const user = await db.user.findUnique({ where: { id: params.actorId } });
  if (!user || user.status !== 'ACTIVE') throw new Error('USER_NOT_ACTIVE');
  if (user.phoneStatus !== 'VERIFIED') throw new Error('PHONE_NOT_VERIFIED');
  if (!isIdentityVerified(user)) throw new Error('IDENTITY_NOT_VERIFIED');
  const purpose = sale.status === 'HANDOVER_PENDING' ? 'HANDOVER' as const : 'SALE_CONSENT' as const;
  const otp = await otpService.sendOtp({ phone: user.phone, operationId: saleOtpOperationId(sale.id, purpose), type: party, userId: user.id, ip: params.ip, deviceId: params.deviceId });
  return { ...otp, party, purpose };
}

export async function verifySalePartyOtp(params: { saleId: string; actorId: string; otpId: string; otp: string; party: 'BUYER' | 'SELLER' }) {
  const sale = await db.vehicleSale.findUnique({ where: { id: params.saleId } });
  if (!sale) throw new Error('SALE_NOT_FOUND');
  const expectedUserId = params.party === 'BUYER' ? sale.buyerId : sale.sellerId;
  if (!expectedUserId || expectedUserId !== params.actorId) throw new Error('FORBIDDEN');
  if (sale.expiresAt <= new Date()) throw new Error('SALE_EXPIRED');
  const auctionSellerConsent = params.party === 'SELLER' && Boolean(sale.auctionId) && sale.status === 'WAITING_PAYMENT';
  if (params.party === 'SELLER' && sale.status !== 'SALE_CREATED' && !auctionSellerConsent) throw new Error(`SELLER_OTP_NOT_ALLOWED_IN_STATE:${sale.status}`);
  if (params.party === 'BUYER' && (sale.status !== 'BUYER_ACCEPTED' || !sale.sellerOtpVerified)) throw new Error(`BUYER_OTP_NOT_ALLOWED_IN_STATE:${sale.status}`);
  await otpService.verifyOtp({ otpId: params.otpId, otp: params.otp, operationId: saleOtpOperationId(sale.id, 'SALE_CONSENT'), type: params.party, userId: expectedUserId });

  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${sale.id} FOR UPDATE`;
    const current = await tx.vehicleSale.findUnique({ where: { id: sale.id } });
    if (!current) throw new Error('SALE_NOT_FOUND');
    const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
    const now = new Date();
    if (params.party === 'SELLER') {
      if (current.sellerOtpVerified || (current.status !== 'SALE_CREATED' && !(current.auctionId && current.status === 'WAITING_PAYMENT'))) throw new Error('SALE_STATE_CHANGED');
      if (current.auctionId && current.status === 'WAITING_PAYMENT') {
        const updated = await tx.vehicleSale.update({ where: { id: current.id }, data: { sellerOtpId: params.otpId, sellerOtpVerified: true, statusHistory: [...history, { event: 'SELLER_OTP_VERIFIED', at: now.toISOString(), actorId: params.actorId, source: 'AUCTION_RESULT' }] } });
        await tx.saleAuditLog.create({ data: { vehicleSaleId: current.id, userId: params.actorId, userName: current.sellerName, action: 'SELLER_OTP_VERIFIED', oldStatus: current.status, newStatus: current.status, metadata: { source: 'AUCTION_RESULT' } } });
        if (current.buyerId) await tx.notification.create({ data: { userId: current.buyerId, type: 'SELLER_OTP', title: 'أصبحت عملية المزاد جاهزة للدفع', message: `أكد البائع نتيجة المزاد للعملية ${current.id}. يمكنك متابعة الدفع.`, priority: 'HIGH', operationId: current.id } });
        return updated;
      }
      const expiresAt = new Date(now.getTime() + DIRECT_SALE_EXPIRATION_MS);
      const updated = await tx.vehicleSale.update({ where: { id: current.id }, data: {
        sellerOtpId: params.otpId,
        sellerOtpVerified: true,
        status: 'BUYER_PENDING',
        expiresAt,
        statusHistory: [...history, { event: 'SELLER_OTP_VERIFIED', at: now.toISOString(), actorId: params.actorId }, { event: 'BUYER_PENDING', at: now.toISOString(), expiresAt: expiresAt.toISOString() }],
      } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: current.id, userId: params.actorId, userName: current.sellerName, action: 'SELLER_OTP_VERIFIED', oldStatus: 'SALE_CREATED', newStatus: 'BUYER_PENDING', metadata: { buyerWindowStartedAt: now.toISOString(), expiresAt: expiresAt.toISOString() } } });
      if (current.buyerId) await tx.notification.create({ data: { userId: current.buyerId, type: 'TRANSFER_REQUEST', title: 'لديك طلب بيع مركبة', message: `لديك طلب شراء مركبة رقم العملية ${current.id}`, priority: 'HIGH', operationId: current.id } });
      return updated;
    }
    if (current.status !== 'BUYER_ACCEPTED' || current.buyerOtpVerified || !current.sellerOtpVerified) throw new Error('SALE_STATE_CHANGED');
    const updated = await tx.vehicleSale.update({ where: { id: current.id }, data: { buyerOtpId: params.otpId, buyerOtpVerified: true, statusHistory: [...history, { event: 'BUYER_OTP_VERIFIED', at: now.toISOString(), actorId: params.actorId }] } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: current.id, userId: params.actorId, userName: current.buyerName ?? '', action: 'BUYER_OTP_VERIFIED', oldStatus: current.status, newStatus: current.status } });
    return updated;
  });
}

export async function confirmSalePayment(saleId: string, providerReference: string, idempotencyKey: string, providerAmountYER?: Prisma.Decimal | number | string) {
  if (!process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET) throw new Error('NOT_CONFIGURED:PAYMENT_PROVIDER_REQUIRED');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: saleId } });
    if (!sale) throw new Error('SALE_NOT_FOUND');
    const now = new Date();
    if (!providerReference || !idempotencyKey) throw new Error('PAYMENT_REFERENCE_REQUIRED');
    if (providerAmountYER === undefined) throw new Error('PAYMENT_AMOUNT_REQUIRED');
    if (!new Prisma.Decimal(providerAmountYER).eq(sale.totalPaidYER)) throw new Error('PAYMENT_AMOUNT_MISMATCH');

    const [existingByProvider, existingByIdempotency, paymentRequest] = await Promise.all([
      tx.paymentTransaction.findUnique({ where: { providerReference } }),
      tx.paymentTransaction.findUnique({ where: { idempotencyKey } }),
      tx.operation.findUnique({ where: { idempotencyKey: `PAYMENT:${saleId}` } }),
    ]);
    // New payment flows must be bound to the server-created request. Legacy
    // transactions without an Operation remain readable/reconcilable.
    if (paymentRequest && (paymentRequest.status !== 'SUCCESS' || paymentRequest.providerReference !== providerReference || idempotencyKey !== paymentRequest.idempotencyKey)) {
      throw new Error('PAYMENT_REQUEST_MISMATCH');
    }
    const completed = sale.paymentVerified;
    if (completed) {
      if (!existingByProvider) throw new Error('PAYMENT_PROVIDER_REFERENCE_MISMATCH');
      if (!existingByIdempotency || existingByIdempotency.id !== existingByProvider.id) throw new Error('IDEMPOTENCY_KEY_REUSED');
      if (existingByProvider.vehicleSaleId !== sale.id || existingByProvider.userId !== sale.buyerId || existingByProvider.currency !== 'YER' || !existingByProvider.amount.eq(sale.totalPaidYER)) {
        throw new Error('PAYMENT_SALE_MISMATCH');
      }
      return sale;
    }
    const acceptedPaymentStates: SaleStatus[] = ['BUYER_ACCEPTED', 'PAYMENT_PROCESSING', 'WAITING_PAYMENT', 'PAYMENT_PENDING_VERIFICATION', 'PAYMENT_VERIFIED'];
    const expired = sale.expiresAt <= now || sale.status === 'EXPIRED';
    if (!acceptedPaymentStates.includes(sale.status) && !(sale.status === 'EXPIRED' && (sale.buyerOtpVerified || Boolean(sale.auctionId)))) {
      throw new Error(`INVALID_PAYMENT_STATE:${sale.status}`);
    }
    if (!sale.sellerOtpVerified) throw new Error('SELLER_OTP_REQUIRED');
    if (!sale.buyerOtpVerified && !sale.auctionId) throw new Error('BUYER_OTP_REQUIRED');
    if (existingByProvider) throw new Error('ALREADY_PROCESSED');
    if (existingByIdempotency) {
      if (existingByIdempotency.providerReference !== providerReference) throw new Error('IDEMPOTENCY_KEY_REUSED');
      throw new Error('ALREADY_PROCESSED');
    }

    await tx.paymentTransaction.create({ data: { userId: sale.buyerId!, ownershipTransferId: null, vehicleSaleId: sale.id, amount: sale.totalPaidYER, currency: 'YER', provider: 'EXTERNAL', providerReference, idempotencyKey, status: 'SUCCESS' } });
    const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
    const nextStatus: SaleStatus = expired ? 'REFUND_PENDING' : 'PAYMENT_CONFIRMED';
    const event = expired ? 'LATE_PAYMENT_REFUND_PENDING' : 'PAYMENT_CONFIRMED';
    const updated = await tx.vehicleSale.update({ where: { id: saleId }, data: {
      paymentVerified: true,
      fundsSecured: false,
      status: nextStatus,
      refundIdempotencyKey: expired ? `REFUND:${sale.id}` : undefined,
      refundReason: expired ? 'PAYMENT_RECEIVED_AFTER_EXPIRY' : undefined,
      statusHistory: [...history, { event, at: now.toISOString(), providerReference }],
    } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: saleId, userId: sale.buyerId!, userName: sale.buyerName ?? '', action: event, oldStatus: sale.status, newStatus: nextStatus, reference: providerReference, metadata: { idempotencyKey } } });
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
    if (!payment || payment.status !== 'SUCCESS' || payment.vehicleSaleId !== sale.id || payment.userId !== sale.buyerId || !payment.amount.eq(sale.totalPaidYER) || payment.currency !== params.currency) throw new Error('ESCROW_PAYMENT_MISMATCH');
    if (sale.fundsSecured || sale.status === 'ESCROW_HELD') {
      if (sale.escrowTransactionId !== params.escrowProviderReference) throw new Error('ESCROW_PROVIDER_REFERENCE_MISMATCH');
      const existingEscrow = await tx.escrowTransaction.findUnique({ where: { vehicleSaleId: sale.id } });
      if (!existingEscrow || existingEscrow.status !== 'HELD' || existingEscrow.paymentProviderReference !== payment.providerReference || existingEscrow.escrowProviderReference !== params.escrowProviderReference || !existingEscrow.totalPaidYER.eq(sale.totalPaidYER)) throw new Error('ESCROW_INTEGRITY_FAILED');
      return sale;
    }
    if (sale.status !== 'PAYMENT_CONFIRMED') throw new Error(`INVALID_ESCROW_STATE:${sale.status}`);
    const replay = await tx.escrowTransaction.findFirst({ where: { escrowProviderReference: params.escrowProviderReference, vehicleSaleId: { not: sale.id } } });
    if (replay) throw new Error('ESCROW_PROVIDER_REFERENCE_REPLAY');
    await tx.escrowTransaction.create({ data: { vehicleSaleId: sale.id, vehicleAmountYER: sale.vehicleAmountYER, platformFeeUSD: sale.platformFeeUSD, platformFeeYER: sale.platformFeeYER, transferFeeUSD: sale.transferFeeUSD, transferFeeYER: sale.transferFeeYER, listingCommissionUSD: sale.listingCommissionUSD, auctionFeeYER: sale.auctionFeeYER, governmentFeesYER: sale.governmentFeesYER, totalPaidYER: sale.totalPaidYER, sellerPayoutYER: sale.sellerPayoutYER, platformRevenueYER: sale.platformRevenueYER, exchangeRate: sale.exchangeRate, status: 'HELD', paymentProviderReference: params.paymentProviderReference, escrowProviderReference: params.escrowProviderReference, securedAt: new Date() } });
    await createDoubleEntry({ transactionId: sale.id, entryGroupId: `ESCROW:${sale.id}`, amount: sale.totalPaidYER, currency: 'YER', debitType: 'CUSTOMER_FUNDS', creditType: 'ESCROW_FUNDS', userId: sale.buyerId, relatedOperationId: sale.id, providerRef: params.escrowProviderReference, idempotencyKey: `ESCROW:${sale.id}` }, tx);
    const fees: Array<[string, Prisma.Decimal, LedgerEntryType]> = [['PLATFORM', sale.platformFeeYER, 'PLATFORM_FEES'], ['TRANSFER', sale.transferFeeYER, 'TRANSFER_FEES'], ['AUCTION', sale.auctionFeeYER, 'AUCTION_FEES'], ['EXHIBITION', new Prisma.Decimal(sale.listingCommissionUSD).mul(sale.exchangeRate), 'LISTING_SALES_COMMISSION'], ['GOVERNMENT', sale.governmentFeesYER, 'GOVERNMENT_FEES']];
    for (const [name, amount, creditType] of fees) if (amount.gt(0)) await createDoubleEntry({ transactionId: sale.id, entryGroupId: `FEE:${name}:${sale.id}`, amount, currency: 'YER', debitType: 'ESCROW_FUNDS', creditType, userId: sale.sellerId, relatedOperationId: sale.id, providerRef: params.escrowProviderReference, idempotencyKey: `FEE:${name}:${sale.id}` }, tx);
    if (sale.auctionId && sale.bidDepositYER.gt(0)) await tx.auctionBidDeposit.updateMany({ where: { auctionId: sale.auctionId, bidderId: sale.buyerId, status: 'HOLD' }, data: { status: 'APPLIED' } });
    const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
    const updated = await tx.vehicleSale.update({ where: { id: sale.id }, data: { fundsSecured: true, escrowTransactionId: params.escrowProviderReference, status: 'ESCROW_HELD', statusHistory: [...history, { event: 'ESCROW_HELD', at: new Date().toISOString(), providerReference: params.escrowProviderReference }] } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: sale.buyerId, userName: sale.buyerName ?? '', action: 'ESCROW_HELD', oldStatus: sale.status, newStatus: 'ESCROW_HELD', reference: params.escrowProviderReference, metadata: { paymentProviderReference: params.paymentProviderReference } } });
    return updated;
  });
}

const REFUNDABLE_SALE_STATUSES = new Set<SaleStatus>([
  'PAYMENT_CONFIRMED',
  'PAYMENT_VERIFIED',
  'FUNDS_SECURED',
  'ESCROW_HELD',
  'TRANSFER_PENDING',
  'TRANSFER_IN_PROGRESS',
  'TRANSFER_BLOCKED',
  'DISPUTED',
  'MANUAL_REVIEW',
  'EXPIRED',
]);

/** Records the refund obligation before any provider call is attempted. */
export async function queueSaleRefund(saleId: string, reason: string, actorId = 'SYSTEM') {
  if (!reason.trim()) throw new Error('REFUND_REASON_REQUIRED');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: saleId } });
    if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
    if (['REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_FAILED', 'REFUNDED'].includes(sale.status)) return sale;
    if (!REFUNDABLE_SALE_STATUSES.has(sale.status)) throw new Error(`INVALID_REFUND_STATE:${sale.status}`);
    if (sale.governmentReference || ['OWNERSHIP_TRANSFERRED', 'HANDOVER_PENDING', 'HANDOVER_CONFIRMED', 'PAYOUT_PROTECTION', 'PAYOUT_PENDING', 'PAYOUT_PROCESSING', 'PAYOUT_CONFIRMED', 'COMPLETED'].includes(sale.status)) {
      throw new Error('REFUND_BLOCKED_AFTER_OWNERSHIP_TRANSFER');
    }
    const payment = await tx.paymentTransaction.findUnique({ where: { vehicleSaleId: sale.id } });
    if (!sale.paymentVerified || !payment || payment.status !== 'SUCCESS' || payment.userId !== sale.buyerId || payment.currency !== 'YER' || !payment.amount.eq(sale.totalPaidYER)) {
      throw new Error('REFUND_PAYMENT_MISMATCH');
    }
    const now = new Date();
    const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
    const updated = await tx.vehicleSale.update({ where: { id: sale.id }, data: {
      status: 'REFUND_PENDING',
      refundIdempotencyKey: sale.refundIdempotencyKey ?? `REFUND:${sale.id}`,
      refundReason: reason.trim().slice(0, 500),
      refundFailureReason: null,
      statusHistory: [...history, { event: 'REFUND_PENDING', at: now.toISOString(), actorId, reason: reason.trim().slice(0, 500) }],
    } });
    await tx.escrowTransaction.updateMany({ where: { vehicleSaleId: sale.id, status: 'HELD' }, data: { status: 'REFUND_PENDING' } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: actorId, userName: actorId, action: 'REFUND_PENDING', oldStatus: sale.status, newStatus: 'REFUND_PENDING', metadata: { reason: reason.trim().slice(0, 500) } } });
    return updated;
  });
}

/**
 * Calls the configured payment provider with a stable idempotency key, then
 * records the refund and balanced ledger reversals. Safe provider retries must
 * return the same result for the same idempotency key.
 */
export async function processSaleRefund(saleId: string, actorId = 'SYSTEM') {
  const providerUrl = requireProviderEndpoint(process.env.PAYMENT_PROVIDER_URL, 'PAYMENT_REFUND_PROVIDER');
  const providerSecret = process.env.PAYMENT_PROVIDER_API_SECRET;
  if (!providerSecret) throw new Error('NOT_CONFIGURED:PAYMENT_REFUND_PROVIDER_REQUIRED');

  const claim = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: saleId } });
    if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
    if (sale.status === 'REFUNDED') return { kind: 'DONE' as const, sale };
    const retryAfter = new Date(Date.now() - 5 * 60 * 1000);
    if (sale.status === 'REFUND_PROCESSING' && sale.refundProcessingAt && sale.refundProcessingAt > retryAfter) return { kind: 'IN_PROGRESS' as const, sale };
    if (!['REFUND_PENDING', 'REFUND_FAILED', 'REFUND_PROCESSING'].includes(sale.status)) throw new Error(`INVALID_REFUND_STATE:${sale.status}`);
    const payment = await tx.paymentTransaction.findUnique({ where: { vehicleSaleId: sale.id } });
    if (!payment || !['SUCCESS', 'REFUNDED'].includes(payment.status) || payment.userId !== sale.buyerId || payment.currency !== 'YER' || !payment.amount.eq(sale.totalPaidYER) || !payment.providerReference) {
      throw new Error('REFUND_PAYMENT_MISMATCH');
    }
    const now = new Date();
    const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
    const updated = await tx.vehicleSale.update({ where: { id: sale.id }, data: {
      status: 'REFUND_PROCESSING',
      refundIdempotencyKey: sale.refundIdempotencyKey ?? `REFUND:${sale.id}`,
      refundProcessingAt: now,
      refundFailureReason: null,
      refundAttempts: { increment: 1 },
      statusHistory: [...history, { event: 'REFUND_PROCESSING', at: now.toISOString(), actorId }],
    } });
    await tx.escrowTransaction.updateMany({ where: { vehicleSaleId: sale.id }, data: { status: 'REFUND_PROCESSING' } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: actorId, userName: actorId, action: 'REFUND_PROCESSING', oldStatus: sale.status, newStatus: 'REFUND_PROCESSING', metadata: { attempt: sale.refundAttempts + 1 } } });
    return { kind: 'CLAIMED' as const, sale: updated, payment };
  });

  if (claim.kind !== 'CLAIMED') return claim.sale;

  let refundProviderReference: string;
  try {
    const response = await fetch(providerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${providerSecret}` },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      cache: 'no-store',
      body: JSON.stringify({
        action: 'REFUND',
        saleId: claim.sale.id,
        paymentProviderReference: claim.payment.providerReference,
        amount: claim.sale.totalPaidYER.toString(),
        currency: 'YER',
        reason: claim.sale.refundReason,
        idempotencyKey: claim.sale.refundIdempotencyKey,
      }),
    });
    if (!response.ok) throw new Error('REFUND_PROVIDER_FAILED');
    const result = await parseFinancialProviderResponse(response, 'REFUND_PROVIDER_INVALID_RESPONSE');
    if (result.status !== 'REFUNDED' || !result.providerReference) throw new Error('REFUND_NOT_CONFIRMED');
    refundProviderReference = result.providerReference;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'REFUND_PROVIDER_FAILED';
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
      const current = await tx.vehicleSale.findUnique({ where: { id: saleId } });
      if (!current || current.status !== 'REFUND_PROCESSING') return;
      const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
      await tx.vehicleSale.update({ where: { id: current.id }, data: { status: 'REFUND_FAILED', refundFailureReason: message.slice(0, 500), statusHistory: [...history, { event: 'REFUND_FAILED', at: new Date().toISOString(), actorId, reason: message.slice(0, 500) }] } });
      await tx.escrowTransaction.updateMany({ where: { vehicleSaleId: current.id }, data: { status: 'REFUND_FAILED' } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: current.id, userId: actorId, userName: actorId, action: 'REFUND_FAILED', oldStatus: 'REFUND_PROCESSING', newStatus: 'REFUND_FAILED', metadata: { reason: message.slice(0, 500) } } });
    });
    throw error;
  }

  try {
    return await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
      const current = await tx.vehicleSale.findUnique({ where: { id: saleId } });
      if (!current || !current.buyerId) throw new Error('SALE_NOT_FOUND');
      if (current.status === 'REFUNDED') {
        if (current.refundProviderReference !== refundProviderReference) throw new Error('REFUND_PROVIDER_REFERENCE_MISMATCH');
        return current;
      }
      if (current.status !== 'REFUND_PROCESSING') throw new Error('REFUND_STATE_CHANGED');
      const payment = await tx.paymentTransaction.findUnique({ where: { vehicleSaleId: current.id } });
      if (!payment || !['SUCCESS', 'REFUNDED'].includes(payment.status) || !payment.amount.eq(current.totalPaidYER) || payment.currency !== 'YER') throw new Error('REFUND_PAYMENT_MISMATCH');
      const escrow = await tx.escrowTransaction.findUnique({ where: { vehicleSaleId: current.id } });
      if (escrow) {
        const feeReversals: Array<[string, Prisma.Decimal, LedgerEntryType]> = [
          ['PLATFORM', current.platformFeeYER, 'PLATFORM_FEES'],
          ['TRANSFER', current.transferFeeYER, 'TRANSFER_FEES'],
          ['AUCTION', current.auctionFeeYER, 'AUCTION_FEES'],
          ['EXHIBITION', new Prisma.Decimal(current.listingCommissionUSD).mul(current.exchangeRate), 'LISTING_SALES_COMMISSION'],
          ['GOVERNMENT', current.governmentFeesYER, 'GOVERNMENT_FEES'],
        ];
        for (const [name, amount, debitType] of feeReversals) if (amount.gt(0)) await createDoubleEntry({ transactionId: current.id, entryGroupId: `REFUND:FEE:${name}:${current.id}`, amount, currency: 'YER', debitType, creditType: 'ESCROW_FUNDS', userId: current.buyerId, relatedOperationId: current.id, providerRef: refundProviderReference, idempotencyKey: `REFUND:FEE:${name}:${current.id}` }, tx);
        await createDoubleEntry({ transactionId: current.id, entryGroupId: `REFUND:${current.id}`, amount: current.totalPaidYER, currency: 'YER', debitType: 'ESCROW_FUNDS', creditType: 'REFUNDS', userId: current.buyerId, relatedOperationId: current.id, providerRef: refundProviderReference, idempotencyKey: `REFUND:${current.id}` }, tx);
        await tx.escrowTransaction.update({ where: { vehicleSaleId: current.id }, data: { status: 'REFUNDED' } });
      } else {
        await createDoubleEntry({ transactionId: current.id, entryGroupId: `REFUND:${current.id}`, amount: current.totalPaidYER, currency: 'YER', debitType: 'CUSTOMER_FUNDS', creditType: 'REFUNDS', userId: current.buyerId, relatedOperationId: current.id, providerRef: refundProviderReference, idempotencyKey: `REFUND:${current.id}` }, tx);
      }
      await tx.paymentTransaction.update({ where: { vehicleSaleId: current.id }, data: { status: 'REFUNDED' } });
      const now = new Date();
      const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
      const refunded = await tx.vehicleSale.update({ where: { id: current.id }, data: {
        status: 'REFUNDED',
        fundsSecured: false,
        refundProviderReference,
        refundFailureReason: null,
        refundedAt: now,
        statusHistory: [...history, { event: 'REFUNDED', at: now.toISOString(), actorId, providerReference: refundProviderReference }],
      } });
      await tx.vehicle.updateMany({ where: { id: current.vehicleId, isReserved: true, status: 'PENDING' }, data: { isReserved: false, status: 'ACTIVE' } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: current.id, userId: actorId, userName: actorId, action: 'REFUNDED', oldStatus: 'REFUND_PROCESSING', newStatus: 'REFUNDED', reference: refundProviderReference } });
      await tx.notification.create({ data: { userId: current.buyerId, type: 'REFUND', title: 'تم رد المبلغ', message: `تم رد مبلغ العملية ${current.id} إلى وسيلة الدفع.`, priority: 'CRITICAL', operationId: current.id } });
      return refunded;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new Error('REFUND_PROVIDER_REFERENCE_REPLAY');
    throw error;
  }
}

export async function confirmOwnershipTransfer(saleId: string, providerReference: string) {
  if (!process.env.TRAFFIC_PROVIDER_URL || !process.env.TRAFFIC_PROVIDER_SECRET) throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED');
  try { return await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: saleId } });
    if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
    if (!['TRANSFER_PENDING', 'TRANSFER_IN_PROGRESS', 'HANDOVER_PENDING'].includes(sale.status)) throw new Error(`INVALID_TRANSFER_STATE:${sale.status}`);
    if (!providerReference) throw new Error('TRAFFIC_PROVIDER_REFERENCE_REQUIRED');
    const transferRequest = await tx.operation.findUnique({ where: { idempotencyKey: `TRAFFIC:${sale.id}` } });
    assertTrafficTransferRequestBinding({ saleId: sale.id, saleGovernmentReference: sale.governmentReference, providerReference, operation: transferRequest });
    if (sale.status === 'HANDOVER_PENDING') return sale;
    if (sale.expiresAt <= new Date()) throw new Error('SALE_EXPIRED_REFUND_REQUIRED');
    if (!sale.paymentVerified || !sale.fundsSecured) throw new Error('FUNDS_NOT_SECURED');
    if (!sale.sellerOtpVerified) throw new Error('SELLER_OTP_REQUIRED');
    if (!sale.auctionId && !sale.buyerOtpVerified) throw new Error('BUYER_OTP_REQUIRED');
    const [payment, escrow, seller, buyer] = await Promise.all([
      tx.paymentTransaction.findUnique({ where: { vehicleSaleId: sale.id } }),
      tx.escrowTransaction.findUnique({ where: { vehicleSaleId: sale.id } }),
      tx.user.findUnique({ where: { id: sale.sellerId } }),
      tx.user.findUnique({ where: { id: sale.buyerId } }),
    ]);
    if (!seller || seller.status !== 'ACTIVE' || seller.phoneStatus !== 'VERIFIED' || !isIdentityVerified(seller)) throw new Error('SELLER_VERIFICATION_REQUIRED');
    if (!buyer || buyer.status !== 'ACTIVE' || buyer.phoneStatus !== 'VERIFIED' || !isIdentityVerified(buyer)) throw new Error('BUYER_VERIFICATION_REQUIRED');
    if (!payment || payment.status !== 'SUCCESS' || payment.userId !== sale.buyerId || payment.currency !== 'YER' || !payment.amount.eq(sale.totalPaidYER) || !payment.providerReference) throw new Error('PAYMENT_INTEGRITY_FAILED');
    if (!escrow || escrow.status !== 'HELD' || escrow.paymentProviderReference !== payment.providerReference || escrow.escrowProviderReference !== sale.escrowTransactionId || !escrow.totalPaidYER.eq(sale.totalPaidYER) || !escrow.vehicleAmountYER.eq(sale.vehicleAmountYER) || !escrow.sellerPayoutYER.eq(sale.sellerPayoutYER) || !escrow.platformRevenueYER.eq(sale.platformRevenueYER) || escrow.platformFeeUSD !== sale.platformFeeUSD || !escrow.platformFeeYER.eq(sale.platformFeeYER) || escrow.transferFeeUSD !== sale.transferFeeUSD || !escrow.transferFeeYER.eq(sale.transferFeeYER) || escrow.listingCommissionUSD !== sale.listingCommissionUSD || !escrow.auctionFeeYER.eq(sale.auctionFeeYER) || !escrow.governmentFeesYER.eq(sale.governmentFeesYER) || !escrow.exchangeRate.eq(sale.exchangeRate)) {
      throw new Error('ESCROW_INTEGRITY_FAILED');
    }
    const replay = await tx.vehicleSale.findFirst({ where: { governmentReference: providerReference, id: { not: saleId } }, select: { id: true } });
    if (replay) throw new Error('TRAFFIC_PROVIDER_REFERENCE_REPLAY');
    const vehicle = await tx.vehicle.findUnique({ where: { id: sale.vehicleId } });
    if (!vehicle || vehicle.hasLegalBlock) throw new Error('TRANSFER_BLOCKED');
    await tx.vehicleOwnership.updateMany({ where: { vehicleId: sale.vehicleId, ownershipStatus: 'ACTIVE' }, data: { ownershipStatus: 'PREVIOUS' } });
    await tx.vehicleOwnership.create({ data: { vehicleId: sale.vehicleId, ownerId: sale.buyerId, ownershipStatus: 'ACTIVE', verifiedAt: new Date() } });
    await tx.vehicle.update({ where: { id: sale.vehicleId }, data: { ownerId: sale.buyerId, isReserved: true, status: 'SOLD' } });
    const now = new Date();
    const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
    const transferred = await tx.vehicleSale.update({ where: { id: saleId }, data: { governmentReference: providerReference, governmentStatus: 'TRANSFERRED', status: 'HANDOVER_PENDING', statusHistory: [...history, { event: 'OWNERSHIP_TRANSFERRED', at: now.toISOString(), providerReference }, { event: 'HANDOVER_PENDING', at: now.toISOString(), providerReference }] } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: 'TRAFFIC_PROVIDER', userName: 'TRAFFIC_PROVIDER', action: 'OWNERSHIP_TRANSFERRED', oldStatus: sale.status, newStatus: 'HANDOVER_PENDING', reference: providerReference } });
    return transferred;
  }); } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new Error('TRAFFIC_PROVIDER_REFERENCE_REPLAY');
    throw error;
  }
}

export async function recordHandoverPartyConsent(params: { saleId: string; actorId: string; otpId: string; otp: string }) {
  const sale = await db.vehicleSale.findUnique({ where: { id: params.saleId } });
  if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
  if (sale.status !== 'HANDOVER_PENDING') throw new Error(`INVALID_HANDOVER_STATE:${sale.status}`);
  const party = sale.buyerId === params.actorId ? 'BUYER' : sale.sellerId === params.actorId ? 'SELLER' : null;
  if (!party) throw new Error('FORBIDDEN');
  const idempotencyKey = `HANDOVER_CONSENT:${sale.id}:${party}`;
  const handoverOtpOperationId = saleOtpOperationId(sale.id, 'HANDOVER');
  const existing = await db.operation.findUnique({ where: { idempotencyKey } });
  if (existing && existing.type !== 'HANDOVER_PARTY_CONSENT') throw new Error('HANDOVER_CONSENT_OPERATION_MISMATCH');
  if (existing?.status === 'SUCCESS') {
    if (existing.providerReference !== params.otpId) throw new Error('HANDOVER_CONSENT_ALREADY_RECORDED');
    const consumedOtp = await db.otpRecord.findUnique({ where: { id: params.otpId } });
    if (!isHandoverConsentBound({ saleId: sale.id, party, userId: params.actorId, operation: existing, otp: consumedOtp })) {
      throw new Error('HANDOVER_CONSENT_OTP_MISMATCH');
    }
    return { party, recordedAt: existing.updatedAt };
  }
  if (existing?.providerReference && existing.providerReference !== params.otpId && existing.status !== 'FAILED') throw new Error('HANDOVER_CONSENT_OTP_MISMATCH');
  const operation = existing
    ? await db.operation.update({ where: { id: existing.id }, data: { status: 'PENDING', providerReference: params.otpId, userId: params.actorId, metadata: { saleId: sale.id, party } } })
    : await db.operation.create({ data: {
        operationNumber: `HOC-${party}-${sale.id}`,
        type: 'HANDOVER_PARTY_CONSENT',
        userId: params.actorId,
        status: 'PENDING',
        providerReference: params.otpId,
        idempotencyKey,
        metadata: { saleId: sale.id, party },
      } });
  const alreadyConsumed = await db.otpRecord.findUnique({ where: { id: params.otpId } });
  if (!(alreadyConsumed?.isUsed && alreadyConsumed.verifiedAt && alreadyConsumed.userId === params.actorId && alreadyConsumed.operationId === handoverOtpOperationId && alreadyConsumed.type === party)) {
    try {
      await otpService.verifyOtp({ otpId: params.otpId, otp: params.otp, operationId: handoverOtpOperationId, type: party, userId: params.actorId });
    } catch (error) {
      await db.operation.updateMany({ where: { id: operation.id, status: 'PENDING' }, data: { status: 'FAILED' } });
      throw error;
    }
  }
  const recorded = await db.operation.update({ where: { id: operation.id }, data: { status: 'SUCCESS' } });
  await db.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: params.actorId, userName: party === 'BUYER' ? sale.buyerName ?? '' : sale.sellerName, action: `HANDOVER_${party}_CONSENT`, oldStatus: sale.status, newStatus: sale.status, reference: params.otpId } });
  return { party, recordedAt: recorded.updatedAt };
}

export async function confirmHandover(params: { saleId: string; actorId: string; buyerOtpId?: string; buyerOtp?: string; sellerOtpId?: string; sellerOtp?: string; qrValue: string; mileage: number; photos?: Prisma.InputJsonValue; notes?: string }) {
  const sale = await db.vehicleSale.findUnique({ where: { id: params.saleId } });
  if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
  if (sale.buyerId !== params.actorId) throw new Error('BUYER_HANDOVER_CONFIRMATION_REQUIRED');
  if (sale.status !== 'HANDOVER_PENDING') throw new Error(`INVALID_HANDOVER_STATE:${sale.status}`);
  const expectedQr = createHash('sha256').update(`${sale.id}|${sale.vehicleId}|HANDOVER`).digest('hex');
  if (params.qrValue !== expectedQr) throw new Error('HANDOVER_QR_INVALID');
  if (!Number.isInteger(params.mileage) || params.mileage < 0) throw new Error('INVALID_MILEAGE');

  const directOtp = params.buyerOtpId && params.buyerOtp && params.sellerOtpId && params.sellerOtp;
  if (directOtp) {
    // Backward-compatible server/API path. Each code is still bound to its
    // exact party and consumed exactly once.
    await otpService.verifyOtp({ otpId: params.buyerOtpId!, otp: params.buyerOtp!, operationId: saleOtpOperationId(sale.id, 'HANDOVER'), type: 'BUYER', userId: sale.buyerId });
    await otpService.verifyOtp({ otpId: params.sellerOtpId!, otp: params.sellerOtp!, operationId: saleOtpOperationId(sale.id, 'HANDOVER'), type: 'SELLER', userId: sale.sellerId });
  } else {
    const [buyerConsent, sellerConsent] = await Promise.all([
      db.operation.findUnique({ where: { idempotencyKey: `HANDOVER_CONSENT:${sale.id}:BUYER` } }),
      db.operation.findUnique({ where: { idempotencyKey: `HANDOVER_CONSENT:${sale.id}:SELLER` } }),
    ]);
    const [buyerOtp, sellerOtp] = await Promise.all([
      buyerConsent?.providerReference ? db.otpRecord.findUnique({ where: { id: buyerConsent.providerReference } }) : null,
      sellerConsent?.providerReference ? db.otpRecord.findUnique({ where: { id: sellerConsent.providerReference } }) : null,
    ]);
    if (!isHandoverConsentBound({ saleId: sale.id, party: 'BUYER', userId: sale.buyerId, operation: buyerConsent, otp: buyerOtp })) throw new Error('BUYER_HANDOVER_CONSENT_REQUIRED');
    if (!isHandoverConsentBound({ saleId: sale.id, party: 'SELLER', userId: sale.sellerId, operation: sellerConsent, otp: sellerOtp })) throw new Error('SELLER_HANDOVER_CONSENT_REQUIRED');
  }

  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${params.saleId} FOR UPDATE`;
    const current = await tx.vehicleSale.findUnique({ where: { id: params.saleId } });
    if (!current || current.status !== 'HANDOVER_PENDING' || !current.buyerId) throw new Error('HANDOVER_STATE_CHANGED');
    const now = new Date();
    const protection = new Date(now.getTime() + PAYOUT_PROTECTION_MINUTES * 60 * 1000);
    await tx.handoverEvidence.create({ data: { saleTransactionId: current.id, vehicleId: current.vehicleId, buyerId: current.buyerId, sellerId: current.sellerId, buyerOtpVerifiedAt: now, sellerOtpVerifiedAt: now, buyerNotes: params.notes, recordedMileage: params.mileage, photoUrls: params.photos, confirmedAt: now } });
    const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
    const confirmed = await tx.vehicleSale.update({ where: { id: current.id }, data: { handoverConfirmedAt: now, payoutProtectionUntil: protection, status: 'PAYOUT_PROTECTION', statusHistory: [...history, { event: 'HANDOVER_CONFIRMED', at: now.toISOString(), actorId: params.actorId }, { event: 'PAYOUT_PROTECTION', at: now.toISOString(), until: protection.toISOString() }] } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: current.id, userId: params.actorId, userName: current.buyerName ?? '', action: 'HANDOVER_CONFIRMED', oldStatus: 'HANDOVER_PENDING', newStatus: 'PAYOUT_PROTECTION' } });
    return confirmed;
  });
}

export async function releasePayout(saleId: string, actorId: string) {
  const providerUrl = requireProviderEndpoint(process.env.PAYOUT_PROVIDER_URL, 'PAYOUT_PROVIDER');
  const providerSecret = process.env.PAYOUT_PROVIDER_SECRET;
  if (!providerSecret) throw new Error('NOT_CONFIGURED:PAYOUT_PROVIDER_REQUIRED');

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
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      cache: 'no-store',
      body: JSON.stringify({ saleId: claimed.sale.id, recipientUserId: claimed.sale.payoutUserId ?? claimed.sale.sellerId, amount: claimed.sale.sellerPayoutYER.toString(), currency: 'YER', idempotencyKey: `PAYOUT:${claimed.sale.id}` }),
    });
    if (!response.ok) throw new Error('PAYOUT_PROVIDER_FAILED');
    const result = await parseFinancialProviderResponse(response, 'PAYOUT_PROVIDER_INVALID_RESPONSE');
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

  try {
    return await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${saleId} FOR UPDATE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`PAYOUT_PROVIDER_REFERENCE:${providerReference}`}))`;
      const current = await tx.vehicleSale.findUnique({ where: { id: saleId } });
      if (!current) throw new Error('SALE_NOT_FOUND');
      if (current.status === 'PAYOUT_CONFIRMED') return current;
      if (current.status !== 'PAYOUT_PROCESSING') throw new Error('PAYOUT_STATE_CHANGED');
      const referenceOwner = await tx.vehicleSale.findUnique({ where: { payoutProviderReference: providerReference }, select: { id: true } });
      if (referenceOwner && referenceOwner.id !== current.id) throw new Error('PAYOUT_PROVIDER_REFERENCE_REPLAY');
      await createDoubleEntry({ transactionId: current.id, entryGroupId: `PAYOUT:${current.id}`, amount: current.sellerPayoutYER, currency: 'YER', debitType: 'ESCROW_FUNDS', creditType: 'SELLER_PAYOUTS', userId: current.payoutUserId ?? current.sellerId, relatedOperationId: current.id, providerRef: providerReference, idempotencyKey: `PAYOUT:${current.id}` }, tx);
      const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
      const final = await tx.vehicleSale.update({ where: { id: current.id }, data: { status: 'PAYOUT_CONFIRMED', payoutProviderReference: providerReference, statusHistory: [...history, { event: 'PAYOUT_CONFIRMED', at: new Date().toISOString(), providerReference }] } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: current.id, userId: actorId, userName: actorId, action: 'PAYOUT_CONFIRMED', oldStatus: 'PAYOUT_PROCESSING', newStatus: 'PAYOUT_CONFIRMED', reference: providerReference } });
      return final;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new Error('PAYOUT_PROVIDER_REFERENCE_REPLAY');
    throw error;
  }
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

    if (nextStatus === 'BUYER_ACCEPTED') {
      if (!sale.sellerOtpVerified) throw new Error('SELLER_OTP_REQUIRED');
      if (sale.buyerId !== actorId) throw new Error('BUYER_APPROVAL_REQUIRED');
      if (actor.phoneStatus !== 'VERIFIED') throw new Error('BUYER_NOT_PHONE_VERIFIED');
      if (!isIdentityVerified(actor)) throw new Error('BUYER_IDENTITY_NOT_VERIFIED');
    }
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
    const updated = await tx.vehicleSale.update({ where: { id: saleId }, data: { status: nextStatus, ...(nextStatus === 'BUYER_ACCEPTED' ? { buyerApproved: true } : {}), statusHistory: [...history, { event: nextStatus, at: new Date().toISOString(), actorId, ...(metadata ? { metadata } : {}) }] } });
    await tx.saleAuditLog.create({ data: { vehicleSaleId: saleId, userId: actorId, userName: actor.fullName, action: 'STATUS_CHANGE', oldStatus: sale.status, newStatus: nextStatus, metadata } });
    if (['CANCELLED', 'REJECTED', 'EXPIRED', 'PAYMENT_FAILED', 'TRANSFER_FAILED'].includes(nextStatus)) await tx.vehicle.updateMany({ where: { id: sale.vehicleId, isReserved: true, status: 'PENDING' }, data: { isReserved: false, status: 'ACTIVE' } });
    return updated;
  });
}
