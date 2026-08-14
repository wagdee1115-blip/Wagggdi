import { requireProviderEndpoint } from './provider-endpoint';
import { z } from 'zod';
import { readBoundedResponseText } from './http-bounds';

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const signedUrlSchema = z.object({ url: z.string().trim().min(1).max(4096) }).strict();

export function assertSafeStorageKey(value: string, expectedPrefix?: string) {
  if (value !== value.trim() || value.length < 1 || value.length > 512 || value.startsWith('/') || value.includes('\\')) {
    throw new Error('STORAGE_KEY_INVALID');
  }
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error('STORAGE_KEY_INVALID');
  }
  if (expectedPrefix && !value.startsWith(`${expectedPrefix.replace(/\/$/, '')}/`)) throw new Error('STORAGE_KEY_SCOPE_INVALID');
  return value;
}

function assertSafeSignedUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('STORAGE_SIGNED_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) {
    throw new Error('STORAGE_SIGNED_URL_INVALID');
  }
  return url.toString();
}

export interface StorageProvider {
  name: string;
  configured: boolean;
  putObject(input: { key: string; body: Uint8Array; contentType: string }): Promise<{ key: string; url?: string }>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export class UnconfiguredStorageProvider implements StorageProvider {
  name = 'STORAGE_NOT_CONFIGURED';
  configured = false;
  async putObject(): Promise<{ key: string; url?: string }> { throw new Error('NOT_CONFIGURED:STORAGE_PROVIDER_REQUIRED'); }
  async getSignedUrl(): Promise<string> { throw new Error('NOT_CONFIGURED:STORAGE_PROVIDER_REQUIRED'); }
}

export function getStorageProvider(): StorageProvider {
  if (process.env.STORAGE_PROVIDER_URL && process.env.STORAGE_PROVIDER_TOKEN) {
    const endpoint = requireProviderEndpoint(process.env.STORAGE_PROVIDER_URL, 'STORAGE_PROVIDER').replace(/\/$/, '');
    return {
      name: 'S3_COMPATIBLE', configured: true,
      async putObject({ key, body, contentType }) {
        assertSafeStorageKey(key);
        const r = await fetch(`${endpoint}/objects/${encodeURIComponent(key)}`, {
          method: 'PUT', headers: { authorization: `Bearer ${process.env.STORAGE_PROVIDER_TOKEN}`, 'content-type': contentType }, body: Buffer.from(body), signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store',
        });
        if (!r.ok) throw new Error('STORAGE_UPLOAD_FAILED');
        return { key, url: undefined };
      },
      async getSignedUrl(key, expiresInSeconds) {
        assertSafeStorageKey(key);
        if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3_600) throw new Error('STORAGE_SIGNED_URL_EXPIRY_INVALID');
        const r = await fetch(`${endpoint}/signed-url`, {
          method: 'POST', headers: { authorization: `Bearer ${process.env.STORAGE_PROVIDER_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ key, expiresInSeconds }), signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store',
        });
        if (!r.ok) throw new Error('STORAGE_SIGNED_URL_FAILED');
        const body = await readBoundedResponseText(r, MAX_PROVIDER_RESPONSE_BYTES, 'STORAGE_SIGNED_URL_INVALID');
        if (!body) throw new Error('STORAGE_SIGNED_URL_INVALID');
        let json: unknown;
        try { json = JSON.parse(body); } catch { throw new Error('STORAGE_SIGNED_URL_INVALID'); }
        const parsed = signedUrlSchema.safeParse(json);
        if (!parsed.success) throw new Error('STORAGE_SIGNED_URL_INVALID');
        return assertSafeSignedUrl(parsed.data.url);
      },
    };
  }
  return new UnconfiguredStorageProvider();
}
