import { Prisma } from '@prisma/client';
import { db } from './db';

export type EscrowProviderStatus = 'NOT_CONFIGURED' | 'CONNECTED';

export function getEscrowProviderStatus(): EscrowProviderStatus {
  return process.env.ESCROW_PROVIDER_URL && process.env.ESCROW_PROVIDER_SECRET ? 'CONNECTED' : 'NOT_CONFIGURED';
}

export async function requireEscrowProvider() {
  if (getEscrowProviderStatus() !== 'CONNECTED') throw new Error('NOT_CONFIGURED:ESCROW_PROVIDER_REQUIRED');
}

export async function createEscrowRecord(params: { vehicleSaleId: string; totalPaidYER: Prisma.Decimal | number; exchangeRate: Prisma.Decimal | number; providerReference: string }) {
  await requireEscrowProvider();
  return db.escrowTransaction.create({ data: { vehicleSaleId: params.vehicleSaleId, vehicleAmountYER: params.totalPaidYER, totalPaidYER: params.totalPaidYER, sellerPayoutYER: params.totalPaidYER, platformRevenueYER: 0, exchangeRate: params.exchangeRate, paymentProviderReference: params.providerReference, status: 'HELD', securedAt: new Date() } });
}
