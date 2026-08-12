import { cookies } from 'next/headers';
import { db } from './db';
import { verifyJwt } from './auth';
import type { Role } from '@prisma/client';

export function isActiveAccount(user: { status: string } | null | undefined) {
  return user?.status === 'ACTIVE';
}

/** Session lookup for the few flows that must remain available after suspension (currently logout only). */
export async function getSessionUser() {
  const token = cookies().get('markabat_session')?.value;
  if (!token) return null;
  const payload = await verifyJwt(token);
  if (!payload?.sub) return null;
  const user = await db.user.findUnique({ where: { id: String(payload.sub) } });
  if (!user) return null;
  if (payload.sessionVersion !== undefined && Number(payload.sessionVersion) !== user.sessionVersion) return null;
  return user;
}

/** Canonical authentication boundary for every protected action. */
export async function getCurrentUser() {
  const user = await getSessionUser();
  return isActiveAccount(user) ? user : null;
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

export function apiError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Internal server error';
  const status = message === 'UNAUTHORIZED' ? 401 : message === 'FORBIDDEN' ? 403 : 400;
  return Response.json({ ok: false, error: message }, { status });
}

export async function getSensitiveUser() {
  const token = cookies().get('markabat_sensitive_session')?.value;
  if (!token) return null;
  const payload = await verifyJwt(token);
  if (!payload?.sub || payload.sessionType !== 'SENSITIVE') return null;
  const user = await db.user.findUnique({ where: { id: String(payload.sub) } });
  if (!user) return null;
  if (!isActiveAccount(user)) return null;
  if (payload.sessionVersion !== undefined && Number(payload.sessionVersion) !== user.sessionVersion) return null;
  return user;
}
