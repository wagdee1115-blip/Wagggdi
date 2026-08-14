import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from './db';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
}

export type StoredContractEnvelope = {
  version: 1;
  payload: Record<string, unknown>;
  integrity: { sha256: string; createdBy: string; generatedAt: string };
};

export function contractPayloadHash(payload: unknown) {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

export async function createContractRecord(params: { saleId: string; operationId: string; contractData: Record<string, unknown>; contractNumber: string; createdBy: string }) {
  const hash = contractPayloadHash(params.contractData);
  const envelope: StoredContractEnvelope = { version: 1, payload: params.contractData, integrity: { sha256: hash, createdBy: params.createdBy, generatedAt: new Date().toISOString() } };
  try {
    const contract = await db.saleContract.create({ data: { vehicleSaleId: params.saleId, contractNumber: params.contractNumber, operationId: params.operationId, contractData: envelope as unknown as Prisma.InputJsonValue, status: 'ISSUED' } });
    await db.vehicleSale.update({ where: { id: params.saleId }, data: { contractId: contract.id } });
    return { contract, hash, replayed: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const contract = await db.saleContract.findUnique({ where: { vehicleSaleId: params.saleId } });
    if (!contract) throw error;
    const stored = contract.contractData as unknown as Partial<StoredContractEnvelope>;
    if (stored.integrity?.sha256 !== hash || contract.contractNumber !== params.contractNumber || contract.operationId !== params.operationId) throw new Error('CONTRACT_IMMUTABILITY_VIOLATION');
    return { contract, hash, replayed: true };
  }
}

function auditTime(logs: Array<{ action: string; newStatus: string; createdAt: Date }>, predicate: (log: { action: string; newStatus: string }) => boolean) {
  return logs.find(predicate)?.createdAt.toISOString();
}

export async function issueSaleContract(saleId: string, createdBy: string) {
  const sale = await db.vehicleSale.findUnique({ where: { id: saleId }, include: { vehicle: true, auditLogs: { orderBy: { createdAt: 'asc' } } } });
  if (!sale || !sale.buyerId || !sale.buyerName || !sale.buyerNationalId || !sale.buyerPhone) throw new Error('SALE_CONTRACT_DATA_INCOMPLETE');
  if (!sale.governmentReference || !['HANDOVER_PENDING', 'PAYOUT_PROTECTION', 'PAYOUT_PENDING', 'PAYOUT_PROCESSING', 'PAYOUT_CONFIRMED', 'COMPLETED'].includes(sale.status)) throw new Error('OWNERSHIP_TRANSFER_REQUIRED');
  const contractNumber = `MRK-${sale.id.toUpperCase()}`;
  const transferredAt = auditTime(sale.auditLogs, log => log.action === 'OWNERSHIP_TRANSFERRED') ?? sale.updatedAt.toISOString();
  const contractData = {
    contractNumber,
    operationId: sale.id,
    createdAt: transferredAt,
    seller: { name: sale.sellerName, nationalId: sale.sellerNationalId, phone: sale.sellerPhone, verificationStatus: sale.sellerVerified ? 'VERIFIED' : 'UNVERIFIED' },
    buyer: { name: sale.buyerName, nationalId: sale.buyerNationalId, phone: sale.buyerPhone, verificationStatus: sale.buyerVerified ? 'VERIFIED' : 'UNVERIFIED' },
    vehicle: { plateNumber: sale.vehicle.plateNumber, vin: sale.vehicle.vin, make: sale.vehicle.make, model: sale.vehicle.model, year: sale.vehicle.year, color: sale.vehicle.color, mileage: sale.vehicle.mileage },
    financial: {
      vehicleAmountYER: Number(sale.vehicleAmountYER), platformFeeUSD: sale.platformFeeUSD, platformFeeYER: Number(sale.platformFeeYER),
      transferFeeUSD: sale.transferFeeUSD, transferFeeYER: Number(sale.transferFeeYER), listingCommissionUSD: sale.listingCommissionUSD,
      auctionFeeYER: Number(sale.auctionFeeYER), governmentFeesYER: Number(sale.governmentFeesYER), totalPaidYER: Number(sale.totalPaidYER),
      sellerPayoutYER: Number(sale.sellerPayoutYER), exchangeRate: Number(sale.exchangeRate), paymentMethod: sale.paymentMethod,
      paymentStatus: sale.paymentVerified && sale.fundsSecured ? 'SECURED' : sale.paymentVerified ? 'CONFIRMED' : 'PENDING',
    },
    transfer: { status: sale.governmentStatus || 'TRANSFERRED', governmentReference: sale.governmentReference, transferDate: transferredAt, electronicDocumentUrl: sale.electronicDocumentUrl || null },
    approvals: {
      buyerApprovedAt: auditTime(sale.auditLogs, log => log.newStatus === 'BUYER_ACCEPTED') ?? null,
      buyerOtpVerifiedAt: auditTime(sale.auditLogs, log => log.action === 'BUYER_OTP_VERIFIED') ?? null,
      sellerApprovedAt: auditTime(sale.auditLogs, log => log.action === 'SELLER_OTP_VERIFIED') ?? null,
      sellerOtpVerifiedAt: auditTime(sale.auditLogs, log => log.action === 'SELLER_OTP_VERIFIED') ?? null,
      paymentVerifiedAt: auditTime(sale.auditLogs, log => log.newStatus === 'PAYMENT_CONFIRMED') ?? null,
    },
    providerClaim: 'مرجع صادر عن مزود المرور المهيأ للمنصة؛ صفة الاعتماد الرسمي تحددها الجهة الحكومية المختصة.',
  };
  return createContractRecord({ saleId: sale.id, operationId: sale.id, contractData, contractNumber, createdBy });
}
