import { db } from './db';

export type PaymentMethod = 'BANK_TRANSFER' | 'MADA' | 'APPLE_PAY' | 'CASH' | 'WALLET';
export type PaymentVerificationStatus = 'PENDING_RECEIPT' | 'PENDING_VERIFICATION' | 'PAYMENT_PENDING_VERIFICATION' | 'VERIFIED' | 'FAILED' | 'CANCELLED';

export interface PaymentReceipt {
  id: string; operationId: string; amountYER: number; method: PaymentMethod; receiptUrl?: string; receiptFileName?: string; uploadedAt: Date; uploadedBy: string;
  status: PaymentVerificationStatus; verifiedBy?: string; verifiedAt?: Date; verificationNotes?: string; bankReference?: string;
}

export interface EnhancedPaymentProvider {
  name: string;
  createPaymentRequest(amount: number, currency: string, operationId: string): Promise<{ reference: string; status: string; instructions: string }>;
  verifyPaymentByAdmin(reference: string, adminId: string, adminName: string, bankReference?: string): Promise<{ verified: boolean; status: PaymentVerificationStatus; receipt?: PaymentReceipt }>;
}

function mapReceipt(r: any): PaymentReceipt { return { id:r.id, operationId:r.vehicleSaleId, amountYER:Number(r.amountYER), method:r.method as PaymentMethod, receiptUrl:r.receiptUrl ?? undefined, receiptFileName:r.receiptFileName ?? undefined, uploadedAt:r.uploadedAt, uploadedBy:r.uploadedBy, status:r.status, verifiedBy:r.verifiedBy ?? undefined, verifiedAt:r.verifiedAt ?? undefined, verificationNotes:r.verificationNotes ?? undefined, bankReference:r.bankReference ?? undefined }; }

export class BankTransferWithReceiptProvider implements EnhancedPaymentProvider {
  name = 'BANK_TRANSFER_WITH_RECEIPT_DB';

  async createPaymentRequest(amount: number, currency: string, operationId: string) {
    if (!process.env.BANK_TRANSFER_ACCOUNT_ID) throw new Error('NOT_CONFIGURED:BANK_TRANSFER_ACCOUNT_REQUIRED');
    const reference = `BANK-REQ-${operationId}`;
    const instructions = `يرجى تحويل المبلغ ${amount} ${currency} إلى الحساب الوسيط المعتمد. المرجع: ${reference}. رفع الإيصال لا يعتبر تأكيدًا للدفع حتى يتم التحقق منه.`;
    return { reference, status: 'WAITING_PAYMENT', instructions };
  }

  async uploadReceipt(params: { operationId: string; amountYER: number; receiptUrl: string; receiptFileName: string; uploadedBy: string; method: PaymentMethod }): Promise<PaymentReceipt> {
    const sale = await db.vehicleSale.findUnique({ where: { id: params.operationId }, select: { id: true } });
    if (!sale) throw new Error('SALE_NOT_FOUND');
    const receipt = await db.paymentReceipt.create({ data: { vehicleSaleId: sale.id, amountYER: params.amountYER, method: params.method, receiptUrl: params.receiptUrl, receiptFileName: params.receiptFileName, uploadedBy: params.uploadedBy, status: 'PAYMENT_PENDING_VERIFICATION' } });
    return mapReceipt(receipt);
  }

  async verifyPaymentByAdmin(receiptId: string, adminId: string, adminName: string, bankReference?: string) {
    const receipt = await db.paymentReceipt.update({ where: { id: receiptId }, data: { status: 'VERIFIED', verifiedBy: adminId, verifiedAt: new Date(), bankReference, verificationNotes: `Verified by ${adminName}` } });
    return { verified: true, receipt: mapReceipt(receipt) };
  }

  async markPaymentVerified(operationId: string) {
    const receipt = await db.paymentReceipt.findFirst({ where: { vehicleSaleId: operationId }, orderBy: { createdAt: 'desc' } });
    return receipt ? mapReceipt(receipt) : undefined;
  }

  async getReceipt(id: string) { const r=await db.paymentReceipt.findUnique({where:{id}}); return r?mapReceipt(r):undefined; }
  async getReceiptsByOperation(operationId: string) { const rows=await db.paymentReceipt.findMany({where:{vehicleSaleId:operationId},orderBy:{createdAt:'desc'}}); return rows.map(mapReceipt); }
}

export const paymentProvider = new BankTransferWithReceiptProvider();
export function isRealPaymentProviderConfigured(){ return Boolean(process.env.PAYMENT_PROVIDER_URL && process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET); }
