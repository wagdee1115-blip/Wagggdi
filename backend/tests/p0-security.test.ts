import { afterEach, describe, expect, it } from 'vitest';
import { isActiveAccount } from '../lib/api-auth';
import { getTrustedClientIp, rateLimitTarget } from '../lib/request-identity';
import { PASSWORD_RESET_PUBLIC_RESPONSE } from '../app/api/auth/forgot-password/request/route';
import { REGISTRATION_DUPLICATE_RESPONSE } from '../app/api/auth/register/route';
import { consumeRateLimit } from '../lib/rate-limit';

describe('P0 account-status boundary', () => {
  it('blocks a PENDING authenticated user', () => expect(isActiveAccount({ status: 'PENDING' })).toBe(false));
  it('blocks a SUSPENDED authenticated user', () => expect(isActiveAccount({ status: 'SUSPENDED' })).toBe(false));
  it('blocks a BANNED authenticated user', () => expect(isActiveAccount({ status: 'BANNED' })).toBe(false));
  it('blocks a suspended privileged user without role exceptions', () => expect(isActiveAccount({ status: 'SUSPENDED', role: 'OWNER' } as any)).toBe(false));
});

describe('P0 enumeration-safe public contracts', () => {
  it('uses one password-reset response without account or risk data', () => {
    expect(PASSWORD_RESET_PUBLIC_RESPONSE).toEqual({ ok: true, message: 'IF_ACCOUNT_EXISTS_RESET_INSTRUCTIONS_WILL_BE_SENT' });
    expect(PASSWORD_RESET_PUBLIC_RESPONSE).not.toHaveProperty('riskLevel');
    expect(PASSWORD_RESET_PUBLIC_RESPONSE).not.toHaveProperty('requestId');
  });

  it('uses one registration collision response for every unique identifier', () => {
    expect(REGISTRATION_DUPLICATE_RESPONSE).toEqual({ ok: false, error: 'REGISTRATION_UNAVAILABLE' });
  });
});

describe('P0 trusted request identity', () => {
  const original = process.env.VERCEL;
  afterEach(() => { if (original === undefined) delete process.env.VERCEL; else process.env.VERCEL = original; });

  it('ignores spoofed forwarding and device headers outside the trusted proxy', () => {
    delete process.env.VERCEL;
    const request = new Request('https://example.test', { headers: {
      'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7', 'x-device-id': 'rotating-device',
    }});
    expect(getTrustedClientIp(request)).toBeUndefined();
  });

  it('fails safely when forwarding and device headers are omitted', () => {
    delete process.env.VERCEL;
    expect(getTrustedClientIp(new Request('https://example.test'))).toBeUndefined();
    expect(rateLimitTarget('777000001')).toBe(rateLimitTarget('777000001'));
  });

  it('accepts only the platform-supplied address in the declared Vercel environment', () => {
    process.env.VERCEL = '1';
    const request = new Request('https://example.test', { headers: {
      'x-forwarded-for': '6.6.6.6', 'x-device-id': 'spoofed', 'x-vercel-forwarded-for': '1.2.3.4',
    }});
    expect(getTrustedClientIp(request)).toBe('1.2.3.4');
  });
});

describe('P0 registration abuse control', () => {
  it('enforces the server-side target limit independently of headers', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const key = `register:test:${Date.now()}:${Math.random()}`;
    await consumeRateLimit(key, 3, 60 * 60 * 1000);
    await consumeRateLimit(key, 3, 60 * 60 * 1000);
    await consumeRateLimit(key, 3, 60 * 60 * 1000);
    await expect(consumeRateLimit(key, 3, 60 * 60 * 1000)).rejects.toThrow('RATE_LIMITED');
  });
});
