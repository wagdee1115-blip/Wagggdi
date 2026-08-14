import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { uploadVehicleMedia } from '@/lib/vehicle-media';
import { requireBoundedContentLength } from '@/lib/http-bounds';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';

const MAX_MULTIPART_BYTES = 10 * 1024 * 1024 + 64 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeCompositeRateLimit({
      scope: 'vehicle-media-upload', limit: 20, windowMs: 60 * 60 * 1_000,
      userId: user.id, ip: getTrustedClientIp(req),
    });
    requireBoundedContentLength(req, MAX_MULTIPART_BYTES);
    const form = await req.formData();
    const file = form.get('file');
    const mediaType = String(form.get('mediaType') || 'ADDITIONAL');
    if (!(file instanceof File)) return Response.json({ ok: false, error: 'FILE_REQUIRED' }, { status: 400 });
    const result = await uploadVehicleMedia({ vehicleId: (await params).id, userId: user.id, file, mediaType });
    return Response.json({ ok: true, replayed: result.replayed, media: { id: result.media.id, mediaType: result.media.mediaType, mimeType: result.media.mimeType, sizeBytes: result.media.sizeBytes, plateDetectionStatus: result.media.plateDetectionStatus, publicStatus: result.media.publicStatus, createdAt: result.media.createdAt } }, { status: result.replayed ? 200 : 201 });
  } catch (e) {
    const message = safeApiErrorCode(e);
    const status = message === 'RATE_LIMITED' ? 429
      : message === 'CONTENT_LENGTH_REQUIRED' ? 411
        : message === 'PAYLOAD_TOO_LARGE' ? 413
          : message.startsWith('NOT_CONFIGURED') ? 503
            : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
