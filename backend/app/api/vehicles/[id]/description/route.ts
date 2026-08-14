import { z } from 'zod';
import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { generateVehicleDescription } from '@/lib/vehicle-description';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';

const schema = z.object({ additionalNotes: z.string().trim().max(2_000).optional() }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeCompositeRateLimit({
      scope: 'vehicle-description-generate', limit: 20, windowMs: 60 * 60 * 1_000,
      userId: user.id, ip: getTrustedClientIp(req),
    });
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const description = await generateVehicleDescription({ vehicleId: (await params).id, userId: user.id, additionalNotes: parsed.data.additionalNotes });
    return Response.json({ ok: true, description });
  } catch (error) {
    const code = safeApiErrorCode(error);
    const status = code === 'INTERNAL_ERROR' ? 500 : code === 'FORBIDDEN' ? 403 : code === 'RATE_LIMITED' ? 429 : code.startsWith('NOT_CONFIGURED') ? 503 : code.includes('PROVIDER') ? 502 : 400;
    return Response.json({ ok: false, error: code }, { status });
  }
}
