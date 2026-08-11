import { getCurrentUser, apiError } from '@/lib/api-auth';
import { otpService, type OtpType } from '@/lib/otp';
import { z } from 'zod';

const schema = z.object({ operationId: z.string().min(1), type: z.enum(['BUYER', 'SELLER']) });

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? undefined;
    const deviceId = req.headers.get('x-device-id') ?? undefined;
    const result = await otpService.sendOtp({ phone: user.phone, operationId: parsed.data.operationId, type: parsed.data.type as OtpType, ip, deviceId });
    return Response.json({ ok: true, otpId: result.otpId, expiresAt: result.expiresAt, providerReference: result.providerReference });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'OTP_SEND_FAILED';
    const status = msg.startsWith('NOT_CONFIGURED') ? 503 : msg.includes('RATE_LIMIT') || msg === 'OTP_RESEND_TOO_SOON' ? 429 : 400;
    return Response.json({ ok: false, error: msg }, { status });
  }
}
