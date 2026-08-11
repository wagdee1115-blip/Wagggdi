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
    return {
      name: 'S3_COMPATIBLE', configured: true,
      async putObject({ key, body, contentType }) {
        const r = await fetch(`${process.env.STORAGE_PROVIDER_URL!.replace(/\/$/, '')}/objects/${encodeURIComponent(key)}`, {
          method: 'PUT', headers: { authorization: `Bearer ${process.env.STORAGE_PROVIDER_TOKEN}`, 'content-type': contentType }, body: Buffer.from(body),
        });
        if (!r.ok) throw new Error('STORAGE_UPLOAD_FAILED');
        return { key, url: undefined };
      },
      async getSignedUrl(key, expiresInSeconds) {
        const r = await fetch(`${process.env.STORAGE_PROVIDER_URL!.replace(/\/$/, '')}/signed-url`, {
          method: 'POST', headers: { authorization: `Bearer ${process.env.STORAGE_PROVIDER_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ key, expiresInSeconds }),
        });
        if (!r.ok) throw new Error('STORAGE_SIGNED_URL_FAILED');
        const data = await r.json() as { url?: string };
        if (!data.url) throw new Error('STORAGE_SIGNED_URL_MISSING');
        return data.url;
      },
    };
  }
  return new UnconfiguredStorageProvider();
}
