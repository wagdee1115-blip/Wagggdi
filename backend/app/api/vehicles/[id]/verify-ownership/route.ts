import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';
import { verifyVehicleOwnership } from '@/lib/vehicle-ownership-verification';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeCompositeRateLimit({
      scope: 'vehicle-ownership-verification', limit: 5, windowMs: 60 * 60 * 1_000,
      userId: user.id, ip: getTrustedClientIp(req),
    });
    const result = await verifyVehicleOwnership({ userId: user.id, vehicleId: (await params).id });
    return Response.json({ ok: true, verification: result }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const code = safeApiErrorCode(error);
    const status = code === 'UNAUTHORIZED' ? 401
      : code === 'VEHICLE_NOT_FOUND' ? 404
        : code === 'RATE_LIMITED' ? 429
          : code.startsWith('NOT_CONFIGURED:') ? 503
            : code.startsWith('TRAFFIC_PROVIDER_') ? 502
              : 409;
    return Response.json({ ok: false, error: code }, { status, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
