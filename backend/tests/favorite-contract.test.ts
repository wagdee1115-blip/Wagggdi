import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { PublicListingRecord } from '@/app/api/listings/public-listing';
import {
  createFavoriteSchema,
  decodeFavoriteCursor,
  encodeFavoriteCursor,
  parseFavoriteListQuery,
  parseFavoriteListingId,
  readFavoriteJson,
  toFavoriteItem,
} from '@/app/api/favorites/favorite-contract';

describe('favorite API contract', () => {
  it('accepts only a bounded listing identifier and rejects client-supplied private identifiers', () => {
    expect(createFavoriteSchema.safeParse({ listingId: 'listing_123456' }).success).toBe(true);
    expect(createFavoriteSchema.safeParse({ listingId: 'short' }).success).toBe(false);
    expect(createFavoriteSchema.safeParse({ listingId: 'listing_123456', vehicleId: 'private-vehicle-id' }).success).toBe(false);
    expect(createFavoriteSchema.safeParse({ listingId: 'listing/../../../private' }).success).toBe(false);
    expect(parseFavoriteListingId('listing_123456').success).toBe(true);
  });

  it('bounds pagination and rejects malformed cursors', () => {
    const parsed = parseFavoriteListQuery('https://markabat.test/api/favorites');
    expect(parsed.success && parsed.data.limit).toBe(30);
    expect(parseFavoriteListQuery('https://markabat.test/api/favorites?limit=51').success).toBe(false);
    expect(parseFavoriteListQuery('https://markabat.test/api/favorites?cursor=bad/value').success).toBe(false);
  });

  it('round-trips opaque pagination boundaries and rejects forged values', () => {
    const boundary = { id: 'favorite_123456', createdAt: new Date('2026-08-14T10:00:00.000Z') };
    const cursor = encodeFavoriteCursor(boundary);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFavoriteCursor(cursor)).toEqual(boundary);
    expect(decodeFavoriteCursor('not-a-json-cursor')).toBeNull();
  });

  it('rejects malformed and oversized request bodies', async () => {
    await expect(readFavoriteJson(new Request('https://markabat.test', {
      method: 'POST', body: '{broken-json', headers: { 'Content-Type': 'application/json' },
    }))).rejects.toThrow('INVALID_JSON');
    await expect(readFavoriteJson(new Request('https://markabat.test', {
      method: 'POST', body: '{}', headers: { 'Content-Length': String(9 * 1024) },
    }))).rejects.toThrow('PAYLOAD_TOO_LARGE');
  });

  it('projects favorite items through the public listing allowlist', () => {
    const listing = {
      id: 'listing_123456',
      listingType: 'MARKET',
      price: new Prisma.Decimal(8_500_000),
      currency: 'YER',
      createdAt: new Date('2026-08-14T08:00:00.000Z'),
      updatedAt: new Date('2026-08-14T09:00:00.000Z'),
      creatorId: 'private-owner-id',
      vehicleId: 'private-vehicle-id',
      aiDescription: 'unsafe seller text',
      vehicle: {
        make: 'Toyota', model: 'Yaris', year: 2021, mileage: 30_000,
        transmission: 'AUTO', fuelType: 'PETROL', color: 'أبيض', city: 'صنعاء',
        ownerId: 'private-owner-id', vin: 'PRIVATE-VIN', plateNumber: 'PRIVATE-PLATE',
        description: 'unsafe vehicle text',
      },
    } as unknown as PublicListingRecord;

    const result = toFavoriteItem({
      createdAt: new Date('2026-08-14T10:00:00.000Z'),
      listing,
    });
    const serialized = JSON.stringify(result);

    expect(result.listing.id).toBe('listing_123456');
    expect(result.listing.price).toBe('8500000');
    expect(serialized).not.toContain('private-owner-id');
    expect(serialized).not.toContain('private-vehicle-id');
    expect(serialized).not.toContain('PRIVATE-VIN');
    expect(serialized).not.toContain('PRIVATE-PLATE');
    expect(serialized).not.toContain('unsafe seller text');
    expect(serialized).not.toContain('unsafe vehicle text');
  });
});
