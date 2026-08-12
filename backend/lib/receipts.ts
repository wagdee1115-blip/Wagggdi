import { createHash, randomUUID } from 'crypto';
import { db } from './db';

export interface Receipt {
  id: string; transactionId: string; operationId: string; amountYER: number; currency: string; exchangeRate: number; platformFeeYER: number; platformFeeUSD: number; paymentMethod: string; status: string; qrCode: string; verificationUrl: string; hash: string; createdAt: Date; createdBy: string;
}

function mapInvoice(i:any):Receipt { return { id:i.id, transactionId:i.saleTransactionId ?? i.id, operationId:i.saleTransactionId ?? i.id, amountYER:Number(i.totalYER), currency:i.currency, exchangeRate:Number(i.exchangeRateSnapshot), platformFeeYER:Number(i.listingCommissionUSD ?? 0) * Number(i.exchangeRateSnapshot), platformFeeUSD:Number(i.listingCommissionUSD ?? 0), paymentMethod:'SYSTEM', status:i.status, qrCode:i.qrCode ?? '', verificationUrl:i.verificationUrl ?? '', hash:i.receiptHash ?? '', createdAt:i.createdAt, createdBy:i.userId }; }

export class ReceiptService {
  async generateReceipt(params:{transactionId:string;operationId:string;amountYER:number;platformFeeYER:number;platformFeeUSD:number;exchangeRate:number;paymentMethod:string;status:string;createdBy:string}):Promise<Receipt>{
    const hash=createHash('sha256').update(`${params.transactionId}|${params.operationId}|${params.amountYER}|${params.createdBy}|${randomUUID()}`).digest('hex');
    const verificationUrl=`/api/receipts/${hash}`;
    const invoice=await db.invoice.create({data:{invoiceNumber:`RCT-${Date.now()}-${randomUUID().slice(0,6).toUpperCase()}`,userId:params.createdBy,saleTransactionId:params.transactionId,vehiclePriceYER:params.amountYER,listingCommissionUSD:params.platformFeeUSD,transferFeeUSD:0,auctionFeeYER:0,governmentFeeYER:0,taxYER:0,exchangeRateSnapshot:params.exchangeRate,totalYER:params.amountYER,currency:'YER',status:params.status,receiptHash:hash,verificationUrl,qrCode:verificationUrl}});
    return mapInvoice(invoice);
  }
  async getReceipt(id:string){const i=await db.invoice.findUnique({where:{id}});return i?mapInvoice(i):undefined;}
  async getReceiptsByOperation(operationId:string){const rows=await db.invoice.findMany({where:{saleTransactionId:operationId},orderBy:{createdAt:'desc'}});return rows.map(mapInvoice);}
  async verifyReceipt(id:string,hash:string){const i=await db.invoice.findUnique({where:{id}});if(!i||i.receiptHash!==hash)return {valid:false};return {valid:true,receipt:mapInvoice(i)};}
}
export const receiptService=new ReceiptService();
