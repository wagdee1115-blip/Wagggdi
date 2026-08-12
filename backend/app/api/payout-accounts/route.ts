import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { verifyPayoutAccount } from '@/lib/payout-account';
const schema=z.object({provider:z.string().min(2).max(100),accountIdentifierEncrypted:z.string().min(4),accountIdentifierMasked:z.string().min(4).max(100),accountHolderName:z.string().min(2).max(200)});
export async function POST(req:Request){try{const u=await getCurrentUser();if(!u)return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});const p=schema.safeParse(await req.json());if(!p.success)return Response.json({ok:false,error:'INVALID_INPUT'},{status:400});const account=await verifyPayoutAccount({userId:u.id,...p.data});return Response.json({ok:true,account});}catch(e){const m=e instanceof Error?e.message:'PAYOUT_ACCOUNT_FAILED';return Response.json({ok:false,error:m},{status:m.startsWith('NOT_CONFIGURED')?503:400});}}
