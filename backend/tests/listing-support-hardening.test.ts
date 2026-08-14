import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    vehicle: { findUnique: vi.fn() },
    vehicleAuthorization: { findFirst: vi.fn() },
    vehicleListing: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    vehiclePriceHistory: { create: vi.fn() },
    listingView: { findFirst: vi.fn(), create: vi.fn() },
    supportTicket: { findFirst: vi.fn(), update: vi.fn() },
    supportMessage: { create: vi.fn() },
  };
  const db = {
    $transaction: vi.fn(),
    vehicleListing: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    listingView: { create: vi.fn() },
    supportTicket: { findFirst: vi.fn(), update: vi.fn() },
    supportMessage: { create: vi.fn() },
  };
  return {
    tx,
    db,
    getCurrentUser: vi.fn(),
    consumeCompositeRateLimit: vi.fn(),
    getTrustedClientIp: vi.fn(),
    rateLimitTarget: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db: mocks.db }));
vi.mock('@/lib/api-auth', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/rate-limit', () => ({ consumeCompositeRateLimit: mocks.consumeCompositeRateLimit }));
vi.mock('@/lib/request-identity', () => ({
  getTrustedClientIp: mocks.getTrustedClientIp,
  rateLimitTarget: mocks.rateLimitTarget,
}));

import { GET as listPublicListings, POST as createListing } from '@/app/api/listings/route';
import {
  DELETE as unpublishListing,
  GET as getPublicListing,
  PATCH as updateListing,
} from '@/app/api/listings/[id]/route';
import { POST as replyToSupportTicket } from '@/app/api/support/[id]/route';
import { recordListingView } from '@/lib/buyer-source';

const actor = { id: 'authorized-user-1' };
const listingId = 'listing-1';
const vehicleId = 'vehicle-1';
const context = { params: Promise.resolve({ id: listingId }) };

describe('listing and support hardening', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentUser.mockResolvedValue(actor);
    mocks.getTrustedClientIp.mockReturnValue('203.0.113.10');
    mocks.rateLimitTarget.mockImplementation((value: string) => `hashed:${value}`);
    mocks.consumeCompositeRateLimit.mockResolvedValue(undefined);
    mocks.tx.$queryRaw.mockResolvedValue([{ id: 'locked' }]);
    mocks.db.$transaction.mockImplementation(async (work: unknown) => {
      if (typeof work === 'function') return work(mocks.tx);
      return Promise.all(work as Promise<unknown>[]);
    });
  });

  it('rate limits public listing search with trusted identity and only selects VERIFIED vehicles', async () => {
    mocks.getTrustedClientIp.mockReturnValue(undefined);
    mocks.db.vehicleListing.findMany.mockResolvedValue([]);
    const response = await listPublicListings(new Request('https://markabat.test/api/listings', {
      headers: { 'x-forwarded-for': '198.51.100.77' },
    }));

    expect(response.status).toBe(200);
    expect(mocks.consumeCompositeRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'listing-public-search', userId: actor.id, ip: undefined,
    }));
    expect(mocks.db.vehicleListing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        vehicle: { is: expect.objectContaining({ governmentStatus: 'VERIFIED' }) },
      }),
    }));
  });

  it('rate limits public listing detail and requires a VERIFIED vehicle', async () => {
    mocks.db.vehicleListing.findFirst.mockResolvedValue(null);
    const response = await getPublicListing(new Request(`https://markabat.test/api/listings/${listingId}`), context);

    expect(response.status).toBe(404);
    expect(mocks.consumeCompositeRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'listing-public-detail', userId: actor.id, ip: '203.0.113.10',
    }));
    expect(mocks.db.vehicleListing.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        vehicle: { is: expect.objectContaining({ governmentStatus: 'VERIFIED' }) },
      }),
    }));
  });

  it('returns 429 before a public listing query when the composite limit is exhausted', async () => {
    mocks.consumeCompositeRateLimit.mockRejectedValue(new Error('RATE_LIMITED'));
    const response = await listPublicListings(new Request('https://markabat.test/api/listings'));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'RATE_LIMITED' });
    expect(mocks.db.vehicleListing.findMany).not.toHaveBeenCalled();
  });

  it('does not create a listing for a vehicle that is not government VERIFIED', async () => {
    mocks.tx.vehicle.findUnique.mockResolvedValue({
      id: vehicleId, ownerId: actor.id, status: 'ACTIVE', isReserved: false,
      hasLegalBlock: false, governmentStatus: 'PENDING',
    });
    const response = await createListing(new Request('https://markabat.test/api/listings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vehicleId, listingType: 'MARKET', price: 5_000_000 }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'VEHICLE_RESTRICTED' });
    expect(mocks.tx.vehicleListing.create).not.toHaveBeenCalled();
  });

  it('rechecks a delegated create authorization and enforces its minimum price', async () => {
    mocks.tx.vehicle.findUnique.mockResolvedValue({
      id: vehicleId, ownerId: 'owner-1', status: 'ACTIVE', isReserved: false,
      hasLegalBlock: false, governmentStatus: 'VERIFIED',
    });
    mocks.tx.vehicleAuthorization.findFirst
      .mockResolvedValueOnce({ id: 'authorization-1' })
      .mockResolvedValueOnce(null);

    const response = await createListing(new Request('https://markabat.test/api/listings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vehicleId, listingType: 'MARKET', price: 4_000_000 }),
    }));

    expect(response.status).toBe(403);
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.tx.vehicleAuthorization.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        vehicleId, ownerId: 'owner-1', authorizedUserId: actor.id,
        status: 'ACTIVE', type: { in: ['SELL_ONLY', 'SELL_AND_RECEIVE'] },
        OR: [{ minPrice: null }, { minPrice: { lte: 4_000_000 } }],
      }),
    }));
    expect(mocks.tx.vehicleListing.create).not.toHaveBeenCalled();
  });

  it('rechecks a delegated price update after locking the authorization row', async () => {
    mocks.tx.vehicleListing.findUnique.mockResolvedValue({
      id: listingId, vehicleId, creatorId: actor.id, status: 'ACTIVE', currency: 'YER',
      vehicle: { ownerId: 'owner-1' },
    });
    mocks.tx.vehicleAuthorization.findFirst
      .mockResolvedValueOnce({ id: 'authorization-1' })
      .mockResolvedValueOnce(null);

    const response = await updateListing(new Request(`https://markabat.test/api/listings/${listingId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ price: 4_000_000 }),
    }), context);

    expect(response.status).toBe(403);
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(mocks.tx.vehicleListing.update).not.toHaveBeenCalled();
    expect(mocks.tx.vehicleAuthorization.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        vehicleId, ownerId: 'owner-1', authorizedUserId: actor.id, status: 'ACTIVE',
        type: { in: ['SELL_ONLY', 'SELL_AND_RECEIVE'] },
        OR: [{ minPrice: null }, { minPrice: { lte: 4_000_000 } }],
      }),
    }));
  });

  it('does not update an owner listing after the vehicle loses VERIFIED availability', async () => {
    mocks.tx.vehicleListing.findUnique.mockResolvedValue({
      id: listingId, vehicleId, creatorId: actor.id, status: 'ACTIVE', currency: 'YER',
      vehicle: { ownerId: actor.id, status: 'ACTIVE', isReserved: false, hasLegalBlock: false, governmentStatus: 'UNKNOWN' },
    });
    const response = await updateListing(new Request(`https://markabat.test/api/listings/${listingId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ price: 4_000_000 }),
    }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'VEHICLE_NOT_AVAILABLE' });
    expect(mocks.tx.vehiclePriceHistory.create).not.toHaveBeenCalled();
  });

  it('rechecks delegated unpublish authority after locking the authorization row', async () => {
    mocks.tx.vehicleListing.findUnique.mockResolvedValue({
      id: listingId, vehicleId, creatorId: actor.id, status: 'ACTIVE', currency: 'YER',
      vehicle: { ownerId: 'owner-1' },
    });
    mocks.tx.vehicleAuthorization.findFirst
      .mockResolvedValueOnce({ id: 'authorization-1' })
      .mockResolvedValueOnce(null);

    const response = await unpublishListing(
      new Request(`https://markabat.test/api/listings/${listingId}`, { method: 'DELETE' }),
      context,
    );

    expect(response.status).toBe(403);
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(mocks.tx.vehicleListing.update).not.toHaveBeenCalled();
  });

  it('deduplicates a listing view for the same privacy-preserving viewer window', async () => {
    mocks.tx.vehicleListing.findUnique.mockResolvedValue({ vehicleId });
    mocks.tx.listingView.findFirst.mockResolvedValue({ id: 'view-existing' });

    const result = await recordListingView({
      listingId,
      source: 'UNTRUSTED_SOURCE',
      ip: '203.0.113.10',
    });

    expect(result).toEqual({ id: 'view-existing', deduplicated: true });
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.tx.listingView.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ listingId, userId: null }),
    }));
    expect(mocks.tx.listingView.create).not.toHaveBeenCalled();
  });

  it('rechecks ticket ownership and closed state after taking the row lock', async () => {
    mocks.db.supportTicket.findFirst.mockResolvedValue({ id: 'ticket-1', userId: actor.id, status: 'OPEN' });
    mocks.tx.supportTicket.findFirst.mockResolvedValue({ id: 'ticket-1', userId: actor.id, status: 'CLOSED' });
    mocks.db.supportMessage.create.mockResolvedValue({ id: 'unsafe-message' });
    mocks.db.supportTicket.update.mockResolvedValue({ id: 'ticket-1' });

    const response = await replyToSupportTicket(new Request('https://markabat.test/api/support/ticket-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'متابعة حالة التذكرة' }),
    }), { params: Promise.resolve({ id: 'ticket-1' }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'TICKET_CLOSED' });
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.tx.supportMessage.create).not.toHaveBeenCalled();
  });
});
