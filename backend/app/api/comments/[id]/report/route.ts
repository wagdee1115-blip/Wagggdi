import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { consumeRateLimit } from '@/lib/rate-limit';
const schema=z.object({reason:z.string().min(3).max(200)});
export async function POST(req:Request,{ params }: { params: Promise<{id:string}> }){try{const u=await getCurrentUser();if(!u)return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});await consumeRateLimit(`comment-report:user:${u.id}`,10,60_000);const p=schema.safeParse(await req.json());if(!p.success)return Response.json({ok:false,error:'INVALID_INPUT'},{status:400});const comment=await db.comment.findUnique({where:{id:(await params).id},select:{id:true}});if(!comment)return Response.json({ok:false,error:'COMMENT_NOT_FOUND'},{status:404});const report=await db.commentReport.create({data:{commentId:comment.id,reporterId:u.id,reason:p.data.reason}});return Response.json({ok:true,report},{status:201});}catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:'COMMENT_REPORT_FAILED'},{status:400});}}
