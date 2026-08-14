import { getCurrentUser } from '@/lib/api-auth';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';
import {
  getVehicleRenewalOverview,
  submitVehicleRegistrationRenewal,
  vehicleComplianceApiError,
} from '@/lib/vehicle-compliance';

async function rateLimit(req: Request, userId: string, vehicleId: string, action: 'read' | 'submit') {
  const deviceId = req.headers.get('x-device-id')?.trim();
  await consumeCompositeRateLimit({
    scope: `vehicle-registration-renewal-${action}:${vehicleId}`,
    limit: action === 'submit' ? 5 : 20,
    windowMs: 60 * 60 * 1000,
    userId,
    ip: getTrustedClientIp(req),
    deviceId: deviceId ? rateLimitTarget(deviceId) : undefined,
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('UNAUTHORIZED');
    const { id } = await params;
    await rateLimit(req, user.id, id, 'read');
    const renewal = await getVehicleRenewalOverview({ userId: user.id, vehicleId: id });
    return Response.json({ ok: true, source: 'TRAFFIC_PROVIDER', renewal }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return vehicleComplianceApiError(error);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('UNAUTHORIZED');
    const { id } = await params;
    await rateLimit(req, user.id, id, 'submit');
    const request = await submitVehicleRegistrationRenewal({ userId: user.id, vehicleId: id });
    return Response.json({ ok: true, request }, {
      status: ['PAYMENT_REQUIRED', 'PENDING_GOVERNMENT'].includes(request?.status ?? '') ? 202 : 200,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return vehicleComplianceApiError(error);
  }
}
