import { cookies } from 'next/headers';
import { db } from './db';
import { verifyJwt } from './auth';
import type { Role } from '@prisma/client';

export function isActiveAccount(user: { status: string } | null | undefined) {
  return user?.status === 'ACTIVE';
}

export function isOnboardingAccount(user: { status: string; role: string } | null | undefined) {
  return user?.status === 'PENDING' && user.role === 'USER';
}

export function isAuthenticatedSessionPayload(payload: {
  sub?: unknown;
  sessionType?: unknown;
  purpose?: unknown;
  sessionVersion?: unknown;
} | null | undefined): payload is {
  sub: unknown;
  sessionType: 'AUTHENTICATED';
  purpose?: undefined;
  sessionVersion?: unknown;
} {
  return Boolean(payload?.sub)
    && payload?.sessionType === 'AUTHENTICATED'
    && payload?.purpose === undefined;
}

/** Session lookup for the few flows that must remain available after suspension (currently logout only). */
export async function getSessionUser() {
  const token = (await cookies()).get('markabat_session')?.value;
  if (!token) return null;
  const payload = await verifyJwt(token);
  if (!isAuthenticatedSessionPayload(payload)) return null;
  const user = await db.user.findUnique({ where: { id: String(payload.sub) } });
  if (!user) return null;
  if (!Number.isInteger(payload.sessionVersion) || Number(payload.sessionVersion) !== user.sessionVersion) return null;
  return user;
}

/** Canonical authentication boundary for every protected action. */
export async function getCurrentUser() {
  const user = await getSessionUser();
  return isActiveAccount(user) ? user : null;
}

/** Restricted registration-session boundary used only by phone onboarding. */
export async function getOnboardingUser() {
  const token = (await cookies()).get('markabat_session')?.value;
  if (!token) return null;
  const payload = await verifyJwt(token);
  if (!payload?.sub || payload.sessionType !== 'REGISTRATION' || payload.purpose !== undefined || payload.role !== 'USER') return null;
  const user = await db.user.findUnique({ where: { id: String(payload.sub) } });
  if (!user || !isOnboardingAccount(user)) return null;
  if (Number(payload.sessionVersion) !== user.sessionVersion) return null;
  return user;
}

export async function getOtpUser() {
  return (await getCurrentUser()) ?? getOnboardingUser();
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user || user.status !== 'ACTIVE') throw new Error('UNAUTHORIZED');
  return user;
}

export async function requireRole(roles: Role[]) {
  const user = await requireUser();
  if (!roles.includes(user.role)) throw new Error('FORBIDDEN');
  return user;
}

export function safeApiErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]*(?::[A-Z0-9_.:/]+(?:->[A-Z0-9_]+)?)?$/.test(message)
    ? message
    : 'INTERNAL_ERROR';
}

export function apiError(error: unknown) {
  const message = safeApiErrorCode(error);
  const status = message === 'UNAUTHORIZED' ? 401
    : message === 'FORBIDDEN' ? 403
      : message === 'RATE_LIMITED' ? 429
        : message.startsWith('NOT_CONFIGURED:') ? 503
          : message.endsWith('_NOT_FOUND') ? 404
            : message === 'INTERNAL_ERROR' ? 500
              : 400;
  return Response.json({ ok: false, error: message }, { status });
}

export async function getSensitiveUser() {
  const token = (await cookies()).get('markabat_sensitive_session')?.value;
  if (!token) return null;
  const payload = await verifyJwt(token);
  if (!payload?.sub || payload.sessionType !== 'SENSITIVE' || payload.purpose !== undefined) return null;
  const user = await db.user.findUnique({ where: { id: String(payload.sub) } });
  if (!user) return null;
  if (!isActiveAccount(user)) return null;
  if (!Number.isInteger(payload.sessionVersion) || Number(payload.sessionVersion) !== user.sessionVersion) return null;
  return user;
}
