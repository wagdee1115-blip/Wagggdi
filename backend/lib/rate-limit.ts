import { db } from './db';
import { randomUUID } from 'crypto';

export async function consumeRateLimit(keyBase: string, limit: number, windowMs: number) {
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const key = `${keyBase}:${windowStart.getTime()}`;
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitBucket" ("id","key","windowStart","count","updatedAt")
    VALUES (${randomUUID()},${key},${windowStart},1,NOW())
    ON CONFLICT ("key") DO UPDATE SET "count"="RateLimitBucket"."count"+1,"updatedAt"=NOW()
    RETURNING "count"
  `;
  const count = Number(rows[0]?.count ?? 0);
  if (count > limit) throw new Error('RATE_LIMITED');
  return { allowed: true, count, remaining: Math.max(0, limit - count) };
}

export async function consumeCompositeRateLimit(params: {
  scope: string; limit: number; windowMs: number; userId?: string; ip?: string; deviceId?: string;
}) {
  const keys = new Set<string>();
  if (params.userId) keys.add(`${params.scope}:user:${params.userId}`);
  if (params.ip) keys.add(`${params.scope}:ip:${params.ip}`);
  if (params.deviceId) keys.add(`${params.scope}:device:${params.deviceId}`);
  if (!keys.size) keys.add(`${params.scope}:anonymous`);
  for (const key of keys) await consumeRateLimit(key, params.limit, params.windowMs);
}
