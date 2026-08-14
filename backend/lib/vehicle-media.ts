import { createHash } from 'crypto';
import { db } from './db';
import { getStorageProvider } from './storage';
import { getMalwareScanner } from './malware-scanner';

const MAX_BYTES = 10 * 1024 * 1024;
const MEDIA_TYPES = new Set(['PRIMARY', 'FRONT', 'REAR', 'SIDE', 'INTERIOR', 'ADDITIONAL']);
const MAGIC: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
};

function matchesMagic(bytes: Uint8Array, signature: number[]) { return signature.every((b, i) => bytes[i] === b); }

export async function uploadVehicleMedia(params: { vehicleId: string; userId: string; file: File; mediaType: string }) {
  if (!MEDIA_TYPES.has(params.mediaType)) throw new Error('INVALID_MEDIA_TYPE');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(params.file.type)) throw new Error('UNSUPPORTED_MEDIA_TYPE');
  if (params.file.size <= 0 || params.file.size > MAX_BYTES) throw new Error('MEDIA_SIZE_LIMIT');
  const bytes = new Uint8Array(await params.file.arrayBuffer());
  if (!matchesMagic(bytes, MAGIC[params.file.type])) throw new Error('MEDIA_MAGIC_BYTES_INVALID');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const storage = getStorageProvider();
  if (!storage.configured) throw new Error('NOT_CONFIGURED:STORAGE_PROVIDER_REQUIRED');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${params.vehicleId} FOR UPDATE`;
    const vehicle = await tx.vehicle.findUnique({ where: { id: params.vehicleId }, select: { ownerId: true } });
    if (!vehicle || vehicle.ownerId !== params.userId) throw new Error('FORBIDDEN');
    const duplicate = await tx.vehicleMedia.findFirst({ where: { vehicleId: params.vehicleId, sha256Hash: hash } });
    if (duplicate) return { media: duplicate, replayed: true };

    const scan = await getMalwareScanner().scan(bytes, hash);
    if (!scan.clean) throw new Error('MALWARE_DETECTED');
    const key = `vehicles/${params.vehicleId}/original/${hash}`;
    await storage.putObject({ key, body: bytes, contentType: params.file.type });
    const media = await tx.vehicleMedia.create({ data: { vehicleId: params.vehicleId, uploadedBy: params.userId, mediaType: params.mediaType, originalStorageKey: key, mimeType: params.file.type, sizeBytes: params.file.size, sha256Hash: hash, plateDetectionStatus: 'NOT_CONFIGURED', publicStatus: 'PRIVATE' } });
    return { media, replayed: false };
  }, { timeout: 35_000 });
}
