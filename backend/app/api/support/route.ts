import { z } from 'zod';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/api-auth';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';

const createSchema = z.object({
  category: z.string().trim().min(2).max(60),
  subject: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(5000),
  priority: z.enum(['LOW','NORMAL','HIGH','URGENT']).default('NORMAL'),
}).strict();

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});
    const tickets = await db.supportTicket.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, ticketNumber: true, category: true, subject: true, description: true,
        status: true, priority: true, lastReplyAt: true, createdAt: true, updatedAt: true,
      },
    });
    return Response.json({ok:true,tickets}, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ok:false,error:'SUPPORT_UNAVAILABLE'},{status:500}); }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});
    await consumeCompositeRateLimit({
      scope: 'support-ticket-create', limit: 5, windowMs: 60 * 60 * 1000, userId: user.id,
      ip: req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
      deviceId: req.headers.get('x-device-id') ?? undefined,
    });
    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ok:false,error:'INVALID_INPUT',details:parsed.error.flatten()},{status:400});
    const ticketNumber = `MK-${new Date().getFullYear()}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
    const ticket = await db.$transaction(async tx => {
      const created = await tx.supportTicket.create({
        data: {
          ticketNumber, userId:user.id, ...parsed.data,
          messages: { create: { senderId:user.id, content:parsed.data.description } },
        },
        select: { id:true, ticketNumber:true, category:true, subject:true, status:true, priority:true, createdAt:true },
      });
      await tx.notification.create({
        data: {
          userId:user.id, type:'SUPPORT_TICKET', title:'تم إنشاء تذكرة دعم',
          message:`تم إنشاء التذكرة ${ticketNumber} ويمكنك متابعة الردود من صفحة الدعم.`,
          priority:'NORMAL', operationId:created.id,
        },
      });
      return created;
    });
    return Response.json({ok:true,ticket},{status:201});
  } catch(e) {
    if (e instanceof Error && e.message === 'RATE_LIMITED') return Response.json({ok:false,error:'RATE_LIMITED'},{status:429});
    return Response.json({ok:false,error:'SUPPORT_CREATE_FAILED'},{status:500});
  }
}
