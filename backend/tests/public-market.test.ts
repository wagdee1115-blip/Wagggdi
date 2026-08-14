import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { publicListingSelect, toPublicListing, type PublicListingRecord } from '@/app/api/listings/public-listing';

describe('public market projection', () => {
  it('uses an explicit allowlist that excludes ownership and vehicle identifiers', () => {
    const projection = JSON.stringify(publicListingSelect);
    expect(projection).not.toContain('ownerId');
    expect(projection).not.toContain('creatorId');
    expect(projection).not.toContain('vin');
    expect(projection).not.toContain('plateNumber');
    expect(projection).not.toContain('aiDescription');
    expect(projection).not.toContain('description');
    expect(projection).not.toContain('originalStorageKey');
    expect(projection).not.toContain('optimizedStorageKey');
  });

  it('serializes only safe listing and vehicle fields even if the input has extra secrets', () => {
    const record = {
      id: 'listing-public-1',
      listingType: 'MARKET',
      status: 'ACTIVE',
      price: new Prisma.Decimal(12_500_000),
      currency: 'YER',
      aiDescription: 'مركبة بحالة جيدة',
      createdAt: new Date('2026-08-14T08:00:00.000Z'),
      updatedAt: new Date('2026-08-14T09:00:00.000Z'),
      creatorId: 'private-user-id',
      vehicle: {
        make: 'Toyota', model: 'Land Cruiser', year: 2022, mileage: 42_000,
        transmission: 'AUTO', fuelType: 'PETROL', color: 'أبيض', city: 'صنعاء',
        description: 'وصف داخلي', ownerId: 'private-owner-id', vin: 'PRIVATE-VIN-123', plateNumber: 'PRIVATE-PLATE',
      },
    } as unknown as PublicListingRecord;

    const result = toPublicListing(record);
    const json = JSON.stringify(result);
    expect(result.publicationStatus).toBe('PUBLISHED');
    expect(result.price).toBe('12500000');
    expect(result.vehicle).toEqual({
      make: 'Toyota', model: 'Land Cruiser', year: 2022, mileage: 42_000,
      transmission: 'AUTO', fuelType: 'PETROL', color: 'أبيض', city: 'صنعاء',
    });
    expect(json).not.toContain('private-user-id');
    expect(json).not.toContain('private-owner-id');
    expect(json).not.toContain('PRIVATE-VIN-123');
    expect(json).not.toContain('PRIVATE-PLATE');
    expect(json).not.toContain('وصف داخلي');
  });
});
