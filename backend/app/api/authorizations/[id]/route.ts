import { getCurrentUser } from '@/lib/api-auth';
import { getAuthorizationView } from '../authorization-view';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try {
    const authorization = await getAuthorizationView((await params).id, user.id);
    if (!authorization) return Response.json({ ok: false, error: 'AUTHORIZATION_NOT_FOUND' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return Response.json({ ok: true, authorization }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ ok: false, error: 'AUTHORIZATION_UNAVAILABLE' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
