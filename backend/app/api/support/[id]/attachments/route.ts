import { createHash } from 'crypto';
import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { getMalwareScanner } from '@/lib/malware-scanner';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';

const MAX_BYTES = 10 * 1024 * 1024;
const signatures: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46], 'application/pdf': [0x25, 0x50, 0x44, 0x46],
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const u = await getCurrentUser();
    if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeCompositeRateLimit({ scope: 'support-upload', limit: 20, windowMs: 60 * 60 * 1000, userId: u.id, ip: req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined, deviceId: req.headers.get('x-device-id') ?? undefined });
    const ticket = await db.supportTicket.findFirst({ where: { id: (await params).id, userId: u.id } });
    if (!ticket) return Response.json({ ok: false, error: 'TICKET_NOT_FOUND' }, { status: 404 });
    const storageUrl = process.env.SUPPORT_STORAGE_URL;
    const storageSecret = process.env.SUPPORT_STORAGE_SECRET;
    if (!storageUrl || !storageSecret) return Response.json({ ok: false, error: 'NOT_CONFIGURED:STORAGE_PROVIDER_REQUIRED' }, { status: 503 });
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return Response.json({ ok: false, error: 'FILE_REQUIRED' }, { status: 400 });
    if (file.size <= 0 || file.size > MAX_BYTES) return Response.json({ ok: false, error: 'FILE_SIZE_LIMIT' }, { status: 400 });
    if (!Object.prototype.hasOwnProperty.call(signatures, file.type)) return Response.json({ ok: false, error: 'FILE_TYPE_NOT_ALLOWED' }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const signature = signatures[file.type];
    if (!signature.every((b, i) => bytes[i] === b)) return Response.json({ ok: false, error: 'FILE_MAGIC_BYTES_INVALID' }, { status: 400 });
    const sha256Hash = createHash('sha256').update(bytes).digest('hex');
    const scan = await getMalwareScanner().scan(bytes, sha256Hash);
    if (!scan.clean) return Response.json({ ok: false, error: 'MALWARE_DETECTED' }, { status: 400 });
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment';
    const response = await fetch(storageUrl, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${storageSecret}`, 'x-file-name': safeName, 'x-sha256': sha256Hash, 'x-ticket-id': ticket.id }, body: bytes });
    if (!response.ok) return Response.json({ ok: false, error: 'STORAGE_UPLOAD_FAILED' }, { status: 502 });
    const result = await response.json() as { key?: string };
    if (!result.key) return Response.json({ ok: false, error: 'STORAGE_KEY_MISSING' }, { status: 502 });
    const attachment = await db.supportAttachment.create({ data: { ticketId: ticket.id, uploadedBy: u.id, storageKey: result.key, fileName: safeName, mimeType: file.type, sizeBytes: file.size, sha256Hash } });
    return Response.json({ ok: true, attachment }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'ATTACHMENT_FAILED';
    return Response.json({ ok: false, error: msg }, { status: msg.startsWith('NOT_CONFIGURED') ? 503 : msg === 'RATE_LIMITED' ? 429 : 400 });
  }
}
