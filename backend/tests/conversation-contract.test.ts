import { describe, expect, it } from 'vitest';
import {
  createConversationSchema,
  createMessageSchema,
  decodeConversationCursor,
  encodeConversationCursor,
  parseConversationListQuery,
  parseMessageListQuery,
  readConversationJson,
  toConversationHeader,
  toConversationMessage,
  toConversationSummary,
} from '../lib/conversation-contract';

describe('conversation API contract', () => {
  it('starts conversations only from a listing reference and rejects arbitrary participant identifiers', () => {
    expect(createConversationSchema.safeParse({ listingId: 'listing_123456' }).success).toBe(true);
    expect(createConversationSchema.safeParse({ participantId: 'private-user-id' }).success).toBe(false);
    expect(createConversationSchema.safeParse({ listingId: 'listing_123456', participantId: 'private-user-id' }).success).toBe(false);
  });

  it('normalizes valid messages and rejects blank, oversized, or control-character input', () => {
    const valid = createMessageSchema.safeParse({ content: '  مرحبًا، هل المركبة متاحة؟  ' });
    expect(valid.success && valid.data.content).toBe('مرحبًا، هل المركبة متاحة؟');
    expect(createMessageSchema.safeParse({ content: '   \n  ' }).success).toBe(false);
    expect(createMessageSchema.safeParse({ content: `مرحبًا\u0000` }).success).toBe(false);
    expect(createMessageSchema.safeParse({ content: `سعر المركبة \u202E123` }).success).toBe(false);
    expect(createMessageSchema.safeParse({ content: 'س'.repeat(2_001) }).success).toBe(false);
    expect(createMessageSchema.safeParse({ content: 'صالح', extra: true }).success).toBe(false);
  });

  it('bounds list and message pagination', () => {
    const conversations = parseConversationListQuery('https://markabat.test/api/conversations');
    expect(conversations.success && conversations.data.limit).toBe(20);
    expect(parseConversationListQuery('https://markabat.test/api/conversations?limit=31').success).toBe(false);

    const messages = parseMessageListQuery('https://markabat.test/api/conversations/convo_123/messages?limit=50&cursor=message_123');
    expect(messages.success && messages.data).toEqual({ limit: 50, cursor: 'message_123' });
    expect(parseMessageListQuery('https://markabat.test/api/conversations/convo_123/messages?limit=0').success).toBe(false);
  });

  it('keeps list cursors tied to the immutable page boundary supplied to the client', () => {
    const boundary = { id: 'conversation_123', updatedAt: new Date('2026-08-14T10:05:00.000Z') };
    const cursor = encodeConversationCursor(boundary);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeConversationCursor(cursor)).toEqual(boundary);
    expect(decodeConversationCursor('not-a-valid-cursor')).toBeNull();
    expect(parseConversationListQuery(`https://markabat.test/api/conversations?cursor=${cursor}`).success).toBe(true);
  });

  it('rejects malformed and oversized JSON bodies before validation', async () => {
    await expect(readConversationJson(new Request('https://markabat.test', {
      method: 'POST', body: '{bad-json', headers: { 'Content-Type': 'application/json' },
    }))).rejects.toThrow('INVALID_JSON');
    await expect(readConversationJson(new Request('https://markabat.test', {
      method: 'POST', body: '{}', headers: { 'Content-Length': String(20 * 1024) },
    }))).rejects.toThrow('PAYLOAD_TOO_LARGE');
    await expect(readConversationJson(new Request('https://markabat.test', {
      method: 'POST', body: JSON.stringify({ content: 'س'.repeat(20_000) }),
    }))).rejects.toThrow('PAYLOAD_TOO_LARGE');
  });

  it('projects participant-safe summaries without user, sender, or vehicle identifiers', () => {
    const internal = {
      id: 'conversation_123',
      vehicleId: 'private-vehicle-id',
      createdAt: new Date('2026-08-14T10:00:00.000Z'),
      updatedAt: new Date('2026-08-14T10:05:00.000Z'),
      participants: [{ userId: 'private-seller-id', user: { id: 'private-seller-id', fullName: 'أحمد' } }],
      messages: [{ id: 'message_123', content: 'هل المركبة متاحة؟', senderId: 'private-viewer-id', createdAt: new Date('2026-08-14T10:05:00.000Z') }],
      _count: { messages: 2 },
    };
    const vehicle = { make: 'Toyota', model: 'Land Cruiser', year: 2022 };
    const summary = toConversationSummary(internal, 'private-viewer-id', vehicle);
    const header = toConversationHeader(internal, vehicle);
    const message = toConversationMessage(internal.messages[0], 'private-viewer-id');
    const serialized = JSON.stringify({ summary, header, message });

    expect(summary.counterpartName).toBe('أحمد');
    expect(summary.lastMessage?.fromMe).toBe(true);
    expect(summary.unreadCount).toBe(2);
    expect(message).toMatchObject({ id: 'message_123', fromMe: true, content: 'هل المركبة متاحة؟' });
    expect(serialized).not.toContain('private-seller-id');
    expect(serialized).not.toContain('private-viewer-id');
    expect(serialized).not.toContain('private-vehicle-id');
    expect(serialized).not.toContain('senderId');
    expect(serialized).not.toContain('userId');
  });
});
