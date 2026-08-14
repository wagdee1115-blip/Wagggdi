import type { Prisma } from '@prisma/client';

export const ownerVehicleSummarySelect = {
  id: true,
  plateNumber: true,
  vin: true,
  make: true,
  model: true,
  year: true,
  price: true,
  mileage: true,
  transmission: true,
  fuelType: true,
  color: true,
  city: true,
  description: true,
  status: true,
  isReserved: true,
  hasLegalBlock: true,
  governmentStatus: true,
  createdAt: true,
  updatedAt: true,
  listings: {
    select: { id: true, status: true, listingType: true, price: true, currency: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
} satisfies Prisma.VehicleSelect;

export const ownerVehicleDetailSelect = {
  ...ownerVehicleSummarySelect,
  media: {
    select: {
      id: true,
      mediaType: true,
      mimeType: true,
      sizeBytes: true,
      plateDetectionStatus: true,
      publicStatus: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.VehicleSelect;

