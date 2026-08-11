import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/api-auth';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';

const schema = z.object({
  vehicleId: z.string().min(1),
  listingType: z.enum(['DIRECT', 'MARKET', 'EXHIBITION', 'AUCTION']),
  price: z.number().positive(),
  source: z.string().max(100).optional(),
  aiDescription: z.string().max(10000).optional(),
});

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT', details: p.error.flatten() }, { status: 400 });
    const ip = req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;
    await consumeCompositeRateLimit({ scope: 'listing-create', limit: 10, windowMs: 60 * 60 * 1000, userId: user.id, ip, deviceId: req.headers.get('x-device-id') ?? undefined });

    const vehicle = await db.vehicle.findUnique({ where: { id: p.data.vehicleId } });
    if (!vehicle) return Response.json({ ok: false, error: 'VEHICLE_NOT_FOUND' }, { status: 404 });
    if (vehicle.hasLegalBlock || ['BLOCKED', 'RESTRICTED'].includes(vehicle.governmentStatus)) return Response.json({ ok: false, error: 'VEHICLE_RESTRICTED' }, { status: 409 });
    if (vehicle.status !== 'ACTIVE' || vehicle.isReserved) return Response.json({ ok: false, error: 'VEHICLE_NOT_AVAILABLE' }, { status: 409 });

    let authorized = vehicle.ownerId === user.id;
    if (!authorized) {
      const delegation = await db.vehicleAuthorization.findFirst({ where: { vehicleId: vehicle.id, ownerId: vehicle.ownerId, authorizedUserId: user.id, status: 'ACTIVE', validUntil: { gt: new Date() } }, select: { id: true } });
      authorized = Boolean(delegation);
    }
    if (!authorized) return Response.json({ ok: false, error: 'LISTING_AUTHORIZATION_REQUIRED' }, { status: 403 });

    const listing = await db.$transaction(async tx => {
      const created = await tx.vehicleListing.create({ data: { vehicleId: vehicle.id, creatorId: user.id, listingType: p.data.listingType, price: p.data.price, aiDescription: p.data.aiDescription, source: p.data.source, status: 'ACTIVE' } });
      await tx.vehiclePriceHistory.create({ data: { vehicleId: vehicle.id, price: p.data.price, currency: 'YER', source: 'LISTING_CREATED' } });
      return created;
    });
    return Response.json({ ok: true, listing, ownershipNote: vehicle.ownerId === user.id ? 'OWNER' : 'AUTHORIZED_SELLER' }, { status: 201 });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'LISTING_FAILED' }, { status: 400 });
  }
}
