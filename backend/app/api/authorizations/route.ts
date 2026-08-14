import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { createAuthorization } from '@/lib/authorization';
import { db } from '@/lib/db';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';
import { authorizationErrorResponse, getAuthorizationView, listAuthorizationViews } from './authorization-view';

const schema = z.object({
  vehicleId: z.string().trim().min(1).max(100),
  authorizedPhone: z.string().trim().min(7).max(30).optional(),
  authorizedUserId: z.string().trim().min(1).max(100).optional(),
  type: z.enum(['SELL_ONLY', 'SELL_AND_RECEIVE']),
  minPrice: z.number().positive().max(10_000_000_000_000).optional(),
  validUntil: z.string().datetime(),
}).refine(value => Boolean(value.authorizedPhone) !== Boolean(value.authorizedUserId), { message: 'ONE_AUTHORIZED_PARTY_IDENTIFIER_REQUIRED' });

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try {
    return Response.json({ ok: true, authorizations: await listAuthorizationViews(user.id) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ ok: false, error: 'AUTHORIZATIONS_UNAVAILABLE' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try {
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    await consumeCompositeRateLimit({ scope: 'authorization:create', limit: 12, windowMs: 60 * 60 * 1000, userId: user.id, ip: getTrustedClientIp(req) });
    const authorizedUser = parsed.data.authorizedUserId
      ? await db.user.findUnique({ where: { id: parsed.data.authorizedUserId }, select: { id: true } })
      : await db.user.findUnique({ where: { phone: parsed.data.authorizedPhone! }, select: { id: true } });
    if (!authorizedUser) throw new Error('AUTHORIZED_NOT_ACTIVE');

    const created = await createAuthorization({
      ownerId: user.id,
      authorizedUserId: authorizedUser.id,
      vehicleId: parsed.data.vehicleId,
      type: parsed.data.type,
      minPrice: parsed.data.minPrice,
      validUntil: new Date(parsed.data.validUntil),
    });
    const authorization = await getAuthorizationView(created.id, user.id);
    if (!authorization) throw new Error('AUTHORIZATION_NOT_FOUND');
    return Response.json({ ok: true, authorization }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return authorizationErrorResponse(error, 'AUTHORIZATION_CREATE_FAILED', { hideAuthorizedEligibility: true });
  }
}
