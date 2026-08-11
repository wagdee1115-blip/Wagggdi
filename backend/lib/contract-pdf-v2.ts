import { createHash } from 'crypto';
import { db } from './db';
export async function createContractRecord(params:{saleId:string;operationId:string;contractData:unknown;contractNumber:string;createdBy:string}){
  const hash=createHash('sha256').update(JSON.stringify(params.contractData)).digest('hex');
  return db.saleContract.upsert({where:{vehicleSaleId:params.saleId},create:{vehicleSaleId:params.saleId,contractNumber:params.contractNumber,operationId:params.operationId,contractData:params.contractData as any,status:'ISSUED'},update:{contractData:params.contractData as any,status:'ISSUED'}}).then(x=>({contract:x,hash}));
}
