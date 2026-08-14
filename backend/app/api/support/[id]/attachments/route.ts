import { createHash } from 'crypto';
import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { getMalwareScanner } from '@/lib/malware-scanner';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { requireProviderEndpoint } from '@/lib/provider-endpoint';
import { assertSafeStorageKey } from '@/lib/storage';
import { readBoundedResponseText, requireBoundedContentLength } from '@/lib/http-bounds';
import { getTrustedClientIp } from '@/lib/request-identity';
import { z } from 'zod';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_BYTES + 64 * 1024;
const storageResultSchema = z.object({ key: z.string().trim().min(1).max(512) }).strict();
const signatures: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46], 'application/pdf': [0x25, 0x50, 0x44, 0x46],
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const u = await getCurrentUser();
    if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeCompositeRateLimit({ scope: 'support-upload', limit: 20, windowMs: 60 * 60 * 1000, userId: u.id, ip: getTrustedClientIp(req), deviceId: req.headers.get('x-device-id') ?? undefined });
    const ticket = await db.supportTicket.findFirst({ where: { id: (await params).id, userId: u.id }, select: { id:true, status:true } });
    if (!ticket) return Response.json({ ok: false, error: 'TICKET_NOT_FOUND' }, { status: 404 });
    if (['CLOSED','RESOLVED'].includes(ticket.status)) return Response.json({ ok: false, error: 'TICKET_CLOSED' }, { status: 409 });
    const storageUrl = requireProviderEndpoint(process.env.SUPPORT_STORAGE_URL, 'STORAGE_PROVIDER');
    const storageSecret = process.env.SUPPORT_STORAGE_SECRET;
    if (!storageSecret) return Response.json({ ok: false, error: 'NOT_CONFIGURED:STORAGE_PROVIDER_REQUIRED' }, { status: 503 });
    requireBoundedContentLength(req, MAX_MULTIPART_BYTES);
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
    const expectedStorageKey = `support/${ticket.id}/${sha256Hash}`;
    const response = await fetch(storageUrl, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${storageSecret}`, 'x-file-name': safeName, 'x-sha256': sha256Hash, 'x-ticket-id': ticket.id, 'x-object-key': expectedStorageKey }, body: bytes, signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
    if (!response.ok) return Response.json({ ok: false, error: 'STORAGE_UPLOAD_FAILED' }, { status: 502 });
    const body = await readBoundedResponseText(response, 64 * 1024, 'STORAGE_RESPONSE_INVALID');
    if (!body) return Response.json({ ok: false, error: 'STORAGE_RESPONSE_INVALID' }, { status: 502 });
    let json: unknown;
    try { json = JSON.parse(body); } catch { return Response.json({ ok: false, error: 'STORAGE_RESPONSE_INVALID' }, { status: 502 }); }
    const result = storageResultSchema.safeParse(json);
    if (!result.success) return Response.json({ ok: false, error: 'STORAGE_RESPONSE_INVALID' }, { status: 502 });
    let storageKey: string;
    try { storageKey = assertSafeStorageKey(result.data.key, `support/${ticket.id}`); }
    catch { return Response.json({ ok: false, error: 'STORAGE_KEY_INVALID' }, { status: 502 }); }
    if (storageKey !== expectedStorageKey) return Response.json({ ok: false, error: 'STORAGE_KEY_MISMATCH' }, { status: 502 });
    const attachment = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "SupportTicket" WHERE id = ${ticket.id} FOR UPDATE`;
      const current = await tx.supportTicket.findFirst({ where: { id: ticket.id, userId: u.id }, select: { id: true, status: true } });
      if (!current) throw new Error('TICKET_NOT_FOUND');
      if (['CLOSED', 'RESOLVED'].includes(current.status)) throw new Error('TICKET_CLOSED');
      return tx.supportAttachment.create({
        data: { ticketId: current.id, uploadedBy: u.id, storageKey, fileName: safeName, mimeType: file.type, sizeBytes: file.size, sha256Hash },
        select: { id:true, fileName:true, mimeType:true, sizeBytes:true, createdAt:true },
      });
    });
    return Response.json({ ok: true, attachment }, { status: 201 });
  } catch (e) {
    const msg = safeApiErrorCode(e);
    if (msg === 'RATE_LIMITED') return Response.json({ ok: false, error: msg }, { status: 429 });
    if (msg === 'CONTENT_LENGTH_REQUIRED') return Response.json({ ok: false, error: msg }, { status: 411 });
    if (msg === 'INVALID_CONTENT_LENGTH') return Response.json({ ok: false, error: msg }, { status: 400 });
    if (msg === 'PAYLOAD_TOO_LARGE') return Response.json({ ok: false, error: msg }, { status: 413 });
    if (msg === 'TICKET_NOT_FOUND') return Response.json({ ok: false, error: msg }, { status: 404 });
    if (msg === 'TICKET_CLOSED') return Response.json({ ok: false, error: msg }, { status: 409 });
    if (msg === 'STORAGE_RESPONSE_INVALID') return Response.json({ ok: false, error: msg }, { status: 502 });
    if (msg.startsWith('NOT_CONFIGURED:')) return Response.json({ ok: false, error: msg }, { status: 503 });
    return Response.json({ ok: false, error: 'ATTACHMENT_FAILED' }, { status: 500 });
  }
}
