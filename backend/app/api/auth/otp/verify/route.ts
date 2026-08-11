import { getCurrentUser, apiError } from '@/lib/api-auth';
import { otpService } from '@/lib/otp';
import { z } from 'zod';

const schema = z.object({ otpId: z.string().min(1), operationId: z.string().min(1), type: z.enum(['BUYER', 'SELLER']), otp: z.string().regex(/^\d{4}$/) });

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const result = await otpService.verifyOtp(parsed.data);
    return Response.json({ ok: true, verified: result.verified });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'OTP_VERIFY_FAILED';
    const status = msg === 'OTP_REPLAY' ? 409 : msg.includes('ATTEMPTS') || msg === 'OTP_EXPIRED' ? 410 : 400;
    return Response.json({ ok: false, error: msg }, { status });
  }
}
