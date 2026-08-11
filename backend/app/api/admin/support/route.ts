import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/api-auth';

const STAFF = ['OWNER', 'SUPER_ADMIN', 'SUPPORT', 'ADMIN'];

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user || !STAFF.includes(user.role)) return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const ticket = await db.supportTicket.findFirst({
      where: id ? { id } : {},
      include: { user: true, messages: { orderBy: { createdAt: 'asc' } }, attachments: { orderBy: { createdAt: 'asc' } } },
    });
    if (!ticket) return Response.json({ ok: false, error: 'TICKET_NOT_FOUND' }, { status: 404 });
    return Response.json({
      ok: true,
      ticket: {
        ...ticket,
        user: {
          id: ticket.user.id,
          fullName: ticket.user.fullName,
          phone: `${ticket.user.phone.slice(0, 3)}***${ticket.user.phone.slice(-3)}`,
          email: ticket.user.email ? `${ticket.user.email.slice(0, 2)}***` : undefined,
        },
      },
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'SUPPORT_FAILED' }, { status: 400 });
  }
}
