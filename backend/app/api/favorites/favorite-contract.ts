import { z } from 'zod';
import {
  toPublicListing,
  type PublicListingRecord,
} from '@/app/api/listings/public-listing';
import { readBoundedRequestText } from '@/lib/request-body';

const identifierSchema = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const createFavoriteSchema = z.object({
  listingId: identifierSchema,
}).strict();

const favoriteListQuerySchema = z.object({
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

const favoriteCursorSchema = z.object({
  v: z.literal(1),
  id: identifierSchema,
  createdAt: z.string().datetime(),
}).strict();

export function parseFavoriteListingId(value: string) {
  return identifierSchema.safeParse(value);
}

export function parseFavoriteListQuery(url: string) {
  const searchParams = new URL(url).searchParams;
  return favoriteListQuerySchema.safeParse({
    cursor: searchParams.get('cursor') || undefined,
    limit: searchParams.get('limit') || undefined,
  });
}

export function encodeFavoriteCursor(value: { id: string; createdAt: Date }) {
  return Buffer.from(JSON.stringify({
    v: 1,
    id: value.id,
    createdAt: value.createdAt.toISOString(),
  }), 'utf8').toString('base64url');
}

export function decodeFavoriteCursor(value: string) {
  try {
    const parsed = favoriteCursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (!parsed.success) return null;
    return {
      id: parsed.data.id,
      createdAt: new Date(parsed.data.createdAt),
    };
  } catch {
    return null;
  }
}

const MAX_BODY_BYTES = 8 * 1024;

export async function readFavoriteJson(request: Request): Promise<unknown> {
  const body = await readBoundedRequestText(request, MAX_BODY_BYTES);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('INVALID_JSON');
  }
}

export function toFavoriteItem(value: {
  createdAt: Date;
  listing: PublicListingRecord;
}) {
  return {
    favoritedAt: value.createdAt.toISOString(),
    listing: toPublicListing(value.listing),
  };
}
