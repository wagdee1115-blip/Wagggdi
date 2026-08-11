import { z } from 'zod';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { getCurrentUser, apiError } from '@/lib/api-auth';
import { notificationService } from '@/lib/notifications';

const createSchema = z.object({
  category: z.string().min(2).max(60),
  subject: z.string().min(3).max(160),
  description: z.string().min(10).max(5000),
  priority: z.enum(['LOW','NORMAL','HIGH','URGENT']).default('NORMAL'),
});

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});
    const tickets = await db.supportTicket.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { createdAt:'asc' }, take: 100 } },
    });
    return Response.json({ok:true,tickets});
  } catch(e) { return apiError(e); }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});
    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ok:false,error:'INVALID_INPUT',details:parsed.error.flatten()},{status:400});
    const ticketNumber = `MK-${new Date().getFullYear()}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
    const ticket = await db.supportTicket.create({
      data: {
        ticketNumber, userId:user.id, ...parsed.data,
        messages: { create: { senderId:user.id, content:parsed.data.description } },
      },
      include: { messages:true },
    });
    await notificationService.sendNotification({userId:user.id,type:'SUPPORT_TICKET',title:'تم إنشاء تذكرة دعم',message:`تم إنشاء التذكرة ${ticketNumber} ويمكنك متابعة الردود من صفحة الدعم.`,priority:'NORMAL',channels:['IN_APP'],operationId:ticket.id});
    return Response.json({ok:true,ticket},{status:201});
  } catch(e) { return apiError(e); }
}
