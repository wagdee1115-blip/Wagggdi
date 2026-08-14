import { createHash } from 'crypto';
import { db } from './db';

const ALLOWED = new Set(['IN_APP_SEARCH','IN_APP_HOME','AUCTION','SHARED_LINK','EXTERNAL_REFERRAL','DIRECT','UNKNOWN']);
const VIEW_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

function bounded(value: string | undefined, max: number) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function hashForListing(listingId: string, kind: string, value: string) {
  return createHash('sha256').update(`${listingId}\0${kind}\0${value}`).digest('hex');
}

function safeReferrer(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 500);
  } catch {
    return undefined;
  }
}

export async function recordListingView(params: {
  listingId: string;
  userId?: string;
  source?: string;
  referrer?: string;
  deviceId?: string;
  ip?: string;
}) {
  const safeSource = ALLOWED.has(params.source ?? '') ? params.source! : 'UNKNOWN';
  const deviceId = bounded(params.deviceId, 200);
  const trustedIp = bounded(params.ip, 100);
  // Client-supplied session/device headers are useful only as hashed analytics
  // attributes. They must not let an anonymous caller mint a new dedupe identity.
  const anonymousMaterial = trustedIp ? `ip:${trustedIp}` : 'anonymous';
  const viewerHash = params.userId
    ? hashForListing(params.listingId, 'user', params.userId)
    : hashForListing(params.listingId, 'anonymous', anonymousMaterial);
  const cutoff = new Date(Date.now() - VIEW_DEDUPE_WINDOW_MS);

  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`LISTING_VIEW:${params.listingId}:${viewerHash}`}))`;
    const listing = await tx.vehicleListing.findUnique({ where: { id: params.listingId }, select: { vehicleId: true } });
    if (!listing) throw new Error('LISTING_NOT_FOUND');
    const identity = params.userId
      ? { userId: params.userId }
      : { userId: null, sessionHash: viewerHash };
    const existing = await tx.listingView.findFirst({
      where: { listingId: params.listingId, createdAt: { gte: cutoff }, ...identity },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (existing) return { id: existing.id, deduplicated: true as const };
    const created = await tx.listingView.create({
      data: {
        listingId: params.listingId,
        vehicleId: listing.vehicleId,
        userId: params.userId,
        source: safeSource,
        referrer: safeReferrer(params.referrer),
        deviceHash: deviceId ? hashForListing(params.listingId, 'device', deviceId) : undefined,
        sessionHash: params.userId ? undefined : viewerHash,
      },
      select: { id: true },
    });
    return { id: created.id, deduplicated: false as const };
  });
}
