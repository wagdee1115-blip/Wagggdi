import { z } from 'zod';
import { readBoundedRequestText } from './request-body';

const identifierSchema = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
const unsafeFormattingCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

export const createConversationSchema = z.object({
  listingId: identifierSchema,
}).strict();

export const createMessageSchema = z.object({
  content: z.string()
    .trim()
    .min(1)
    .max(2_000)
    .refine(value => !unsafeFormattingCharacters.test(value), 'UNSAFE_FORMATTING_CHARACTERS'),
}).strict();

const listPaginationSchema = z.object({
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(30).default(20),
});

const messagePaginationSchema = z.object({
  cursor: identifierSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export function parseConversationListQuery(url: string) {
  const searchParams = new URL(url).searchParams;
  return listPaginationSchema.safeParse({
    cursor: searchParams.get('cursor') || undefined,
    limit: searchParams.get('limit') || undefined,
  });
}

export function parseMessageListQuery(url: string) {
  const searchParams = new URL(url).searchParams;
  return messagePaginationSchema.safeParse({
    cursor: searchParams.get('cursor') || undefined,
    limit: searchParams.get('limit') || undefined,
  });
}

export function parseConversationId(value: string) {
  return identifierSchema.safeParse(value);
}

const conversationCursorSchema = z.object({
  v: z.literal(1),
  id: identifierSchema,
  updatedAt: z.string().datetime(),
}).strict();

export function encodeConversationCursor(value: { id: string; updatedAt: Date }) {
  return Buffer.from(JSON.stringify({ v: 1, id: value.id, updatedAt: value.updatedAt.toISOString() }), 'utf8').toString('base64url');
}

export function decodeConversationCursor(value: string) {
  try {
    const parsed = conversationCursorSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (!parsed.success) return null;
    return { id: parsed.data.id, updatedAt: new Date(parsed.data.updatedAt) };
  } catch {
    return null;
  }
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readConversationJson(request: Request): Promise<unknown> {
  const body = await readBoundedRequestText(request, MAX_BODY_BYTES);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('INVALID_JSON');
  }
}

export type ConversationVehicleContext = {
  make: string;
  model: string;
  year: number;
} | null;

type InternalConversationSummary = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  participants: Array<{ user: { fullName: string } }>;
  messages: Array<{ content: string; senderId: string; createdAt: Date }>;
  _count: { messages: number };
};

type InternalMessage = {
  id: string;
  content: string;
  senderId: string;
  createdAt: Date;
};

function counterpartName(participants: InternalConversationSummary['participants']) {
  const names = participants.map(item => item.user.fullName.trim()).filter(Boolean);
  return names.length ? names.join('، ') : 'مستخدم مركبات';
}

function preview(content: string) {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
}

export function toConversationSummary(
  conversation: InternalConversationSummary,
  viewerId: string,
  vehicle: ConversationVehicleContext,
) {
  const lastMessage = conversation.messages[0];
  return {
    id: conversation.id,
    counterpartName: counterpartName(conversation.participants),
    vehicle,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    unreadCount: conversation._count.messages,
    lastMessage: lastMessage ? {
      content: preview(lastMessage.content),
      createdAt: lastMessage.createdAt.toISOString(),
      fromMe: lastMessage.senderId === viewerId,
    } : null,
  };
}

export function toConversationHeader(
  conversation: Pick<InternalConversationSummary, 'id' | 'participants'>,
  vehicle: ConversationVehicleContext,
) {
  return {
    id: conversation.id,
    counterpartName: counterpartName(conversation.participants),
    vehicle,
  };
}

export function toConversationMessage(message: InternalMessage, viewerId: string) {
  return {
    id: message.id,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    fromMe: message.senderId === viewerId,
  };
}
