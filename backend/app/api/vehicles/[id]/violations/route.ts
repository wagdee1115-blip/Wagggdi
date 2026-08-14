import { getCurrentUser } from '@/lib/api-auth';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';
import { inquireAndSyncVehicleViolations, vehicleComplianceApiError } from '@/lib/vehicle-compliance';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('UNAUTHORIZED');
    const { id } = await params;
    const deviceId = req.headers.get('x-device-id')?.trim();
    await consumeCompositeRateLimit({
      scope: `vehicle-violations:${id}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
      userId: user.id,
      ip: getTrustedClientIp(req),
      deviceId: deviceId ? rateLimitTarget(deviceId) : undefined,
    });
    const violations = await inquireAndSyncVehicleViolations({ userId: user.id, vehicleId: id });
    return Response.json({ ok: true, source: 'TRAFFIC_PROVIDER', violations }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return vehicleComplianceApiError(error);
  }
}
