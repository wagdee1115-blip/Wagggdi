import { getCurrentUser } from '@/lib/api-auth';
import { revokeAuthorization } from '@/lib/authorization';
export async function POST(_:Request,{params}:{params:{id:string}}){try{const user=await getCurrentUser();if(!user)return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});const auth=await revokeAuthorization(params.id,user.id);return Response.json({ok:true,authorization:auth});}catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:'AUTHORIZATION_REVOKE_FAILED'},{status:400});}}
