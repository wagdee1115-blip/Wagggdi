import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    supportTicket: { findFirst: vi.fn() },
    supportAttachment: { create: vi.fn() },
  };
  return {
    tx,
    db: { supportTicket: { findFirst: vi.fn() }, $transaction: vi.fn() },
    getCurrentUser: vi.fn(),
    consumeCompositeRateLimit: vi.fn(),
    scanner: { configured: true, name: 'TEST', scan: vi.fn() },
  };
});

vi.mock('@/lib/api-auth', () => ({
  getCurrentUser: mocks.getCurrentUser,
  safeApiErrorCode: (error: unknown) => error instanceof Error ? error.message : 'INTERNAL_ERROR',
}));
vi.mock('@/lib/db', () => ({ db: mocks.db }));
vi.mock('@/lib/rate-limit', () => ({ consumeCompositeRateLimit: mocks.consumeCompositeRateLimit }));
vi.mock('@/lib/request-identity', () => ({ getTrustedClientIp: vi.fn(() => '203.0.113.9') }));
vi.mock('@/lib/malware-scanner', () => ({ getMalwareScanner: () => mocks.scanner }));

import { POST as uploadAttachment } from '../app/api/support/[id]/attachments/route';

const context = { params: Promise.resolve({ id: 'ticket-1' }) };

async function multipartRequest() {
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])], 'evidence.png', { type: 'image/png' }));
  const generated = new Request('https://markabat.test/api/support/ticket-1/attachments', { method: 'POST', body: form });
  const bytes = await generated.arrayBuffer();
  return new Request(generated.url, {
    method: 'POST',
    headers: { 'content-type': generated.headers.get('content-type')!, 'content-length': String(bytes.byteLength) },
    body: bytes,
  });
}

describe('support attachment hardening', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('SUPPORT_STORAGE_URL', 'https://storage.example.test/upload');
    vi.stubEnv('SUPPORT_STORAGE_SECRET', 'storage-secret');
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1' });
    mocks.consumeCompositeRateLimit.mockResolvedValue(undefined);
    mocks.db.supportTicket.findFirst.mockResolvedValue({ id: 'ticket-1', status: 'OPEN' });
    mocks.db.$transaction.mockImplementation(async (callback: (tx: typeof mocks.tx) => unknown) => callback(mocks.tx));
    mocks.scanner.scan.mockResolvedValue({ clean: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('requires Content-Length before parsing multipart data', async () => {
    const response = await uploadAttachment(new Request('https://markabat.test/api/support/ticket-1/attachments', { method: 'POST', body: 'multipart' }), context);
    expect(response.status).toBe(411);
    expect(mocks.scanner.scan).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared body before parsing or scanning', async () => {
    const response = await uploadAttachment(new Request('https://markabat.test/api/support/ticket-1/attachments', {
      method: 'POST', headers: { 'content-length': String(11 * 1024 * 1024) }, body: 'multipart',
    }), context);
    expect(response.status).toBe(413);
    expect(mocks.scanner.scan).not.toHaveBeenCalled();
  });

  it('rejects a ticket already closed before any file work', async () => {
    mocks.db.supportTicket.findFirst.mockResolvedValue({ id: 'ticket-1', status: 'CLOSED' });
    const response = await uploadAttachment(await multipartRequest(), context);
    expect(response.status).toBe(409);
    expect(mocks.scanner.scan).not.toHaveBeenCalled();
  });

  it('rechecks the ticket under a row lock after provider work and refuses a concurrent close', async () => {
    mocks.tx.supportTicket.findFirst.mockResolvedValue({ id: 'ticket-1', status: 'CLOSED' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const key = new Headers(init?.headers).get('x-object-key');
      return new Response(JSON.stringify({ key }), { status: 200 });
    });

    const response = await uploadAttachment(await multipartRequest(), context);

    expect(response.status).toBe(409);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.tx.supportAttachment.create).not.toHaveBeenCalled();
  });
});
