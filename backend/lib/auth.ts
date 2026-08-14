import bcrypt from 'bcryptjs';
import * as jose from 'jose';

function getSecret() {
  const value = process.env.JWT_SECRET;
  if (!value && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required in production');
  }
  return new TextEncoder().encode(value || 'local-development-secret-change-me');
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

async function signJwt(payload: Record<string, unknown>) {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(getSecret());
}

export async function signAuthenticatedJwt(payload: Record<string, unknown>) {
  return signJwt({ ...payload, purpose: undefined, sessionType: 'AUTHENTICATED' });
}

export async function signRegistrationJwt(payload: Record<string, unknown>) {
  return signJwt({ ...payload, purpose: undefined, sessionType: 'REGISTRATION' });
}

export async function verifyJwt(token: string) {
  try {
    const { payload } = await jose.jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    return payload;
  } catch {
    return null;
  }
}

export async function signSensitiveJwt(payload: Record<string, unknown>) {
  return new jose.SignJWT({ ...payload, purpose: undefined, sessionType: 'SENSITIVE' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(getSecret());
}

export async function signPasswordResetJwt(payload: Record<string, unknown>) {
  return new jose.SignJWT({ ...payload, sessionType: undefined, purpose: 'PASSWORD_RESET' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(getSecret());
}
