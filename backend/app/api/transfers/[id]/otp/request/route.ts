import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { getTrustedClientIp } from '@/lib/request-identity';
import { requestSalePartyOtp } from '@/lib/transfer-workflow';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const result = await requestSalePartyOtp({
      saleId: (await params).id,
      actorId: user.id,
      ip: getTrustedClientIp(req),
      deviceId: req.headers.get('x-device-id') ?? undefined,
    });
    return Response.json({ ok: true, otpId: result.otpId, expiresAt: result.expiresAt, party: result.party, purpose: result.purpose });
  } catch (error) {
    const message = safeApiErrorCode(error);
    const status = message === 'INTERNAL_ERROR' ? 500 : message.startsWith('NOT_CONFIGURED') ? 503 : message.includes('RATE_LIMIT') || message === 'OTP_RESEND_TOO_SOON' ? 429 : message === 'FORBIDDEN' ? 403 : message.endsWith('_NOT_FOUND') ? 404 : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
