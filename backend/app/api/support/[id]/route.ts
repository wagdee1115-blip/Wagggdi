import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser, apiError } from '@/lib/api-auth';

const schema = z.object({ content: z.string().min(1).max(5000) });

export async function GET(_: Request, { params }: { params: Promise<{id:string}> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});
    const ticket = await db.supportTicket.findFirst({
      where: { id:(await params).id, userId:user.id },
      include: { messages:{orderBy:{createdAt:'asc'} } }
    });
    if (!ticket) return Response.json({ok:false,error:'TICKET_NOT_FOUND'},{status:404});
    return Response.json({ok:true,ticket});
  } catch(e) { return apiError(e); }
}

export async function POST(req: Request,{ params }: { params: Promise<{id:string}> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ok:false,error:'INVALID_INPUT'},{status:400});
    const ticket = await db.supportTicket.findFirst({where:{id:(await params).id,userId:user.id}});
    if (!ticket) return Response.json({ok:false,error:'TICKET_NOT_FOUND'},{status:404});
    if (['CLOSED','RESOLVED'].includes(ticket.status)) return Response.json({ok:false,error:'TICKET_CLOSED'},{status:409});
    const [message] = await db.$transaction([
      db.supportMessage.create({data:{ticketId:ticket.id,senderId:user.id,content:parsed.data.content}}),
      db.supportTicket.update({where:{id:ticket.id},data:{status:'OPEN',lastReplyAt:new Date()}})
    ]);
    return Response.json({ok:true,message});
  } catch(e) { return apiError(e); }
}
