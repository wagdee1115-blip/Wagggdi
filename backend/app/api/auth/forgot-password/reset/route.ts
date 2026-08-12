import { z } from 'zod';
import { verifyJwt } from '@/lib/auth';
import { completePasswordReset } from '@/lib/password-recovery';

const schema = z.object({ resetToken: z.string(), password: z.string().min(10).max(200) });

export async function POST(req: Request) {
  try {
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const payload = await verifyJwt(p.data.resetToken);
    if (!payload?.sub || payload.purpose !== 'PASSWORD_RESET' || !payload.resetRequestId) return Response.json({ ok: false, error: 'RESET_TOKEN_INVALID' }, { status: 401 });
    await completePasswordReset({ resetRequestId: String(payload.resetRequestId), userId: String(payload.sub), password: p.data.password });
    return Response.json({ ok: true, message: 'PASSWORD_RESET_COMPLETED' });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'PASSWORD_RESET_FAILED' }, { status: 400 });
  }
}
