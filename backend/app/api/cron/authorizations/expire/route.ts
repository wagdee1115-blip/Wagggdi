import { expireAuthorizations } from '@/lib/authorization';
export async function GET(req:Request){const auth=req.headers.get('authorization');if(!process.env.CRON_SECRET||auth!==`Bearer ${process.env.CRON_SECRET}`)return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});return Response.json({ok:true,count:await expireAuthorizations()});}
