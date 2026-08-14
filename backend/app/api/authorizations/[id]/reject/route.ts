import { getCurrentUser } from '@/lib/api-auth';
import { rejectAuthorization } from '@/lib/authorization';
import { authorizationErrorResponse, getAuthorizationView } from '../../authorization-view';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const id = (await params).id;
    await rejectAuthorization(id, user.id);
    const authorization = await getAuthorizationView(id, user.id);
    if (!authorization) throw new Error('AUTHORIZATION_NOT_FOUND');
    return Response.json({ ok: true, authorization }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return authorizationErrorResponse(error, 'AUTHORIZATION_REJECT_FAILED');
  }
}
