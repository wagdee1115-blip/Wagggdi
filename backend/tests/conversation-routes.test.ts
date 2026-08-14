import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  consumeCompositeRateLimit: vi.fn(),
  db: {
    conversation: { findFirst: vi.fn(), findMany: vi.fn() },
    message: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    vehicle: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/api-auth', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/rate-limit', () => ({ consumeCompositeRateLimit: mocks.consumeCompositeRateLimit }));
vi.mock('@/lib/db', () => ({ db: mocks.db }));

import { GET as listConversations } from '../app/api/conversations/route';
import {
  GET as listMessages,
  POST as sendMessage,
} from '../app/api/conversations/[id]/messages/route';

const routeContext = { params: Promise.resolve({ id: 'conversation_123' }) };

describe('conversation route authorization and minimization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeCompositeRateLimit.mockResolvedValue(undefined);
  });

  it('stops unauthenticated list requests before querying conversations', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await listConversations(new Request('https://markabat.test/api/conversations'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'UNAUTHORIZED' });
    expect(mocks.db.conversation.findMany).not.toHaveBeenCalled();
  });

  it('returns an explicit 429 when the protected list rate limit is exhausted', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'private-viewer-id', status: 'ACTIVE' });
    mocks.consumeCompositeRateLimit.mockRejectedValue(new Error('RATE_LIMITED'));
    const response = await listConversations(new Request('https://markabat.test/api/conversations'));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'RATE_LIMITED' });
    expect(mocks.db.conversation.findMany).not.toHaveBeenCalled();
  });

  it('rejects unbounded pagination before querying messages', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'private-viewer-id', status: 'ACTIVE' });
    const response = await listMessages(
      new Request('https://markabat.test/api/conversations/conversation_123/messages?limit=500'),
      routeContext,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'INVALID_PAGINATION' });
    expect(mocks.db.conversation.findFirst).not.toHaveBeenCalled();
    expect(mocks.db.message.findMany).not.toHaveBeenCalled();
  });

  it('conceals conversation existence from an authenticated non-participant', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'private-viewer-id', status: 'ACTIVE' });
    mocks.db.conversation.findFirst.mockResolvedValue(null);

    const response = await listMessages(
      new Request('https://markabat.test/api/conversations/conversation_123/messages'),
      routeContext,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'CONVERSATION_NOT_FOUND' });
    expect(mocks.db.message.findMany).not.toHaveBeenCalled();
  });

  it('does not create a message when the sender is not a participant', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'private-viewer-id', status: 'ACTIVE' });
    mocks.db.conversation.findFirst.mockResolvedValue(null);

    const response = await sendMessage(new Request('https://markabat.test/api/conversations/conversation_123/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'هل المركبة متاحة؟' }),
    }), routeContext);
    expect(response.status).toBe(404);
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it('returns participant-safe messages without sender or participant identifiers', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'private-viewer-id', status: 'ACTIVE' });
    mocks.db.conversation.findFirst.mockResolvedValue({
      id: 'conversation_123',
      vehicleId: 'private-vehicle-id',
      participants: [{ user: { fullName: 'سالم', status: 'ACTIVE' } }],
    });
    mocks.db.message.findMany.mockResolvedValue([{
      id: 'message_123',
      content: 'المركبة متاحة',
      senderId: 'private-seller-id',
      createdAt: new Date('2026-08-14T10:05:00.000Z'),
    }]);
    mocks.db.vehicle.findUnique.mockResolvedValue({ make: 'Toyota', model: 'Land Cruiser', year: 2022 });

    const response = await listMessages(
      new Request('https://markabat.test/api/conversations/conversation_123/messages'),
      routeContext,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = await response.json();
    expect(result.messages).toEqual([{
      id: 'message_123', content: 'المركبة متاحة', createdAt: '2026-08-14T10:05:00.000Z', fromMe: false,
    }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private-viewer-id');
    expect(serialized).not.toContain('private-seller-id');
    expect(serialized).not.toContain('private-vehicle-id');
    expect(serialized).not.toContain('senderId');
    expect(serialized).not.toContain('userId');
  });
});
