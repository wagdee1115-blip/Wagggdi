import { z } from 'zod';
import { requestPasswordReset } from '@/lib/password-recovery';

const schema = z.object({ phone: z.string().min(7), deviceId: z.string().max(200).optional() });

export async function POST(req: Request) {
  try {
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const result = await requestPasswordReset({ phone: p.data.phone, deviceId: p.data.deviceId, ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const m = e instanceof Error ? e.message : 'PASSWORD_RESET_FAILED';
    return Response.json({ ok: false, error: m }, { status: m.startsWith('NOT_CONFIGURED') ? 503 : 400 });
  }
}
