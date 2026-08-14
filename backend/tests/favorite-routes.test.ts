import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  consumeCompositeRateLimit: vi.fn(),
  db: {
    favorite: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    vehicleListing: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api-auth', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/rate-limit', () => ({ consumeCompositeRateLimit: mocks.consumeCompositeRateLimit }));
vi.mock('@/lib/db', () => ({ db: mocks.db }));

import { GET as listFavorites, POST as saveFavorite } from '@/app/api/favorites/route';
import {
  DELETE as removeFavorite,
  GET as favoriteStatus,
} from '@/app/api/favorites/[listingId]/route';

const user = { id: 'private-viewer-id', status: 'ACTIVE' };
const listingId = 'listing_123456';
const routeContext = { params: Promise.resolve({ listingId }) };
const publicListing = {
  id: listingId,
  listingType: 'MARKET',
  price: new Prisma.Decimal(7_250_000),
  currency: 'YER',
  createdAt: new Date('2026-08-14T08:00:00.000Z'),
  updatedAt: new Date('2026-08-14T09:00:00.000Z'),
  vehicle: {
    make: 'Hyundai', model: 'Elantra', year: 2020, mileage: 55_000,
    transmission: 'AUTO', fuelType: 'PETROL', color: 'فضي', city: 'عدن',
  },
};

describe('favorite routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue(user);
    mocks.consumeCompositeRateLimit.mockResolvedValue(undefined);
  });

  it('stops unauthenticated list requests before rate limiting or database access', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await listFavorites(new Request('https://markabat.test/api/favorites'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'UNAUTHORIZED' });
    expect(mocks.consumeCompositeRateLimit).not.toHaveBeenCalled();
    expect(mocks.db.favorite.findMany).not.toHaveBeenCalled();
  });

  it('rejects invalid pagination before querying favorites', async () => {
    const response = await listFavorites(new Request('https://markabat.test/api/favorites?limit=500'));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'INVALID_PAGINATION' });
    expect(mocks.db.favorite.findMany).not.toHaveBeenCalled();
  });

  it('returns a rate-limit response before reading protected favorites', async () => {
    mocks.consumeCompositeRateLimit.mockRejectedValue(new Error('RATE_LIMITED'));
    const response = await listFavorites(new Request('https://markabat.test/api/favorites'));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'RATE_LIMITED' });
    expect(mocks.db.favorite.findMany).not.toHaveBeenCalled();
  });

  it('returns only safe public listing data from the favorites list', async () => {
    mocks.db.favorite.findMany.mockResolvedValue([{
      id: 'favorite_123456',
      userId: 'private-viewer-id',
      vehicleId: 'private-vehicle-id',
      createdAt: new Date('2026-08-14T10:00:00.000Z'),
      vehicle: {
        ownerId: 'private-owner-id',
        vin: 'PRIVATE-VIN',
        plateNumber: 'PRIVATE-PLATE',
        listings: [{
          ...publicListing,
          creatorId: 'private-owner-id',
          aiDescription: 'unsafe free text',
          vehicle: {
            ...publicListing.vehicle,
            ownerId: 'private-owner-id',
            vin: 'PRIVATE-VIN',
            plateNumber: 'PRIVATE-PLATE',
          },
        }],
      },
    }]);

    const response = await listFavorites(new Request('https://markabat.test/api/favorites'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = await response.json();
    expect(result.favorites).toHaveLength(1);
    expect(result.favorites[0].listing).toMatchObject({
      id: listingId,
      publicationStatus: 'PUBLISHED',
      vehicle: { make: 'Hyundai', model: 'Elantra', city: 'عدن' },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private-viewer-id');
    expect(serialized).not.toContain('private-owner-id');
    expect(serialized).not.toContain('private-vehicle-id');
    expect(serialized).not.toContain('PRIVATE-VIN');
    expect(serialized).not.toContain('PRIVATE-PLATE');
    expect(serialized).not.toContain('unsafe free text');
  });

  it('rejects private identifiers and extra fields in save requests', async () => {
    const response = await saveFavorite(new Request('https://markabat.test/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId, vehicleId: 'private-vehicle-id' }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'INVALID_INPUT' });
    expect(mocks.consumeCompositeRateLimit).not.toHaveBeenCalled();
    expect(mocks.db.vehicleListing.findFirst).not.toHaveBeenCalled();
    expect(mocks.db.favorite.upsert).not.toHaveBeenCalled();
  });

  it('does not save a favorite when the listing is not publicly available', async () => {
    mocks.db.vehicleListing.findFirst.mockResolvedValue(null);
    const response = await saveFavorite(new Request('https://markabat.test/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId }),
    }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'LISTING_NOT_AVAILABLE' });
    expect(mocks.db.favorite.upsert).not.toHaveBeenCalled();
  });

  it('saves repeatedly with an idempotent upsert and never returns the vehicle identifier', async () => {
    mocks.db.vehicleListing.findFirst.mockResolvedValue({
      vehicleId: 'private-vehicle-id',
      ...publicListing,
    });
    mocks.db.favorite.upsert.mockResolvedValue({ createdAt: new Date('2026-08-14T10:00:00.000Z') });

    const request = () => new Request('https://markabat.test/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId }),
    });
    const first = await saveFavorite(request());
    const second = await saveFavorite(request());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.db.favorite.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.db.favorite.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_vehicleId: { userId: user.id, vehicleId: 'private-vehicle-id' } },
      update: {},
    }));
    const result = await first.json();
    expect(result).toMatchObject({ ok: true, favorited: true, favorite: { listing: { id: listingId } } });
    expect(JSON.stringify(result)).not.toContain('private-vehicle-id');
    expect(JSON.stringify(result)).not.toContain('private-viewer-id');
  });

  it('returns favorite status without exposing the matched record', async () => {
    mocks.db.vehicleListing.findFirst.mockResolvedValue({ id: listingId, vehicleId: 'private-vehicle-id' });
    const response = await favoriteStatus(
      new Request(`https://markabat.test/api/favorites/${listingId}`),
      routeContext,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, favorited: true });
  });

  it('removes favorites idempotently, including an already absent listing', async () => {
    mocks.db.vehicleListing.findUnique.mockResolvedValueOnce({ vehicleId: 'private-vehicle-id' });
    mocks.db.favorite.deleteMany.mockResolvedValue({ count: 0 });
    const first = await removeFavorite(
      new Request(`https://markabat.test/api/favorites/${listingId}`, { method: 'DELETE' }),
      routeContext,
    );

    mocks.db.vehicleListing.findUnique.mockResolvedValueOnce(null);
    const second = await removeFavorite(
      new Request(`https://markabat.test/api/favorites/${listingId}`, { method: 'DELETE' }),
      routeContext,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ ok: true, favorited: false });
    await expect(second.json()).resolves.toEqual({ ok: true, favorited: false });
    expect(mocks.db.favorite.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.db.favorite.deleteMany).toHaveBeenCalledWith({
      where: { userId: user.id, vehicleId: 'private-vehicle-id' },
    });
  });
});
