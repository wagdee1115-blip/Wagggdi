import { createHash } from 'crypto';
import { db } from './db';

const ALLOWED = new Set(['IN_APP_SEARCH','IN_APP_HOME','AUCTION','SHARED_LINK','EXTERNAL_REFERRAL','DIRECT','UNKNOWN']);
export async function recordListingView(params: { listingId: string; userId?: string; source?: string; referrer?: string; deviceId?: string; sessionId?: string }) {
  const listing = await db.vehicleListing.findUnique({ where: { id: params.listingId }, select: { vehicleId: true } });
  if (!listing) throw new Error('LISTING_NOT_FOUND');
  const safeSource = ALLOWED.has(params.source ?? '') ? params.source! : 'UNKNOWN';
  const hash = (v?: string) => v ? createHash('sha256').update(v).digest('hex') : undefined;
  return db.listingView.create({ data: { listingId: params.listingId, vehicleId: listing.vehicleId, userId: params.userId, source: safeSource, referrer: params.referrer?.slice(0, 500), deviceHash: hash(params.deviceId), sessionHash: hash(params.sessionId) } });
}
