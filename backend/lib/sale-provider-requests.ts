import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { readBoundedResponseText } from './http-bounds';
import { isIdentityVerified } from './identity-policy';
import { requireProviderEndpoint } from './provider-endpoint';

const PROVIDER_TIMEOUT_MS = 15_000;
const PENDING_RETRY_MS = 2 * 60 * 1000;

function metadataObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeCheckoutUrl(value: unknown) {
  if (typeof value !== 'string' || !value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('PAYMENT_PROVIDER_INVALID_CHECKOUT_URL'); }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('PAYMENT_PROVIDER_INVALID_CHECKOUT_URL');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('PAYMENT_PROVIDER_INVALID_CHECKOUT_URL');
  return url.toString();
}

function compactMetadata(values: Record<string, string | undefined>): Prisma.InputJsonObject {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

async function postProvider<T extends z.ZodTypeAny>(url: string, secret: string, payload: unknown, schema: T, invalidResponseCode: string): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      redirect: 'error',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('PROVIDER_TIMEOUT');
    throw new Error('PROVIDER_UNREACHABLE');
  }
  if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
  const body = await readBoundedResponseText(response, 64 * 1024, invalidResponseCode);
  if (!body) throw new Error(invalidResponseCode);
  let json: unknown;
  try { json = JSON.parse(body); } catch { throw new Error(invalidResponseCode); }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(invalidResponseCode);
  return parsed.data;
}

const paymentProviderResponseSchema = z.object({
  status: z.enum(['CREATED', 'PENDING', 'REQUIRES_ACTION']),
  providerReference: z.string().trim().min(1).max(300),
  checkoutUrl: z.string().trim().max(2_000).optional(),
  instructions: z.string().trim().max(1_000).optional(),
});

const trafficProviderResponseSchema = z.object({
  status: z.enum(['PENDING', 'ACCEPTED']),
  providerReference: z.string().trim().min(1).max(300),
  message: z.string().trim().max(1_000).optional(),
});

export function paymentInitiationFallbackStatus(sale: { status: string; auctionId: string | null }): 'WAITING_PAYMENT' | 'BUYER_ACCEPTED' {
  return sale.auctionId || sale.status === 'WAITING_PAYMENT' ? 'WAITING_PAYMENT' : 'BUYER_ACCEPTED';
}

