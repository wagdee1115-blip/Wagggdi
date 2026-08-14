import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/api-auth';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';

const schema = z.object({ content: z.string().trim().min(1).max(5000) }).strict();

export async function GET(_: Request, { params }: { params: Promise<{id:string}> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});
    const ticket = await db.supportTicket.findFirst({
      where: { id:(await params).id, userId:user.id },
      select: {
        id:true, ticketNumber:true, category:true, subject:true, description:true, status:true,
        priority:true, lastReplyAt:true, createdAt:true, updatedAt:true,
        messages:{
          where:{isInternal:false}, orderBy:{createdAt:'asc'},
          select:{id:true,content:true,createdAt:true},
        },
        attachments:{
          orderBy:{createdAt:'asc'},
          select:{id:true,fileName:true,mimeType:true,sizeBytes:true,createdAt:true},
        },
      }
    });
    if (!ticket) return Response.json({ok:false,error:'TICKET_NOT_FOUND'},{status:404});
    return Response.json({ok:true,ticket}, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ok:false,error:'SUPPORT_UNAVAILABLE'},{status:500}); }
}

export async function POST(req: Request,{ params }: { params: Promise<{id:string}> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});
    await consumeCompositeRateLimit({
      scope:'support-ticket-reply', limit:20, windowMs:60 * 60 * 1000, userId:user.id,
      ip:getTrustedClientIp(req),
      deviceId:req.headers.get('x-device-id')?.trim() ? rateLimitTarget(req.headers.get('x-device-id')!.trim().slice(0, 200)) : undefined,
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ok:false,error:'INVALID_INPUT'},{status:400});
    const { id } = await params;
    const result = await db.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM "SupportTicket" WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) return { error: 'TICKET_NOT_FOUND' as const };
      const ticket = await tx.supportTicket.findFirst({ where: { id, userId: user.id }, select: { id: true, status: true } });
      if (!ticket) return { error: 'TICKET_NOT_FOUND' as const };
      if (['CLOSED','RESOLVED'].includes(ticket.status)) return { error: 'TICKET_CLOSED' as const };
      const message = await tx.supportMessage.create({data:{ticketId:ticket.id,senderId:user.id,content:parsed.data.content},select:{id:true,content:true,createdAt:true}});
      await tx.supportTicket.update({where:{id:ticket.id},data:{status:'OPEN',lastReplyAt:new Date()}});
      return { message };
    });
    if ('error' in result) {
      return Response.json({ok:false,error:result.error},{status:result.error === 'TICKET_NOT_FOUND' ? 404 : 409});
    }
    return Response.json({ok:true,message:result.message});
  } catch(e) {
    if (e instanceof Error && e.message === 'RATE_LIMITED') return Response.json({ok:false,error:'RATE_LIMITED'},{status:429});
    return Response.json({ok:false,error:'SUPPORT_REPLY_FAILED'},{status:500});
  }
}
