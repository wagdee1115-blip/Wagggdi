import { getCurrentUser } from '@/lib/api-auth';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';
import { startVehicleViolationPayment, vehicleComplianceApiError } from '@/lib/vehicle-compliance';

export async function POST(req: Request, { params }: { params: Promise<{ id: string; violationId: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('UNAUTHORIZED');
    const { id, violationId } = await params;
    const deviceId = req.headers.get('x-device-id')?.trim();
    await consumeCompositeRateLimit({
      scope: `vehicle-violation-payment:${id}`,
      limit: 5,
      windowMs: 60 * 60 * 1000,
      userId: user.id,
      ip: getTrustedClientIp(req),
      deviceId: deviceId ? rateLimitTarget(deviceId) : undefined,
    });
    const payment = await startVehicleViolationPayment({ userId: user.id, vehicleId: id, violationId });
    return Response.json({ ok: true, payment }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return vehicleComplianceApiError(error);
  }
}
