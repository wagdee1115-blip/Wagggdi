import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as jose from 'jose';

const mocks = vi.hoisted(() => ({
  cookieValue: '' as string,
  findUser: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name === 'markabat_session' && mocks.cookieValue
      ? { value: mocks.cookieValue }
      : undefined,
  })),
}));

vi.mock('../lib/db', () => ({
  db: { user: { findUnique: mocks.findUser } },
}));

import {
  signAuthenticatedJwt,
  signPasswordResetJwt,
  signRegistrationJwt,
  signSensitiveJwt,
} from '../lib/auth';
import { getCurrentUser, getSessionUser } from '../lib/api-auth';

const TEST_SECRET = 'test-session-secret-that-is-long-enough-123456';

async function signRawJwt(payload: Record<string, unknown>) {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

describe('authenticated session boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('JWT_SECRET', TEST_SECRET);
    mocks.cookieValue = '';
    mocks.findUser.mockResolvedValue({ id: 'user-1', status: 'ACTIVE', sessionVersion: 4 });
  });

  it('accepts only an explicitly authenticated, purpose-free, current browser session', async () => {
    mocks.cookieValue = await signAuthenticatedJwt({ sub: 'user-1', role: 'USER', sessionVersion: 4 });
    await expect(getSessionUser()).resolves.toMatchObject({ id: 'user-1' });

    for (const rejectedToken of [
      await signPasswordResetJwt({ sub: 'user-1', resetRequestId: 'reset-1', sessionVersion: 4 }),
      await signRegistrationJwt({ sub: 'user-1', role: 'USER', sessionVersion: 4 }),
      await signSensitiveJwt({ sub: 'user-1', role: 'USER', sessionVersion: 4 }),
      await signRawJwt({ sub: 'user-1', role: 'USER', sessionVersion: 4 }),
      await signRawJwt({ sub: 'user-1', role: 'USER', sessionVersion: 4, sessionType: 'AUTHENTICATED', purpose: 'PASSWORD_RESET' }),
    ]) {
      mocks.cookieValue = rejectedToken;
      mocks.findUser.mockClear();
      await expect(getSessionUser()).resolves.toBeNull();
      expect(mocks.findUser).not.toHaveBeenCalled();
    }
  });

  it('rejects a typed session without an exact current session version', async () => {
    mocks.cookieValue = await signAuthenticatedJwt({ sub: 'user-1', role: 'USER' });
    await expect(getSessionUser()).resolves.toBeNull();

    mocks.cookieValue = await signAuthenticatedJwt({ sub: 'user-1', role: 'USER', sessionVersion: 3 });
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it('allows logout lookup for a suspended account without admitting it as current', async () => {
    mocks.findUser.mockResolvedValue({ id: 'user-1', status: 'SUSPENDED', sessionVersion: 4 });
    mocks.cookieValue = await signAuthenticatedJwt({ sub: 'user-1', role: 'USER', sessionVersion: 4 });
    await expect(getSessionUser()).resolves.toMatchObject({ status: 'SUSPENDED' });
    await expect(getCurrentUser()).resolves.toBeNull();
  });
});
