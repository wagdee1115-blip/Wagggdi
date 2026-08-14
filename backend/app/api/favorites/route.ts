import type { Prisma } from '@prisma/client';
import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';
import { publicListingSelect, toPublicListing } from '@/app/api/listings/public-listing';
import {
  createFavoriteSchema,
  decodeFavoriteCursor,
  encodeFavoriteCursor,
  parseFavoriteListQuery,
  readFavoriteJson,
  toFavoriteItem,
} from './favorite-contract';

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

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });

    const parsed = parseFavoriteListQuery(request.url);
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'INVALID_PAGINATION' }, { status: 400 });
    }
    const cursor = parsed.data.cursor ? decodeFavoriteCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor && !cursor) {
      return Response.json({ ok: false, error: 'INVALID_CURSOR' }, { status: 400 });
    }

    await consumeCompositeRateLimit({
      scope: 'favorite-list',
      limit: 120,
      windowMs: 60_000,
      userId: user.id,
      ...requestContext(request),
    });

    const rows = await db.favorite.findMany({
      where: {
        userId: user.id,
        vehicle: {
          is: {
            status: 'ACTIVE',
            isReserved: false,
            hasLegalBlock: false,
            governmentStatus: 'VERIFIED',
            listings: {
              some: {
                status: 'ACTIVE',
                listingType: { in: ['DIRECT', 'MARKET', 'EXHIBITION'] },
              },
            },
          },
        },
        ...(cursor ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        } : {}),
      },
      select: {
        id: true,
        createdAt: true,
        vehicle: {
          select: {
            listings: {
              where: {
                status: 'ACTIVE',
                listingType: { in: ['DIRECT', 'MARKET', 'EXHIBITION'] },
              },
              select: publicListingSelect,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
            },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit + 1,
    });

    const hasMore = rows.length > parsed.data.limit;
    const page = rows.slice(0, parsed.data.limit);
    const favorites = page.flatMap(row => {
      const listing = row.vehicle.listings[0];
      return listing ? [toFavoriteItem({ createdAt: row.createdAt, listing })] : [];
    });
    const boundary = page[page.length - 1];

    return Response.json({
      ok: true,
      favorites,
      nextCursor: hasMore && boundary ? encodeFavoriteCursor(boundary) : null,
    }, { headers: privateNoStoreHeaders() });
  } catch (error) {
    if (error instanceof Error && error.message === 'RATE_LIMITED') {
      return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    }
    return Response.json({ ok: false, error: 'FAVORITES_UNAVAILABLE' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });

    const parsed = createFavoriteSchema.safeParse(await readFavoriteJson(request));
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    }
    await consumeCompositeRateLimit({
      scope: 'favorite-write',
      limit: 60,
      windowMs: 60_000,
      userId: user.id,
      ...requestContext(request),
    });

    const listing = await db.vehicleListing.findFirst({
      where: { id: parsed.data.listingId, ...availableListingWhere },
      select: { vehicleId: true, ...publicListingSelect },
    });
    if (!listing) {
      return Response.json({ ok: false, error: 'LISTING_NOT_AVAILABLE' }, { status: 404 });
    }

    const favorite = await db.favorite.upsert({
      where: { userId_vehicleId: { userId: user.id, vehicleId: listing.vehicleId } },
      create: { userId: user.id, vehicleId: listing.vehicleId },
      update: {},
      select: { createdAt: true },
    });

    return Response.json({
      ok: true,
      favorited: true,
      favorite: {
        favoritedAt: favorite.createdAt.toISOString(),
        listing: toPublicListing(listing),
      },
    }, { headers: privateNoStoreHeaders() });
  } catch (error) {
    if (error instanceof Error && error.message === 'RATE_LIMITED') {
      return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    }
    if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
      return Response.json({ ok: false, error: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
    }
    if (error instanceof Error && error.message === 'INVALID_JSON') {
      return Response.json({ ok: false, error: 'INVALID_JSON' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'INVALID_CONTENT_LENGTH') {
      return Response.json({ ok: false, error: 'INVALID_CONTENT_LENGTH' }, { status: 400 });
    }
    return Response.json({ ok: false, error: 'FAVORITE_SAVE_FAILED' }, { status: 500 });
  }
}
