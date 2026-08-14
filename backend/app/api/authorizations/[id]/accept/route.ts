import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { acceptAuthorizationByAuthorizedParty } from '@/lib/authorization';
import { authorizationErrorResponse, getAuthorizationView } from '../../authorization-view';

const schema = z.object({ otpId: z.string().min(1).max(100), otp: z.string().regex(/^\d{4}$/) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const id = (await params).id;
    await acceptAuthorizationByAuthorizedParty({ authorizationId: id, authorizedUserId: user.id, otpId: parsed.data.otpId, otp: parsed.data.otp });
    const authorization = await getAuthorizationView(id, user.id);
    if (!authorization) throw new Error('AUTHORIZATION_NOT_FOUND');
    return Response.json({ ok: true, authorization }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return authorizationErrorResponse(error, 'AUTHORIZATION_ACCEPT_FAILED');
  }
}
