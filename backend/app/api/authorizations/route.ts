import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { createAuthorization } from '@/lib/authorization';
const schema = z.object({ vehicleId:z.string().min(1), authorizedUserId:z.string().min(1), type:z.enum(['SELL_ONLY','SELL_AND_RECEIVE']), minPrice:z.number().positive().optional(), validUntil:z.string().datetime() });
export async function POST(req:Request){
  try{ const user=await getCurrentUser(); if(!user||user.status!=='ACTIVE') return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401}); const p=schema.safeParse(await req.json()); if(!p.success)return Response.json({ok:false,error:'INVALID_INPUT'},{status:400}); const auth=await createAuthorization({ownerId:user.id,authorizedUserId:p.data.authorizedUserId,vehicleId:p.data.vehicleId,type:p.data.type,minPrice:p.data.minPrice,validUntil:new Date(p.data.validUntil)}); return Response.json({ok:true,authorization:auth},{status:201}); }
  catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:'AUTHORIZATION_FAILED'},{status:400});}
}
