import { describe, expect, it } from 'vitest';
import { OtpService, OtpProvider } from '../lib/otp';
import { db } from '../lib/db';

describe('OTP PostgreSQL verification',()=>{
  it('uses DB records, four digits, five attempts and never returns the OTP', async()=>{
    if(!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    let issued='';
    const provider:OtpProvider={name:'TEST_SMS',configured:true,async sendOtp(_phone,otp){issued=otp;return {providerReference:'TEST-REF',channel:'SMS'};}};
    const service=new OtpService(provider);
    const operationId=`OTP-TEST-${Date.now()}`;
    try {
      const sent=await service.sendOtp({phone:`777${String(Date.now()).slice(-7)}`,operationId,type:'BUYER'});
      expect(sent).not.toHaveProperty('otp');
      expect(issued).toMatch(/^\d{4}$/);
      await expect(service.verifyOtp({otpId:sent.otpId,otp:'0000',operationId,type:'BUYER'})).rejects.toThrow('OTP_INVALID');
      await expect(service.verifyOtp({otpId:sent.otpId,otp:'0000',operationId,type:'BUYER'})).rejects.toThrow('OTP_INVALID');
      await expect(service.verifyOtp({otpId:sent.otpId,otp:'0000',operationId,type:'BUYER'})).rejects.toThrow('OTP_INVALID');
      await expect(service.verifyOtp({otpId:sent.otpId,otp:'0000',operationId,type:'BUYER'})).rejects.toThrow('OTP_INVALID');
      await expect(service.verifyOtp({otpId:sent.otpId,otp:'0000',operationId,type:'BUYER'})).rejects.toThrow('OTP_MAX_ATTEMPTS');
    } finally { await db.otpRecord.deleteMany({where:{operationId}}); }
  });
});
