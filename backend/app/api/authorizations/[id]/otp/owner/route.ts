import { getCurrentUser } from '@/lib/api-auth';
import { requestAuthorizationOtp } from '@/lib/authorization';
import { getTrustedClientIp } from '@/lib/request-identity';
import { authorizationErrorResponse } from '../../../authorization-view';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const result = await requestAuthorizationOtp({
      authorizationId: (await params).id,
      actorId: user.id,
      party: 'OWNER',
      ip: getTrustedClientIp(req),
      deviceId: req.headers.get('x-device-id')?.slice(0, 200) || undefined,
    });
    return Response.json({ ok: true, otpId: result.otpId, expiresAt: result.expiresAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return authorizationErrorResponse(error, 'OTP_REQUEST_FAILED');
  }
}
