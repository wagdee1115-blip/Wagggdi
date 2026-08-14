import { describe, expect, it } from 'vitest';
import { OtpService, OtpProvider } from '../lib/otp';
import { db } from '../lib/db';

const dbIt = process.env.DATABASE_URL ? it : it.skip;

describe('OTP PostgreSQL verification',()=>{
  dbIt('uses DB records, four digits, five attempts and never returns the OTP', async()=>{
    let issued='';
    const provider:OtpProvider={name:'TEST_SMS',configured:true,async sendOtp(_phone,otp){issued=otp;return {providerReference:'TEST-REF',channel:'SMS'};}};
    const service=new OtpService(provider);
    const operationId=`OTP-TEST-${Date.now()}`;
    const phone=`777${String(Date.now()).slice(-7)}`;
    const user=await db.user.create({data:{fullName:'OTP OWNER',phone,passwordHash:'test',status:'ACTIVE'}});
    const other=await db.user.create({data:{fullName:'OTP ATTACKER',phone:`778${String(Date.now()).slice(-7)}`,passwordHash:'test',status:'ACTIVE'}});
    try {
      const sent=await service.sendOtp({phone,operationId,type:'BUYER',userId:user.id});
      expect(sent).not.toHaveProperty('otp');
      expect(issued).toMatch(/^\d{4}$/);
      const invalidOtp = issued === '0000' ? '0001' : '0000';
      await expect(service.verifyOtp({otpId:sent.otpId,otp:issued,operationId,type:'BUYER',userId:other.id})).rejects.toThrow('OTP_USER_MISMATCH');
      await expect(service.verifyOtp({otpId:sent.otpId,otp:invalidOtp,operationId,type:'BUYER',userId:user.id})).rejects.toThrow('OTP_INVALID');
      await expect(service.verifyOtp({otpId:sent.otpId,otp:invalidOtp,operationId,type:'BUYER',userId:user.id})).rejects.toThrow('OTP_INVALID');
      await expect(service.verifyOtp({otpId:sent.otpId,otp:invalidOtp,operationId,type:'BUYER',userId:user.id})).rejects.toThrow('OTP_INVALID');
      await expect(service.verifyOtp({otpId:sent.otpId,otp:invalidOtp,operationId,type:'BUYER',userId:user.id})).rejects.toThrow('OTP_INVALID');
      await expect(service.verifyOtp({otpId:sent.otpId,otp:invalidOtp,operationId,type:'BUYER',userId:user.id})).rejects.toThrow('OTP_MAX_ATTEMPTS');
    } finally {
      await db.otpRecord.deleteMany({where:{operationId}});
      await db.user.deleteMany({where:{id:{in:[user.id,other.id]}}});
    }
  });
});
