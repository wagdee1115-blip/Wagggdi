import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/api-auth';
import { signSensitiveJwt } from '@/lib/auth';
import { otpService } from '@/lib/otp';
import { z } from 'zod';
const schema=z.object({operationId:z.string().min(1),type:z.enum(['BUYER','SELLER']),otpId:z.string(),otp:z.string().regex(/^\d{4}$/)});
export async function POST(req:Request){try{const u=await getCurrentUser();if(!u)return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});const p=schema.safeParse(await req.json());if(!p.success)return Response.json({ok:false,error:'INVALID_INPUT'},{status:400});await otpService.verifyOtp(p.data);const token=await signSensitiveJwt({sub:u.id,role:u.role,sessionVersion:u.sessionVersion});cookies().set('markabat_sensitive_session',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:120});return Response.json({ok:true,expiresInSeconds:120});}catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:'STEP_UP_FAILED'},{status:400});}}
