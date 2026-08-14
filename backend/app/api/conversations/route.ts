import type { Prisma } from '@prisma/client';
import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';
import {
  createConversationSchema,
  decodeConversationCursor,
  encodeConversationCursor,
  parseConversationListQuery,
  readConversationJson,
  toConversationSummary,
  type ConversationVehicleContext,
} from '@/lib/conversation-contract';

function requestContext(request: Request) {
  const deviceId = request.headers.get('x-device-id')?.slice(0, 256);
  return {
    ip: getTrustedClientIp(request),
    deviceId: deviceId ? rateLimitTarget(deviceId) : undefined,
  };
}

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });

    const parsed = parseConversationListQuery(request.url);
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_PAGINATION' }, { status: 400 });
    await consumeCompositeRateLimit({
      scope: 'conversation-list', limit: 120, windowMs: 60_000, userId: user.id, ...requestContext(request),
    });

    const cursor = parsed.data.cursor ? decodeConversationCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor && !cursor) {
      return Response.json({ ok: false, error: 'INVALID_CURSOR' }, { status: 400 });
    }

    const where: Prisma.ConversationWhereInput = {
      participants: { some: { userId: user.id } },
      ...(cursor ? {
        OR: [
          { updatedAt: { lt: cursor.updatedAt } },
          { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
        ],
      } : {}),
    };
    const rows = await db.conversation.findMany({
      where,
      select: {
        id: true,
        vehicleId: true,
        createdAt: true,
        updatedAt: true,
        participants: {
          where: { userId: { not: user.id } },
          select: { user: { select: { fullName: true } } },
        },
        messages: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { content: true, senderId: true, createdAt: true },
        },
        _count: {
          select: { messages: { where: { isRead: false, senderId: { not: user.id } } } },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit + 1,
    });

    const hasMore = rows.length > parsed.data.limit;
    const page = rows.slice(0, parsed.data.limit);
    const vehicleIds = [...new Set(page.map(item => item.vehicleId).filter((id): id is string => Boolean(id)))];
    const vehicles = vehicleIds.length ? await db.vehicle.findMany({
      where: { id: { in: vehicleIds } },
      select: { id: true, make: true, model: true, year: true },
    }) : [];
    const vehicleById = new Map<string, ConversationVehicleContext>(vehicles.map(vehicle => [
      vehicle.id,
      { make: vehicle.make, model: vehicle.model, year: vehicle.year },
    ]));

    return Response.json({
      ok: true,
      conversations: page.map(item => toConversationSummary(
        item,
        user.id,
        item.vehicleId ? vehicleById.get(item.vehicleId) ?? null : null,
      )),
      nextCursor: hasMore && page.length ? encodeConversationCursor(page[page.length - 1]) : null,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'RATE_LIMITED') {
      return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    }
    return Response.json({ ok: false, error: 'CONVERSATIONS_UNAVAILABLE' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = createConversationSchema.safeParse(await readConversationJson(request));
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    await consumeCompositeRateLimit({
      scope: 'conversation-create', limit: 10, windowMs: 60 * 60 * 1_000, userId: user.id, ...requestContext(request),
    });

    const result = await db.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "VehicleListing" WHERE id = ${parsed.data.listingId} FOR UPDATE
      `;
      if (!locked.length) return 'LISTING_NOT_FOUND' as const;
      const listing = await tx.vehicleListing.findFirst({
        where: {
          id: parsed.data.listingId,
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
        },
        select: {
          vehicleId: true,
          creatorId: true,
          creator: { select: { status: true } },
          vehicle: { select: { ownerId: true } },
        },
      });
      if (!listing) return 'LISTING_NOT_AVAILABLE' as const;
      if (listing.creatorId === user.id || listing.vehicle.ownerId === user.id) return 'OWN_LISTING' as const;
      if (listing.creator.status !== 'ACTIVE') return 'SELLER_UNAVAILABLE' as const;
      if (listing.creatorId !== listing.vehicle.ownerId) {
        const activeAuthorization = await tx.vehicleAuthorization.findFirst({
          where: {
            vehicleId: listing.vehicleId,
            ownerId: listing.vehicle.ownerId,
            authorizedUserId: listing.creatorId,
            status: 'ACTIVE',
            validUntil: { gt: new Date() },
          },
          select: { id: true },
        });
        if (!activeAuthorization) return 'LISTING_NOT_AVAILABLE' as const;
      }

      const existing = await tx.conversation.findFirst({
        where: {
          vehicleId: listing.vehicleId,
          AND: [
            { participants: { some: { userId: user.id } } },
            { participants: { some: { userId: listing.creatorId } } },
          ],
        },
        select: {
          id: true,
          createdAt: true,
          participants: { select: { userId: true }, take: 3 },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing?.participants.length === 2) {
        return { id: existing.id, createdAt: existing.createdAt, reused: true };
      }

      const created = await tx.conversation.create({
        data: {
          vehicleId: listing.vehicleId,
          participants: { create: [{ userId: user.id }, { userId: listing.creatorId }] },
        },
        select: { id: true, createdAt: true },
      });
      return { ...created, reused: false };
    });

    if (result === 'LISTING_NOT_FOUND') {
      return Response.json({ ok: false, error: result }, { status: 404 });
    }
    if (result === 'LISTING_NOT_AVAILABLE' || result === 'SELLER_UNAVAILABLE') {
      return Response.json({ ok: false, error: result }, { status: 409 });
    }
    if (result === 'OWN_LISTING') {
      return Response.json({ ok: false, error: result }, { status: 400 });
    }
    return Response.json({
      ok: true,
      conversation: { id: result.id, createdAt: result.createdAt.toISOString(), reused: result.reused },
    }, {
      status: result.reused ? 200 : 201,
      headers: { 'Cache-Control': 'private, no-store' },
    });
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
    return Response.json({ ok: false, error: 'CONVERSATION_CREATE_FAILED' }, { status: 500 });
  }
}
