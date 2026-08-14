import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type WorkerEvent = Record<string, unknown>;
type WorkerListener = (event: WorkerEvent) => void;

function loadWorker() {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners: Record<string, WorkerListener> = {};
  const put = vi.fn(async () => undefined);
  const cache = { addAll: vi.fn(async () => undefined), put };
  const open = vi.fn(async () => cache);
  const match = vi.fn(async () => undefined);
  const fetchMock = vi.fn();
  const self = {
    location: { origin: 'https://markabat.test' },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(async () => undefined),
    addEventListener(type: string, listener: WorkerListener) { listeners[type] = listener; },
  };
  runInNewContext(source, {
    self,
    caches: { open, match, keys: vi.fn(async () => []), delete: vi.fn(async () => true) },
    fetch: fetchMock,
    URL,
    Response,
    Promise,
    Set,
    Error,
  });
  return { listeners, fetchMock, open, match, put };
}

function dispatchFetch(listener: WorkerListener, request: { method: string; url: string; mode: string; destination: string }) {
  let responsePromise: Promise<unknown> | undefined;
  listener({ request, respondWith(value: Promise<unknown>) { responsePromise = value; } });
  if (!responsePromise) throw new Error('FETCH_RESPONSE_NOT_REGISTERED');
  return responsePromise;
}

describe('service worker cache policy', () => {
  it('preserves an online 404 navigation instead of replacing it with the offline page', async () => {
    const worker = loadWorker();
    const notFound = new Response('not found', { status: 404 });
    worker.fetchMock.mockResolvedValue(notFound);
    const response = await dispatchFetch(worker.listeners.fetch, {
      method: 'GET', url: 'https://markabat.test/missing', mode: 'navigate', destination: 'document',
    });
    expect(response).toBe(notFound);
    expect(worker.match).not.toHaveBeenCalled();
  });

  it('never puts Next.js scripts into the service-worker cache', async () => {
    const worker = loadWorker();
    worker.fetchMock.mockResolvedValue(new Response('script', { status: 200 }));
    await dispatchFetch(worker.listeners.fetch, {
      method: 'GET', url: 'https://markabat.test/_next/static/chunk.js', mode: 'cors', destination: 'script',
    });
    expect(worker.open).not.toHaveBeenCalled();
    expect(worker.put).not.toHaveBeenCalled();
  });

  it('does not cache an unsuccessful image response', async () => {
    const worker = loadWorker();
    const notFound = new Response('missing', { status: 404 });
    worker.fetchMock.mockResolvedValue(notFound);
    const response = await dispatchFetch(worker.listeners.fetch, {
      method: 'GET', url: 'https://markabat.test/missing.webp', mode: 'cors', destination: 'image',
    });
    expect(response).toBe(notFound);
    expect(worker.open).not.toHaveBeenCalled();
    expect(worker.put).not.toHaveBeenCalled();
  });
});
