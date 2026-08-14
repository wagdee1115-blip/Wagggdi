import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { redactPlateBeforePublic } from '@/lib/plate-redaction';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';

export async function POST(req: Request, { params }: { params: Promise<{ id: string; mediaId: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeCompositeRateLimit({
      scope: 'vehicle-media-publish', limit: 30, windowMs: 60 * 60 * 1_000,
      userId: user.id, ip: getTrustedClientIp(req),
    });
    const { id, mediaId } = await params;
    const media = await redactPlateBeforePublic(mediaId, user.id, id);
    return Response.json({
      ok: true,
      media: {
        id: media.id,
        mediaType: media.mediaType,
        publicStatus: media.publicStatus,
        plateDetectionStatus: media.plateDetectionStatus,
      },
    });
  } catch (error) {
    const code = safeApiErrorCode(error);
    const status = code === 'RATE_LIMITED' ? 429 : code.startsWith('NOT_CONFIGURED') ? 503 : 400;
    return Response.json({ ok: false, error: code }, { status });
  }
}