export async function requestSalePayment(params: { saleId: string; buyerId: string; returnUrl: string }) {
  const providerUrl = requireProviderEndpoint(process.env.PAYMENT_PROVIDER_URL, 'PAYMENT_PROVIDER');
  const providerSecret = process.env.PAYMENT_PROVIDER_API_SECRET;
  if (!providerSecret) throw new Error('NOT_CONFIGURED:PAYMENT_PROVIDER_REQUIRED');
  const idempotencyKey = `PAYMENT:${params.saleId}`;

  const claim = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${params.saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: params.saleId } });
    if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
    if (sale.buyerId !== params.buyerId) throw new Error('BUYER_PAYMENT_REQUIRED');
    if (sale.expiresAt <= new Date()) throw new Error('SALE_EXPIRED');
    if (!sale.buyerApproved) throw new Error('BUYER_APPROVAL_REQUIRED');
    if (!sale.auctionId && !sale.buyerOtpVerified) throw new Error('BUYER_OTP_REQUIRED');
    if (!['BUYER_ACCEPTED', 'WAITING_PAYMENT', 'PAYMENT_PROCESSING'].includes(sale.status)) throw new Error(`INVALID_PAYMENT_STATE:${sale.status}`);
    if (!sale.sellerOtpVerified) throw new Error('SELLER_OTP_REQUIRED');

    const existing = await tx.operation.findUnique({ where: { idempotencyKey } });
    if (existing?.status === 'SUCCESS' && existing.providerReference) return { kind: 'DONE' as const, sale, operation: existing };
    if (existing?.status === 'PENDING' && existing.updatedAt.getTime() > Date.now() - PENDING_RETRY_MS) return { kind: 'PENDING' as const, sale, operation: existing };
    const operation = existing
      ? await tx.operation.update({ where: { id: existing.id }, data: { status: 'PENDING', metadata: { returnUrl: params.returnUrl } } })
      : await tx.operation.create({ data: { operationNumber: `PAY-${sale.id}`, type: 'SALE_PAYMENT_REQUEST', userId: params.buyerId, status: 'PENDING', idempotencyKey, metadata: { returnUrl: params.returnUrl } } });
    if (sale.status !== 'PAYMENT_PROCESSING') {
      const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
      await tx.vehicleSale.update({ where: { id: sale.id }, data: { status: 'PAYMENT_PROCESSING', statusHistory: [...history, { event: 'PAYMENT_REQUESTED', at: new Date().toISOString(), actorId: params.buyerId }] } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: params.buyerId, userName: sale.buyerName ?? '', action: 'PAYMENT_REQUESTED', oldStatus: sale.status, newStatus: 'PAYMENT_PROCESSING', metadata: { idempotencyKey } } });
    }
    return { kind: 'CLAIMED' as const, sale, operation };
  });

  if (claim.kind === 'DONE') {
    const metadata = metadataObject(claim.operation.metadata);
    return { providerReference: claim.operation.providerReference!, status: 'CREATED', checkoutUrl: safeCheckoutUrl(metadata.checkoutUrl), instructions: typeof metadata.instructions === 'string' ? metadata.instructions : undefined, replayed: true };
  }
  if (claim.kind === 'PENDING') return { status: 'PENDING', inProgress: true, replayed: true };

  try {
    const result = await postProvider(providerUrl, providerSecret, {
      action: 'CREATE_PAYMENT',
      saleId: claim.sale.id,
      buyerId: claim.sale.buyerId,
      amount: claim.sale.totalPaidYER.toString(),
      currency: 'YER',
      returnUrl: params.returnUrl,
      idempotencyKey,
    }, paymentProviderResponseSchema, 'PAYMENT_PROVIDER_INVALID_RESPONSE');
    const checkoutUrl = safeCheckoutUrl(result.checkoutUrl);
    await db.operation.update({ where: { id: claim.operation.id }, data: { status: 'SUCCESS', providerReference: result.providerReference, metadata: compactMetadata({ checkoutUrl, instructions: result.instructions, providerStatus: result.status }) } });
    return { providerReference: result.providerReference, status: result.status!, checkoutUrl, instructions: result.instructions, replayed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PAYMENT_PROVIDER_FAILED';
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${claim.sale.id} FOR UPDATE`;
      await tx.operation.updateMany({ where: { id: claim.operation.id, status: 'PENDING' }, data: { status: message.startsWith('NOT_CONFIGURED') ? 'NOT_CONFIGURED' : 'FAILED', metadata: { error: message } } });
      const current = await tx.vehicleSale.findUnique({ where: { id: claim.sale.id } });
      if (current?.status === 'PAYMENT_PROCESSING' && !current.paymentVerified) {
        const fallbackStatus = paymentInitiationFallbackStatus(claim.sale);
        const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
        await tx.vehicleSale.update({ where: { id: current.id }, data: { status: fallbackStatus, statusHistory: [...history, { event: 'PAYMENT_REQUEST_FAILED', at: new Date().toISOString(), actorId: params.buyerId, reason: message }] } });
      }
    });
    throw error;
  }
}

export async function requestGovernmentOwnershipTransfer(params: { saleId: string; actorId: string }) {
  const providerUrl = requireProviderEndpoint(process.env.TRAFFIC_PROVIDER_URL, 'TRAFFIC_PROVIDER');
  const providerSecret = process.env.TRAFFIC_PROVIDER_SECRET;
  if (!providerSecret) throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED');
  const idempotencyKey = `TRAFFIC:${params.saleId}`;

  const claim = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${params.saleId} FOR UPDATE`;
    const sale = await tx.vehicleSale.findUnique({ where: { id: params.saleId }, include: { vehicle: true } });
    if (!sale || !sale.buyerId) throw new Error('SALE_NOT_FOUND');
    const actor = await tx.user.findUnique({ where: { id: params.actorId } });
    if (!actor) throw new Error('UNAUTHORIZED');
    const participant = [sale.sellerId, sale.buyerId, sale.payoutUserId].includes(actor.id);
    if (!participant && !['ADMIN', 'SUPER_ADMIN', 'OWNER', 'VERIFIER'].includes(actor.role)) throw new Error('FORBIDDEN');
    if (!['ESCROW_HELD', 'TRANSFER_PENDING'].includes(sale.status)) throw new Error(`INVALID_TRANSFER_STATE:${sale.status}`);
    if (sale.expiresAt <= new Date()) throw new Error('SALE_EXPIRED_REFUND_REQUIRED');
    if (!sale.sellerOtpVerified || (!sale.auctionId && !sale.buyerOtpVerified)) throw new Error('PARTY_OTP_REQUIRED');
    if (!sale.paymentVerified || !sale.fundsSecured) throw new Error('FUNDS_NOT_SECURED');
    if (sale.vehicle.hasLegalBlock || sale.vehicle.governmentStatus !== 'VERIFIED') throw new Error('TRANSFER_BLOCKED');

    const [payment, escrow, seller, buyer, authorization] = await Promise.all([
      tx.paymentTransaction.findUnique({ where: { vehicleSaleId: sale.id } }),
      tx.escrowTransaction.findUnique({ where: { vehicleSaleId: sale.id } }),
      tx.user.findUnique({ where: { id: sale.sellerId } }),
      tx.user.findUnique({ where: { id: sale.buyerId } }),
      sale.authorizationId ? tx.vehicleAuthorization.findUnique({ where: { id: sale.authorizationId } }) : null,
    ]);
    if (!seller || seller.status !== 'ACTIVE' || seller.phoneStatus !== 'VERIFIED' || !isIdentityVerified(seller)) throw new Error('SELLER_VERIFICATION_REQUIRED');
    if (!buyer || buyer.status !== 'ACTIVE' || buyer.phoneStatus !== 'VERIFIED' || !isIdentityVerified(buyer)) throw new Error('BUYER_VERIFICATION_REQUIRED');
    if (authorization && (authorization.status !== 'ACTIVE' || authorization.validUntil <= new Date())) {
      const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
      await tx.vehicleSale.update({ where: { id: sale.id }, data: { status: 'MANUAL_REVIEW', statusHistory: [...history, { event: 'AUTHORIZATION_NO_LONGER_VALID', at: new Date().toISOString(), actorId: params.actorId }] } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: sale.id, userId: params.actorId, userName: params.actorId, action: 'AUTHORIZATION_NO_LONGER_VALID', oldStatus: sale.status, newStatus: 'MANUAL_REVIEW', metadata: { authorizationId: authorization.id, authorizationStatus: authorization.status } } });
      return { kind: 'BLOCKED' as const, reason: 'AUTHORIZATION_NO_LONGER_VALID' };
    }
    if (!payment || payment.status !== 'SUCCESS' || payment.vehicleSaleId !== sale.id || payment.userId !== sale.buyerId || payment.currency !== 'YER' || !payment.amount.eq(sale.totalPaidYER) || !payment.providerReference) throw new Error('PAYMENT_INTEGRITY_FAILED');
    if (!escrow || escrow.status !== 'HELD' || escrow.paymentProviderReference !== payment.providerReference || escrow.escrowProviderReference !== sale.escrowTransactionId || !escrow.totalPaidYER.eq(sale.totalPaidYER) || !escrow.vehicleAmountYER.eq(sale.vehicleAmountYER) || !escrow.sellerPayoutYER.eq(sale.sellerPayoutYER) || !escrow.platformRevenueYER.eq(sale.platformRevenueYER)) throw new Error('ESCROW_INTEGRITY_FAILED');

    const existing = await tx.operation.findUnique({ where: { idempotencyKey } });
    if (existing?.status === 'SUCCESS' && existing.providerReference) return { kind: 'DONE' as const, sale, operation: existing };
    if (existing?.status === 'PENDING' && existing.updatedAt.getTime() > Date.now() - PENDING_RETRY_MS) return { kind: 'PENDING' as const, sale, operation: existing };
    const operation = existing
      ? await tx.operation.update({ where: { id: existing.id }, data: { status: 'PENDING', metadata: { saleId: sale.id } } })
      : await tx.operation.create({ data: { operationNumber: `TRF-${sale.id}`, type: 'TRAFFIC_TRANSFER_REQUEST', userId: params.actorId, status: 'PENDING', idempotencyKey, metadata: { saleId: sale.id } } });
    return { kind: 'CLAIMED' as const, sale, operation, payment };
  });

  if (claim.kind === 'BLOCKED') throw new Error(claim.reason);
  if (claim.kind === 'DONE') return { providerReference: claim.operation.providerReference!, status: 'PENDING', replayed: true };
  if (claim.kind === 'PENDING') return { status: 'PENDING', inProgress: true, replayed: true };

  try {
    const result = await postProvider(providerUrl, providerSecret, {
      action: 'CREATE_OWNERSHIP_TRANSFER',
      saleId: claim.sale.id,
      vehicle: { id: claim.sale.vehicleId, plateNumber: claim.sale.vehicle.plateNumber, vin: claim.sale.vehicle.vin },
      seller: { id: claim.sale.sellerId, nationalId: claim.sale.sellerNationalId },
      buyer: { id: claim.sale.buyerId, nationalId: claim.sale.buyerNationalId },
      salePrice: claim.sale.vehicleAmountYER.toString(),
      paymentProviderReference: claim.payment.providerReference,
      escrowProviderReference: claim.sale.escrowTransactionId,
      idempotencyKey,
    }, trafficProviderResponseSchema, 'TRAFFIC_PROVIDER_INVALID_RESPONSE');
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "VehicleSale" WHERE id = ${claim.sale.id} FOR UPDATE`;
      const current = await tx.vehicleSale.findUnique({ where: { id: claim.sale.id } });
      if (!current || !['ESCROW_HELD', 'TRANSFER_PENDING'].includes(current.status)) throw new Error('TRANSFER_STATE_CHANGED');
      const replay = await tx.vehicleSale.findFirst({ where: { governmentReference: result.providerReference, id: { not: current.id } }, select: { id: true } });
      if (replay) throw new Error('TRAFFIC_PROVIDER_REFERENCE_REPLAY');
      const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
      await tx.operation.update({ where: { id: claim.operation.id }, data: { status: 'SUCCESS', providerReference: result.providerReference, metadata: compactMetadata({ saleId: claim.sale.id, providerStatus: result.status, message: result.message }) } });
      await tx.vehicleSale.update({ where: { id: current.id }, data: { status: 'TRANSFER_PENDING', governmentReference: result.providerReference, governmentStatus: result.status, statusHistory: [...history, { event: 'TRANSFER_REQUESTED', at: new Date().toISOString(), actorId: params.actorId, providerReference: result.providerReference }] } });
      await tx.saleAuditLog.create({ data: { vehicleSaleId: current.id, userId: params.actorId, userName: params.actorId, action: 'TRANSFER_REQUESTED', oldStatus: current.status, newStatus: 'TRANSFER_PENDING', reference: result.providerReference, metadata: { idempotencyKey } } });
    });
    return { providerReference: result.providerReference, status: result.status!, message: result.message, replayed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'TRAFFIC_PROVIDER_FAILED';
    await db.operation.updateMany({ where: { id: claim.operation.id, status: 'PENDING' }, data: { status: 'FAILED', metadata: { error: message } } });
    throw error;
  }
}
