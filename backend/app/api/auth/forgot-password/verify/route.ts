import { z } from 'zod';
import { verifyPasswordResetOtp } from '@/lib/password-recovery';

const schema = z.object({ recoveryToken: z.string().min(40).max(100), otp: z.string().regex(/^\d{4}$/) });

export async function POST(req: Request) {
  try {
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const result = await verifyPasswordResetOtp(p.data);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'OTP_INVALID' }, { status: 400 });
  }
}
