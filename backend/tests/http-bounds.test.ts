import { describe, expect, it, vi } from 'vitest';
import { readBoundedResponseText, requireBoundedContentLength } from '../lib/http-bounds';

describe('bounded HTTP bodies', () => {
  it('requires a content length before multipart parsing', () => {
    expect(() => requireBoundedContentLength(new Request('https://markabat.test/upload', { method: 'POST', body: 'x' }), 10))
      .toThrow('CONTENT_LENGTH_REQUIRED');
  });

  it.each(['nope', '-1', '1.5', '0'])('rejects invalid content length %s', value => {
    const request = new Request('https://markabat.test/upload', { method: 'POST', headers: { 'content-length': value }, body: 'x' });
    expect(() => requireBoundedContentLength(request, 10)).toThrow('INVALID_CONTENT_LENGTH');
  });

  it('rejects a declared multipart body above the route limit', () => {
    const request = new Request('https://markabat.test/upload', { method: 'POST', headers: { 'content-length': '11' }, body: 'x' });
    expect(() => requireBoundedContentLength(request, 10)).toThrow('PAYLOAD_TOO_LARGE');
  });

  it('accepts a positive bounded content length', () => {
    const request = new Request('https://markabat.test/upload', { method: 'POST', headers: { 'content-length': '10' }, body: 'x' });
    expect(requireBoundedContentLength(request, 10)).toBe(10);
  });

  it('rejects oversized provider responses from Content-Length without reading their body', async () => {
    const pull = vi.fn();
    const response = new Response(new ReadableStream({ pull }), { headers: { 'content-length': '65' } });
    await expect(readBoundedResponseText(response, 64, 'TEST_PROVIDER_INVALID')).rejects.toThrow('TEST_PROVIDER_INVALID');
    expect(response.bodyUsed).toBe(false);
  });

  it('counts streamed bytes and cancels before buffering an oversized provider response', async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('1234'));
        controller.enqueue(new TextEncoder().encode('5678'));
      },
      cancel: cancelled,
    }));
    await expect(readBoundedResponseText(response, 6, 'TEST_PROVIDER_INVALID')).rejects.toThrow('TEST_PROVIDER_INVALID');
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('decodes a bounded multi-chunk provider response', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        controller.enqueue(new TextEncoder().encode('true}'));
        controller.close();
      },
    }));
    await expect(readBoundedResponseText(response, 64, 'TEST_PROVIDER_INVALID')).resolves.toBe('{"ok":true}');
  });
});
