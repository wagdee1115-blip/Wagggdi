import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { recordListingView } from '@/lib/buyer-source';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';
import type { Prisma } from '@prisma/client';
import { publicListingSelect, toPublicListing } from '../public-listing';

const SELLING_AUTHORIZATION_TYPES = ['SELL_ONLY', 'SELL_AND_RECEIVE'] as const;

function rateLimitDevice(request: Request, hasTrustedPrincipal: boolean) {
  const deviceId = request.headers.get('x-device-id')?.trim();
  return hasTrustedPrincipal && deviceId ? rateLimitTarget(deviceId.slice(0, 200)) : undefined;
}

async function activeListingAuthorization(
  tx: Prisma.TransactionClient,
  params: { vehicleId: string; ownerId: string; actorId: string; price?: number },
) {
  const now = new Date();
  const where: Prisma.VehicleAuthorizationWhereInput = {
    vehicleId: params.vehicleId,
    ownerId: params.ownerId,
    authorizedUserId: params.actorId,
    status: 'ACTIVE',
    validUntil: { gt: now },
    type: { in: [...SELLING_AUTHORIZATION_TYPES] },
    ...(params.price === undefined ? {} : {
      OR: [{ minPrice: null }, { minPrice: { lte: params.price } }],
    }),
  };
  const candidate = await tx.vehicleAuthorization.findFirst({ where, select: { id: true } });
  if (!candidate) return null;
  await tx.$queryRaw`SELECT id FROM "VehicleAuthorization" WHERE id = ${candidate.id} FOR UPDATE`;
  return tx.vehicleAuthorization.findFirst({
    where: { ...where, id: candidate.id, validUntil: { gt: new Date() } },
    select: { id: true },
  });
}

async function lockedListing(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; vehicleId: string }>>`
    SELECT id, "vehicleId" FROM "VehicleListing" WHERE id = ${id} FOR UPDATE
  `;
  if (!rows.length) return null;
  await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${rows[0].vehicleId} FOR UPDATE`;
  return tx.vehicleListing.findUnique({
    where: { id },
    include: { vehicle: { select: { ownerId: true, status: true, isReserved: true, hasLegalBlock: true, governmentStatus: true } } },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    const { id } = await params;
    const ip = getTrustedClientIp(req);
    await consumeCompositeRateLimit({
      scope: 'listing-public-detail',
      limit: 120,
      windowMs: 60_000,
      userId: user?.id,
      ip,
      deviceId: rateLimitDevice(req, Boolean(user?.id || ip)),
    });
    const listing = await db.vehicleListing.findFirst({
      where: {
        id,
        status: 'ACTIVE',
        listingType: { in: ['DIRECT', 'MARKET', 'EXHIBITION'] },
        vehicle: {
          is: {
            status: 'ACTIVE',
            isReserved: false,
            hasLegalBlock: false,
            governmentStatus: 'VERIFIED',
          },
        },
      },
      select: publicListingSelect,
    });
    if (!listing) return Response.json({ ok: false, error: 'LISTING_NOT_FOUND' }, { status: 404 });

    await recordListingView({
      listingId: listing.id,
      userId: user?.id,
      source: new URL(req.url).searchParams.get('source') || 'IN_APP_SEARCH',
      referrer: req.headers.get('referer') || undefined,
      deviceId: req.headers.get('x-device-id') || undefined,
      ip,
    });
    return Response.json(
      { ok: true, listing: toPublicListing(listing) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'RATE_LIMITED') {
      return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    }
    return Response.json({ ok: false, error: 'LISTING_UNAVAILABLE' }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const body = await req.json();
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) return Response.json({ ok: false, error: 'INVALID_PRICE' }, { status: 400 });
    const { id } = await params;
    const result = await db.$transaction(async tx => {
      const listing = await lockedListing(tx, id);
      if (!listing) return null;
      if (listing.vehicle.ownerId !== user.id) {
        if (listing.creatorId !== user.id) return 'FORBIDDEN' as const;
        const authorization = await activeListingAuthorization(tx, {
          vehicleId: listing.vehicleId,
          ownerId: listing.vehicle.ownerId,
          actorId: user.id,
          price,
        });
        if (!authorization) return 'FORBIDDEN' as const;
      }
      if (listing.status !== 'ACTIVE') return 'NOT_ACTIVE' as const;
      if (listing.vehicle.status !== 'ACTIVE' || listing.vehicle.isReserved || listing.vehicle.hasLegalBlock || listing.vehicle.governmentStatus !== 'VERIFIED') {
        return 'VEHICLE_NOT_AVAILABLE' as const;
      }
      await tx.vehiclePriceHistory.create({ data: { vehicleId: listing.vehicleId, price, currency: listing.currency, source: 'LISTING_PRICE_CHANGE' } });
      return tx.vehicleListing.update({
        where: { id: listing.id },
        data: { price },
        select: { id: true, price: true, currency: true, updatedAt: true },
      });
    });
    if (result === null) return Response.json({ ok: false, error: 'LISTING_NOT_FOUND' }, { status: 404 });
    if (result === 'FORBIDDEN') return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    if (result === 'NOT_ACTIVE') return Response.json({ ok: false, error: 'LISTING_NOT_ACTIVE' }, { status: 409 });
    if (result === 'VEHICLE_NOT_AVAILABLE') return Response.json({ ok: false, error: 'VEHICLE_NOT_AVAILABLE' }, { status: 409 });
    return Response.json({ ok: true, listing: result });
  } catch {
    return Response.json({ ok: false, error: 'LISTING_UPDATE_FAILED' }, { status: 500 });
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const { id } = await params;
    const result = await db.$transaction(async tx => {
      const listing = await lockedListing(tx, id);
      if (!listing) return 'NOT_FOUND' as const;
      if (listing.vehicle.ownerId !== user.id) {
        if (listing.creatorId !== user.id) return 'FORBIDDEN' as const;
        const authorization = await activeListingAuthorization(tx, {
          vehicleId: listing.vehicleId,
          ownerId: listing.vehicle.ownerId,
          actorId: user.id,
        });
        if (!authorization) return 'FORBIDDEN' as const;
      }
      if (listing.status === 'UNPUBLISHED') return listing;
      return tx.vehicleListing.update({ where: { id }, data: { status: 'UNPUBLISHED' } });
    });
    if (result === 'NOT_FOUND') return Response.json({ ok: false, error: 'LISTING_NOT_FOUND' }, { status: 404 });
    if (result === 'FORBIDDEN') return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    return Response.json({ ok: true, listing: { id: result.id, status: result.status } });
  } catch {
    return Response.json({ ok: false, error: 'LISTING_UNPUBLISH_FAILED' }, { status: 500 });
  }
}
