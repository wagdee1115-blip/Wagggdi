import type { Prisma } from '@prisma/client';

/**
 * The only database fields that may cross the anonymous market boundary.
 * Keep this as an explicit allowlist: vehicle ownership, VIN and plate data
 * must never be added to a public listing response.
 */
export const publicListingSelect = {
  id: true,
  listingType: true,
  price: true,
  currency: true,
  createdAt: true,
  updatedAt: true,
  vehicle: {
    select: {
      make: true,
      model: true,
      year: true,
      mileage: true,
      transmission: true,
      fuelType: true,
      color: true,
      city: true,
    },
  },
} satisfies Prisma.VehicleListingSelect;

export type PublicListingRecord = Prisma.VehicleListingGetPayload<{
  select: typeof publicListingSelect;
}>;

export function toPublicListing(listing: PublicListingRecord) {
  return {
    id: listing.id,
    listingType: listing.listingType,
    publicationStatus: 'PUBLISHED' as const,
    price: listing.price.toString(),
    currency: listing.currency,
    description: `مركبة ${listing.vehicle.make} ${listing.vehicle.model} موديل ${listing.vehicle.year} في ${listing.vehicle.city}.`,
    publishedAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
    vehicle: {
      make: listing.vehicle.make,
      model: listing.vehicle.model,
      year: listing.vehicle.year,
      mileage: listing.vehicle.mileage,
      transmission: listing.vehicle.transmission,
      fuelType: listing.vehicle.fuelType,
      color: listing.vehicle.color,
      city: listing.vehicle.city,
    },
  };
}
