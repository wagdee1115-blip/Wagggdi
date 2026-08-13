import { describe, expect, it } from 'vitest';
import { previewDatabaseHost, resolveDatabaseUrl } from '../lib/database-url';

const MAIN_URL = 'postgresql://preview_user:test-password@ep-main-example-pooler.us-west-2.aws.neon.tech/neondb?channel_binding=require&sslmode=require';

describe('database URL routing', () => {
  it('leaves production and CI database URLs unchanged', () => {
    expect(resolveDatabaseUrl(MAIN_URL, 'production')).toBe(MAIN_URL);
    expect(resolveDatabaseUrl(MAIN_URL, undefined)).toBe(MAIN_URL);
  });

  it('routes Vercel Preview to the isolated Neon branch while preserving credentials and options', () => {
    const routed = new URL(resolveDatabaseUrl(MAIN_URL, 'preview')!);
    const source = new URL(MAIN_URL);

    expect(routed.hostname).toBe(previewDatabaseHost);
    expect(routed.hostname).not.toBe(source.hostname);
    expect(routed.username).toBe(source.username);
    expect(routed.password).toBe(source.password);
    expect(routed.pathname).toBe(source.pathname);
    expect(routed.searchParams.get('sslmode')).toBe('require');
    expect(routed.searchParams.get('channel_binding')).toBe('require');
  });

  it('fails closed instead of routing a Preview deployment to an unexpected database provider', () => {
    expect(() => resolveDatabaseUrl('postgresql://user:pass@db.example.com/app', 'preview'))
      .toThrow('PREVIEW_DATABASE_ISOLATION_REQUIRES_NEON_DATABASE_URL');
  });

  it('allows Prisma to keep its normal missing-env failure behavior', () => {
    expect(resolveDatabaseUrl('', 'preview')).toBeUndefined();
  });
});
