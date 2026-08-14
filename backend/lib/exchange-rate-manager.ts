import { randomUUID } from 'crypto';
import { db } from './db';
import { ExchangeRateProvider } from './exchange-rate';
import { OtpService } from './otp';
export class ExchangeRateManager {
  constructor(private provider=new ExchangeRateProvider(), private otpService=new OtpService()){}
  async requestRateChange(params:{newRate:number;requestedBy:string;requestedByName:string;requestedByRole:string;reason:string;ipAddress?:string;sessionId?:string}){
    if(!['OWNER','SUPER_ADMIN'].includes(params.requestedByRole))throw new Error('FORBIDDEN');
    if(params.newRate<=0)throw new Error('EXCHANGE_RATE_INVALID');
    const user=await db.user.findUnique({where:{id:params.requestedBy}});if(!user)throw new Error('USER_NOT_FOUND');
    const current=await this.provider.getCurrentRate();
    const requestId=`EXCHANGE-REQ-${randomUUID()}`;
    const operation=await db.operation.create({data:{operationNumber:requestId,type:'EXCHANGE_RATE_CHANGE',userId:user.id,status:'PENDING',idempotencyKey:requestId,metadata:{oldRate:current.usdToYer,newRate:params.newRate,reason:params.reason,ipAddress:params.ipAddress,sessionId:params.sessionId}}});
    const otp=await this.otpService.sendOtp({phone:user.phone,operationId:operation.id,type:'SELLER',userId:user.id,ip:params.ipAddress,deviceId:params.sessionId});
    await db.operation.update({where:{id:operation.id},data:{metadata:{oldRate:current.usdToYer,newRate:params.newRate,reason:params.reason,ipAddress:params.ipAddress,sessionId:params.sessionId,otpId:otp.otpId}}});
    return {requestId:operation.id,otpId:otp.otpId,expiresAt:otp.expiresAt,message:'OTP sent to authorized account holder'};
  }
  async confirmRateChangeWithOtp(params:{requestId:string;otpId:string;otp:string;confirmedBy:string;confirmedByName:string}){
    const operation=await db.operation.findUnique({where:{id:params.requestId}});if(!operation||operation.type!=='EXCHANGE_RATE_CHANGE')throw new Error('REQUEST_NOT_FOUND');if(operation.status!=='PENDING')throw new Error('REQUEST_NOT_PENDING');
    const metadata=(operation.metadata&&typeof operation.metadata==='object'?operation.metadata:{}) as Record<string,unknown>;
    if(String(metadata.otpId||'')!==params.otpId)throw new Error('OTP_MISMATCH');
    if(operation.userId!==params.confirmedBy)throw new Error('FORBIDDEN');
    await this.otpService.verifyOtp({otpId:params.otpId,otp:params.otp,operationId:operation.id,type:'SELLER',userId:params.confirmedBy});
    const result=await this.provider.updateRate({newRate:Number(metadata.newRate),updatedBy:params.confirmedBy,updatedByName:params.confirmedByName,reason:String(metadata.reason||''),source:'MANUAL'});
    await db.operation.update({where:{id:operation.id},data:{status:'SUCCESS',providerReference:result.newRate.id}});
    return result;
  }
  async getCurrentRate(){return this.provider.getCurrentRate();}
  async getHistory(){return this.provider.getHistory();}
  async getPendingRequests(){return db.operation.findMany({where:{type:'EXCHANGE_RATE_CHANGE',status:'PENDING'},orderBy:{createdAt:'desc'}});}
  async freezeRateForOperation(){return this.provider.freezeRateForOperation();}
}
export const exchangeRateManager=new ExchangeRateManager();
