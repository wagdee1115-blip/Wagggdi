import { z } from 'zod';
import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';

const STAFF = new Set(['OWNER', 'SUPER_ADMIN', 'SUPPORT', 'ADMIN']);
const statusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED']);
const prioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const replySchema = z.object({ id: z.string().min(1).max(100), content: z.string().trim().min(1).max(5_000), isInternal: z.boolean().default(false) }).strict();
const updateSchema = z.object({ id: z.string().min(1).max(100), status: statusSchema.optional(), priority: prioritySchema.optional() }).strict()
  .refine(value => value.status !== undefined || value.priority !== undefined, { message: 'UPDATE_REQUIRED' });

function maskPhone(value: string) { return `${value.slice(0, 3)}***${value.slice(-3)}`; }
function maskEmail(value: string | null) {
  if (!value) return null;
  const [local, domain] = value.split('@');
  return domain ? `${local.slice(0, 2)}***@${domain}` : `${value.slice(0, 2)}***`;
}

async function staffUser() {
  const user = await getCurrentUser();
  if (!user) return { user: null, response: Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 }) };
  if (!STAFF.has(user.role)) return { user: null, response: Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 }) };
  return { user, response: null };
}

export async function GET(req: Request) {
  try {
    const auth = await staffUser();
    if (!auth.user) return auth.response!;
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (id && (id.length > 100 || !/^[A-Za-z0-9_-]+$/.test(id))) return Response.json({ ok: false, error: 'INVALID_TICKET_ID' }, { status: 400 });
    if (id) {
      const ticket = await db.supportTicket.findUnique({
        where: { id },
        select: {
          id: true, ticketNumber: true, category: true, subject: true, description: true,
          status: true, priority: true, lastReplyAt: true, closedAt: true, createdAt: true, updatedAt: true,
          user: { select: { fullName: true, phone: true, email: true } },
          messages: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, content: true, isInternal: true, createdAt: true, sender: { select: { fullName: true, role: true } } },
          },
          attachments: { orderBy: { createdAt: 'asc' }, select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } },
        },
      });
      if (!ticket) return Response.json({ ok: false, error: 'TICKET_NOT_FOUND' }, { status: 404 });
      return Response.json({ ok: true, ticket: { ...ticket, user: { fullName: ticket.user.fullName, phoneMasked: maskPhone(ticket.user.phone), emailMasked: maskEmail(ticket.user.email) } } }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    const parsedStatus = url.searchParams.get('status');
    const status = parsedStatus ? statusSchema.safeParse(parsedStatus) : null;
    if (status && !status.success) return Response.json({ ok: false, error: 'INVALID_STATUS' }, { status: 400 });
    const tickets = await db.supportTicket.findMany({
      where: status?.success ? { status: status.data } : undefined,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true, ticketNumber: true, category: true, subject: true, status: true, priority: true,
        lastReplyAt: true, createdAt: true, updatedAt: true,
        user: { select: { fullName: true } },
        _count: { select: { messages: true, attachments: true } },
      },
    });
    return Response.json({ ok: true, tickets }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const code = safeApiErrorCode(error);
    return Response.json({ ok: false, error: code }, { status: code === 'INTERNAL_ERROR' ? 500 : 400 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await staffUser();
    if (!auth.user) return auth.response!;
    await consumeCompositeRateLimit({ scope: 'admin-support-reply', limit: 60, windowMs: 60 * 60 * 1_000, userId: auth.user.id, ip: getTrustedClientIp(req) });
    const parsed = replySchema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "SupportTicket" WHERE id = ${parsed.data.id} FOR UPDATE`;
      const ticket = await tx.supportTicket.findUnique({ where: { id: parsed.data.id } });
      if (!ticket) return 'NOT_FOUND' as const;
      if (ticket.status === 'CLOSED') return 'CLOSED' as const;
      const message = await tx.supportMessage.create({
        data: { ticketId: ticket.id, senderId: auth.user.id, content: parsed.data.content, isInternal: parsed.data.isInternal },
        select: { id: true, content: true, isInternal: true, createdAt: true },
      });
      await tx.supportTicket.update({ where: { id: ticket.id }, data: { status: parsed.data.isInternal ? 'IN_PROGRESS' : 'WAITING_USER', lastReplyAt: new Date(), closedAt: null } });
      await tx.auditLog.create({ data: { userId: auth.user.id, action: parsed.data.isInternal ? 'SUPPORT_INTERNAL_NOTE_ADDED' : 'SUPPORT_STAFF_REPLIED', entityType: 'SUPPORT_TICKET', entityId: ticket.id } });
      if (!parsed.data.isInternal) await tx.notification.create({ data: { userId: ticket.userId, type: 'SUPPORT_TICKET', title: 'رد جديد من فريق الدعم', message: `وصل رد جديد على التذكرة ${ticket.ticketNumber}.`, priority: ticket.priority === 'URGENT' ? 'HIGH' : 'NORMAL', operationId: ticket.id, data: { ticketId: ticket.id } } });
      return message;
    });
    if (result === 'NOT_FOUND') return Response.json({ ok: false, error: 'TICKET_NOT_FOUND' }, { status: 404 });
    if (result === 'CLOSED') return Response.json({ ok: false, error: 'TICKET_CLOSED' }, { status: 409 });
    return Response.json({ ok: true, message: result }, { status: 201 });
  } catch (error) {
    const code = safeApiErrorCode(error);
    return Response.json({ ok: false, error: code }, { status: code === 'INTERNAL_ERROR' ? 500 : code === 'RATE_LIMITED' ? 429 : 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await staffUser();
    if (!auth.user) return auth.response!;
    await consumeCompositeRateLimit({ scope: 'admin-support-update', limit: 60, windowMs: 60 * 60 * 1_000, userId: auth.user.id, ip: getTrustedClientIp(req) });
    const parsed = updateSchema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "SupportTicket" WHERE id = ${parsed.data.id} FOR UPDATE`;
      const ticket = await tx.supportTicket.findUnique({ where: { id: parsed.data.id } });
      if (!ticket) return null;
      const updated = await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          ...(parsed.data.status ? { status: parsed.data.status, closedAt: ['RESOLVED', 'CLOSED'].includes(parsed.data.status) ? new Date() : null } : {}),
          ...(parsed.data.priority ? { priority: parsed.data.priority } : {}),
        },
        select: { id: true, status: true, priority: true, updatedAt: true },
      });
      await tx.auditLog.create({ data: { userId: auth.user.id, action: 'SUPPORT_TICKET_UPDATED', entityType: 'SUPPORT_TICKET', entityId: ticket.id, metadata: { oldStatus: ticket.status, newStatus: updated.status, oldPriority: ticket.priority, newPriority: updated.priority } } });
      if (parsed.data.status && parsed.data.status !== ticket.status) await tx.notification.create({ data: { userId: ticket.userId, type: 'SUPPORT_TICKET', title: 'تغيرت حالة تذكرة الدعم', message: `تغيرت حالة التذكرة ${ticket.ticketNumber}.`, priority: 'NORMAL', operationId: ticket.id, data: { ticketId: ticket.id } } });
      return updated;
    });
    if (!result) return Response.json({ ok: false, error: 'TICKET_NOT_FOUND' }, { status: 404 });
    return Response.json({ ok: true, ticket: result });
  } catch (error) {
    const code = safeApiErrorCode(error);
    return Response.json({ ok: false, error: code }, { status: code === 'INTERNAL_ERROR' ? 500 : code === 'RATE_LIMITED' ? 429 : 400 });
  }
}
