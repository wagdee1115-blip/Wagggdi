import type { Prisma } from '@prisma/client';
import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';
import { parseFavoriteListingId } from '../favorite-contract';

const availableListingWhere = {
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
} satisfies Prisma.VehicleListingWhereInput;

function requestContext(request: Request) {
  const deviceId = request.headers.get('x-device-id')?.slice(0, 256);
  return {
    ip: getTrustedClientIp(request),
    deviceId: deviceId ? rateLimitTarget(deviceId) : undefined,
  };
}

function privateNoStoreHeaders() {
  return { 'Cache-Control': 'private, no-store' };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ listingId: string }> },
) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = parseFavoriteListingId((await params).listingId);
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'INVALID_LISTING_ID' }, { status: 400 });
    }
    await consumeCompositeRateLimit({
      scope: 'favorite-status',
      limit: 120,
      windowMs: 60_000,
      userId: user.id,
      ...requestContext(request),
    });

    const listing = await db.vehicleListing.findFirst({
      where: {
        id: parsed.data,
        ...availableListingWhere,
        vehicle: {
          is: {
            ...availableListingWhere.vehicle?.is,
            favorites: { some: { userId: user.id } },
          },
        },
      },
      select: { id: true },
    });

    return Response.json(
      { ok: true, favorited: Boolean(listing) },
      { headers: privateNoStoreHeaders() },
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'RATE_LIMITED') {
      return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    }
    return Response.json({ ok: false, error: 'FAVORITE_STATUS_UNAVAILABLE' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ listingId: string }> },
) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = parseFavoriteListingId((await params).listingId);
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'INVALID_LISTING_ID' }, { status: 400 });
    }
    await consumeCompositeRateLimit({
      scope: 'favorite-write',
      limit: 60,
      windowMs: 60_000,
      userId: user.id,
      ...requestContext(request),
    });

    const listing = await db.vehicleListing.findUnique({
      where: { id: parsed.data },
      select: { vehicleId: true },
    });
    if (listing) {
      await db.favorite.deleteMany({
        where: { userId: user.id, vehicleId: listing.vehicleId },
      });
    }

    return Response.json(
      { ok: true, favorited: false },
      { headers: privateNoStoreHeaders() },
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'RATE_LIMITED') {
      return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    }
    return Response.json({ ok: false, error: 'FAVORITE_REMOVE_FAILED' }, { status: 500 });
  }
}
