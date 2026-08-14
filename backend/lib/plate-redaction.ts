import { db } from './db';
import { requireProviderEndpoint } from './provider-endpoint';
import { z } from 'zod';
import { assertSafeStorageKey } from './storage';
import { readBoundedResponseText } from './http-bounds';

const resultSchema = z.object({
  optimizedStorageKey: z.string().trim().min(1).max(512),
  plateDetected: z.boolean(),
}).strict();

export async function redactPlateBeforePublic(mediaId: string, userId: string, vehicleId?: string) {
  const media = await db.vehicleMedia.findUnique({ where: { id: mediaId }, include: { vehicle: true } });
  if (!media) throw new Error('MEDIA_NOT_FOUND');
  if (vehicleId && media.vehicleId !== vehicleId) throw new Error('MEDIA_VEHICLE_MISMATCH');
  if (media.vehicle.ownerId !== userId) throw new Error('FORBIDDEN');
  if (media.vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_OWNERSHIP_NOT_VERIFIED');
  if (media.publicStatus === 'PUBLIC' && media.optimizedStorageKey) return media;
  const url = requireProviderEndpoint(process.env.PLATE_REDACTION_PROVIDER_URL, 'PLATE_REDACTION_PROVIDER');
  const secret = process.env.PLATE_REDACTION_PROVIDER_SECRET;
  if (!secret) throw new Error('NOT_CONFIGURED:PLATE_REDACTION_PROVIDER_REQUIRED');
  const outputPrefix = `vehicles/${media.vehicleId}/optimized`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ storageKey: media.originalStorageKey, outputPrefix }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('PLATE_REDACTION_FAILED');
  const body = await readBoundedResponseText(response, 64 * 1024, 'PLATE_REDACTION_RESULT_INVALID');
  if (!body) throw new Error('PLATE_REDACTION_RESULT_INVALID');
  let json: unknown;
  try { json = JSON.parse(body); } catch { throw new Error('PLATE_REDACTION_RESULT_INVALID'); }
  const parsed = resultSchema.safeParse(json);
  if (!parsed.success) throw new Error('PLATE_REDACTION_RESULT_INVALID');
  const optimizedStorageKey = assertSafeStorageKey(parsed.data.optimizedStorageKey, outputPrefix);
  return db.vehicleMedia.update({
    where: { id: media.id },
    data: { optimizedStorageKey, plateDetectionStatus: parsed.data.plateDetected ? 'BLURRED' : 'CLEAR', publicStatus: 'PUBLIC' },
  });
}
