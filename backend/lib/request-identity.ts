import { createHash } from 'crypto';

/**
 * Vercel removes the client-supplied value and supplies this header itself.
 * Outside Vercel we deliberately return no IP rather than trusting forwarding
 * headers. Callers must always provide a non-spoofable user or target key too.
 */
export function getTrustedClientIp(request: Request) {
  if (process.env.VERCEL !== '1') return undefined;
  return request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() || undefined;
}

export function rateLimitTarget(value: string) {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
