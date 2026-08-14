import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/api-auth';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';
import { publicListingSelect, toPublicListing } from './public-listing';

const SELLING_AUTHORIZATION_TYPES = ['SELL_ONLY', 'SELL_AND_RECEIVE'] as const;

function rateLimitDevice(request: Request, hasTrustedPrincipal: boolean) {
  const deviceId = request.headers.get('x-device-id')?.trim();
  return hasTrustedPrincipal && deviceId ? rateLimitTarget(deviceId.slice(0, 200)) : undefined;
}

async function activeCreationAuthorization(
  tx: Prisma.TransactionClient,
  params: { vehicleId: string; ownerId: string; actorId: string; price: number },
) {
  const now = new Date();
  const where: Prisma.VehicleAuthorizationWhereInput = {
    vehicleId: params.vehicleId,
    ownerId: params.ownerId,
    authorizedUserId: params.actorId,
    status: 'ACTIVE',
    validUntil: { gt: now },
    type: { in: [...SELLING_AUTHORIZATION_TYPES] },
    OR: [{ minPrice: null }, { minPrice: { lte: params.price } }],
  };
  const candidate = await tx.vehicleAuthorization.findFirst({ where, select: { id: true } });
  if (!candidate) return null;
  await tx.$queryRaw`SELECT id FROM "VehicleAuthorization" WHERE id = ${candidate.id} FOR UPDATE`;
  return tx.vehicleAuthorization.findFirst({
    where: { ...where, id: candidate.id, validUntil: { gt: new Date() } },
    select: { id: true },
  });
}

const schema = z.object({
  vehicleId: z.string().min(1),
  listingType: z.enum(['DIRECT', 'MARKET', 'EXHIBITION']),
  price: z.number().positive(),
  source: z.string().max(100).optional(),
  aiDescription: z.string().max(10000).optional(),
});

const searchSchema = z.object({
  q: z.string().trim().max(80).default(''),
  make: z.string().trim().max(60).default(''),
  model: z.string().trim().max(60).default(''),
  city: z.string().trim().max(60).default(''),
  year: z.coerce.number().int().min(1980).max(2100).optional(),
});

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser();
    const ip = getTrustedClientIp(req);
    await consumeCompositeRateLimit({
      scope: 'listing-public-search',
      limit: 120,
      windowMs: 60_000,
      userId: user?.id,
      ip,
      deviceId: rateLimitDevice(req, Boolean(user?.id || ip)),
    });
    const url = new URL(req.url);
    const parsed = searchSchema.safeParse({
      q: url.searchParams.get('q') || '',
      make: url.searchParams.get('make') || '',
      model: url.searchParams.get('model') || '',
      city: url.searchParams.get('city') || '',
      year: url.searchParams.get('year') || undefined,
    });
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'INVALID_FILTERS' }, { status: 400 });
    }

    const vehicleWhere: Prisma.VehicleWhereInput = {
      status: 'ACTIVE',
      isReserved: false,
      hasLegalBlock: false,
      governmentStatus: 'VERIFIED',
      ...(parsed.data.make ? { make: { contains: parsed.data.make, mode: 'insensitive' } } : {}),
      ...(parsed.data.model ? { model: { contains: parsed.data.model, mode: 'insensitive' } } : {}),
      ...(parsed.data.city ? { city: { contains: parsed.data.city, mode: 'insensitive' } } : {}),
      ...(parsed.data.year ? { year: parsed.data.year } : {}),
      ...(parsed.data.q ? {
        OR: [
          { make: { contains: parsed.data.q, mode: 'insensitive' } },
          { model: { contains: parsed.data.q, mode: 'insensitive' } },
          { city: { contains: parsed.data.q, mode: 'insensitive' } },
        ],
      } : {}),
    };

    const listings = await db.vehicleListing.findMany({
      where: {
        status: 'ACTIVE',
        listingType: { in: ['DIRECT', 'MARKET', 'EXHIBITION'] },
        vehicle: { is: vehicleWhere },
      },
      select: publicListingSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });

    return Response.json(
      { ok: true, listings: listings.map(toPublicListing) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'RATE_LIMITED') {
      return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    }
    return Response.json({ ok: false, error: 'LISTINGS_UNAVAILABLE' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT', details: p.error.flatten() }, { status: 400 });
    const ip = getTrustedClientIp(req);
    await consumeCompositeRateLimit({
      scope: 'listing-create',
      limit: 10,
      windowMs: 60 * 60 * 1000,
      userId: user.id,
      ip,
      deviceId: rateLimitDevice(req, true),
    });

    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${p.data.vehicleId} FOR UPDATE`;
      const vehicle = await tx.vehicle.findUnique({ where: { id: p.data.vehicleId } });
      if (!vehicle) throw new Error('VEHICLE_NOT_FOUND');
      if (vehicle.hasLegalBlock || vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_RESTRICTED');
      if (vehicle.status !== 'ACTIVE' || vehicle.isReserved) throw new Error('VEHICLE_NOT_AVAILABLE');

      let authorized = vehicle.ownerId === user.id;
      if (!authorized) {
        const delegation = await activeCreationAuthorization(tx, {
          vehicleId: vehicle.id,
          ownerId: vehicle.ownerId,
          actorId: user.id,
          price: p.data.price,
        });
        authorized = Boolean(delegation);
      }
      if (!authorized) throw new Error('LISTING_AUTHORIZATION_REQUIRED');

      const existing = await tx.vehicleListing.findFirst({
        where: { vehicleId: vehicle.id, status: 'ACTIVE' },
        select: { id: true },
      });
      if (existing) throw new Error('ACTIVE_LISTING_EXISTS');
      const created = await tx.vehicleListing.create({ data: { vehicleId: vehicle.id, creatorId: user.id, listingType: p.data.listingType, price: p.data.price, aiDescription: p.data.aiDescription, source: p.data.source, status: 'ACTIVE' } });
      await tx.vehiclePriceHistory.create({ data: { vehicleId: vehicle.id, price: p.data.price, currency: 'YER', source: 'LISTING_CREATED' } });
      return { listing: created, ownershipNote: vehicle.ownerId === user.id ? 'OWNER' as const : 'AUTHORIZED_SELLER' as const };
    });
    return Response.json({ ok: true, ...result }, { status: 201 });
  } catch (e) {
    const error = e instanceof Error ? e.message : 'LISTING_FAILED';
    const statusByError: Record<string, number> = {
      RATE_LIMITED: 429,
      VEHICLE_NOT_FOUND: 404,
      LISTING_AUTHORIZATION_REQUIRED: 403,
      VEHICLE_RESTRICTED: 409,
      VEHICLE_NOT_AVAILABLE: 409,
      ACTIVE_LISTING_EXISTS: 409,
    };
    if (statusByError[error]) return Response.json({ ok: false, error }, { status: statusByError[error] });
    return Response.json({ ok: false, error: 'LISTING_FAILED' }, { status: 500 });
  }
}
