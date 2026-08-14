import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';
import {
  createMessageSchema,
  parseConversationId,
  parseMessageListQuery,
  readConversationJson,
  toConversationHeader,
  toConversationMessage,
  type ConversationVehicleContext,
} from '@/lib/conversation-contract';

type RouteContext = { params: Promise<{ id: string }> };

function requestContext(request: Request) {
  const deviceId = request.headers.get('x-device-id')?.slice(0, 256);
  return {
    ip: getTrustedClientIp(request),
    deviceId: deviceId ? rateLimitTarget(deviceId) : undefined,
  };
}

async function participantConversation(conversationId: string, userId: string) {
  return db.conversation.findFirst({
    where: { id: conversationId, participants: { some: { userId } } },
    select: {
      id: true,
      vehicleId: true,
      participants: {
        where: { userId: { not: userId } },
        select: { user: { select: { fullName: true, status: true } } },
      },
    },
  });
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const { id } = await params;
    if (!parseConversationId(id).success) return Response.json({ ok: false, error: 'INVALID_CONVERSATION_ID' }, { status: 400 });
    const parsed = parseMessageListQuery(request.url);
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_PAGINATION' }, { status: 400 });
    await consumeCompositeRateLimit({
      scope: 'conversation-messages-read', limit: 180, windowMs: 60_000, userId: user.id, ...requestContext(request),
    });

    const conversation = await participantConversation(id, user.id);
    if (!conversation) return Response.json({ ok: false, error: 'CONVERSATION_NOT_FOUND' }, { status: 404 });
    const cursor = parsed.data.cursor
      ? await db.message.findFirst({
        where: { id: parsed.data.cursor, conversationId: id },
        select: { id: true, createdAt: true },
      })
      : null;
    if (parsed.data.cursor && !cursor) {
      return Response.json({ ok: false, error: 'INVALID_CURSOR' }, { status: 400 });
    }

    const rowsPromise = db.message.findMany({
      where: {
        conversationId: id,
        ...(cursor ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        } : {}),
      },
      select: { id: true, content: true, senderId: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit + 1,
    });
    const vehiclePromise: Promise<ConversationVehicleContext> = conversation.vehicleId
      ? db.vehicle.findUnique({
        where: { id: conversation.vehicleId },
        select: { make: true, model: true, year: true },
      })
      : Promise.resolve(null);
    const [rows, vehicle] = await Promise.all([rowsPromise, vehiclePromise]);
    const hasMore = rows.length > parsed.data.limit;
    const page = rows.slice(0, parsed.data.limit);
    const nextCursor = hasMore ? page.at(-1)?.id ?? null : null;

    return Response.json({
      ok: true,
      conversation: toConversationHeader(conversation, vehicle),
      messages: [...page].reverse().map(message => toConversationMessage(message, user.id)),
      nextCursor,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'RATE_LIMITED') {
      return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    }
    return Response.json({ ok: false, error: 'MESSAGES_UNAVAILABLE' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const { id } = await params;
    if (!parseConversationId(id).success) return Response.json({ ok: false, error: 'INVALID_CONVERSATION_ID' }, { status: 400 });
    await consumeCompositeRateLimit({
      scope: 'conversation-mark-read', limit: 120, windowMs: 60_000, userId: user.id, ...requestContext(request),
    });
    const conversation = await participantConversation(id, user.id);
    if (!conversation) return Response.json({ ok: false, error: 'CONVERSATION_NOT_FOUND' }, { status: 404 });
    const result = await db.message.updateMany({
      where: { conversationId: id, senderId: { not: user.id }, isRead: false },
      data: { isRead: true },
    });
    return Response.json({ ok: true, markedRead: result.count }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'RATE_LIMITED') {
      return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    }
    return Response.json({ ok: false, error: 'MARK_READ_FAILED' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const { id } = await params;
    if (!parseConversationId(id).success) return Response.json({ ok: false, error: 'INVALID_CONVERSATION_ID' }, { status: 400 });
    const parsed = createMessageSchema.safeParse(await readConversationJson(request));
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const conversation = await participantConversation(id, user.id);
    if (!conversation) return Response.json({ ok: false, error: 'CONVERSATION_NOT_FOUND' }, { status: 404 });
    if (!conversation.participants.some(item => item.user.status === 'ACTIVE')) {
      return Response.json({ ok: false, error: 'CONVERSATION_UNAVAILABLE' }, { status: 409 });
    }
    await consumeCompositeRateLimit({
      scope: 'conversation-message-send', limit: 60, windowMs: 60_000, userId: user.id, ...requestContext(request),
    });

    const message = await db.$transaction(async tx => {
      const created = await tx.message.create({
        data: { conversationId: id, senderId: user.id, content: parsed.data.content },
        select: { id: true, content: true, senderId: true, createdAt: true },
      });
      await tx.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
      return created;
    });
    return Response.json({ ok: true, message: toConversationMessage(message, user.id) }, {
      status: 201,
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
    return Response.json({ ok: false, error: 'MESSAGE_SEND_FAILED' }, { status: 500 });
  }
}
