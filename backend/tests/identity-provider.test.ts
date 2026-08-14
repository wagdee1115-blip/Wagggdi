import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatDateOnly,
  getIdentityProvider,
  HttpIdentityProvider,
  isAdult,
  normalizeNationalId,
  parseDateOnly,
} from '../lib/identity-provider-http';

describe('HTTP identity provider contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('normalizes supported digits and validates real calendar dates', () => {
    expect(normalizeNationalId('١٢٣-۴۵۶')).toBe('123456');
    expect(formatDateOnly(parseDateOnly('1990-02-28'))).toBe('1990-02-28');
    expect(() => parseDateOnly('1990-02-31')).toThrow('INVALID_DATE_OF_BIRTH');
    expect(isAdult(parseDateOnly('2000-01-01'), new Date('2026-08-14T00:00:00Z'))).toBe(true);
    expect(isAdult(parseDateOnly('2010-01-01'), new Date('2026-08-14T00:00:00Z'))).toBe(false);
  });

  it('accepts VERIFIED only when the provider binds its reference to the same subject data', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({
        status: 'VERIFIED', providerReference: 'provider-ref-1', nationalId: '1234567890', dateOfBirth: '1990-01-01',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const provider = new HttpIdentityProvider(new URL('https://identity.test/verify'), 'secret', fetchImpl);
    const result = await provider.verifyIdentity({ verificationId: 'verification-1', userId: 'user-1', nationalId: '1234567890', dateOfBirth: '1990-01-01' });
    expect(result).toEqual({ status: 'VERIFIED', providerReference: 'provider-ref-1' });
    const [, init] = calls[0];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('verification-1');
  });

  it('rejects a VERIFIED response for different identity data', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      status: 'VERIFIED', providerReference: 'provider-ref-2', nationalId: '9999999999', dateOfBirth: '1990-01-01',
    }), { status: 200 });
    const provider = new HttpIdentityProvider(new URL('https://identity.test/verify'), 'secret', fetchImpl);
    await expect(provider.verifyIdentity({ verificationId: 'verification-2', userId: 'user-2', nationalId: '1234567890', dateOfBirth: '1990-01-01' }))
      .rejects.toThrow('IDENTITY_PROVIDER_SUBJECT_MISMATCH');
  });

  it('fails closed in production when credentials are absent or transport is not HTTPS', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('IDENTITY_PROVIDER_URL', '');
    vi.stubEnv('IDENTITY_PROVIDER_SECRET', '');
    expect(() => getIdentityProvider()).toThrow('NOT_CONFIGURED:IDENTITY_PROVIDER_REQUIRED');
    vi.stubEnv('IDENTITY_PROVIDER_URL', 'http://identity.test/verify');
    vi.stubEnv('IDENTITY_PROVIDER_SECRET', 'secret');
    expect(() => getIdentityProvider()).toThrow('NOT_CONFIGURED:IDENTITY_PROVIDER_HTTPS_REQUIRED');
  });
});
