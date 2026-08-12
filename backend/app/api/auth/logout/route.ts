import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { getSessionUser } from '@/lib/api-auth';
export async function POST(){
  const user=await getSessionUser();
  if(user) await db.user.update({where:{id:user.id},data:{sessionVersion:{increment:1}}});
  cookies().set('markabat_session','',{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',expires:new Date(0)});
  cookies().set('markabat_sensitive_session','',{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',expires:new Date(0)});
  return Response.json({ok:true});
}
