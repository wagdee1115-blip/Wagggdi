import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { acceptAuthorizationByAuthorizedParty } from '@/lib/authorization';

const schema = z.object({ otpId: z.string().min(1), otp: z.string().regex(/^\d{4}$/) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const authorization = await acceptAuthorizationByAuthorizedParty({ authorizationId: params.id, authorizedUserId: user.id, otpId: p.data.otpId, otp: p.data.otp });
    return Response.json({ ok: true, authorization });
  } catch (e) { return Response.json({ ok: false, error: e instanceof Error ? e.message : 'AUTHORIZATION_ACCEPT_FAILED' }, { status: 400 }); }
}
