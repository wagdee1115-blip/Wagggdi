import { getCurrentUser, apiError } from '@/lib/api-auth';
import { notificationService } from '@/lib/notifications';

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok:false, error:'UNAUTHORIZED' }, { status:401 });
    const unreadOnly = new URL(req.url).searchParams.get('unread') === '1';
    const [notifications, unreadCount] = await Promise.all([
      notificationService.getNotifications(user.id, unreadOnly),
      notificationService.unreadCount(user.id),
    ]);
    return Response.json({ ok:true, notifications, unreadCount });
  } catch (e) { return apiError(e); }
}

export async function PATCH(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok:false, error:'UNAUTHORIZED' }, { status:401 });
    const body = await req.json().catch(() => ({}));
    if (body.all) await notificationService.markAllAsRead(user.id);
    else if (body.id) await notificationService.markAsRead(user.id, body.id);
    else return Response.json({ ok:false, error:'INVALID_INPUT' }, { status:400 });
    return Response.json({ ok:true });
  } catch (e) { return apiError(e); }
}
