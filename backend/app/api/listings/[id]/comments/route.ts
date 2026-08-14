import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';

const schema = z.object({ content: z.string().trim().min(1).max(2000) });

const publicListingWhere = {
  status: 'ACTIVE' as const,
  listingType: { in: ['DIRECT', 'MARKET', 'EXHIBITION'] as ('DIRECT' | 'MARKET' | 'EXHIBITION')[] },
  vehicle: {
    is: {
      status: 'ACTIVE' as const,
      isReserved: false,
      hasLegalBlock: false,
      governmentStatus: 'VERIFIED' as const,
    },
  },
};

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const listing = await db.vehicleListing.findFirst({ where: { id, ...publicListingWhere }, select: { id: true } });
    if (!listing) return Response.json({ ok: false, error: 'LISTING_NOT_FOUND' }, { status: 404 });
    const comments = await db.comment.findMany({
      where: { listingId: listing.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, content: true, createdAt: true },
      take: 200,
    });
    return Response.json({
      ok: true,
      comments: comments.map(comment => ({ ...comment, authorLabel: 'مستخدم' })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, error: 'COMMENTS_UNAVAILABLE' }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeCompositeRateLimit({
      scope: 'comments', limit: 10, windowMs: 60_000, userId: user.id,
      ip: req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
      deviceId: req.headers.get('x-device-id') ?? undefined,
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const { id } = await params;
    const listing = await db.vehicleListing.findFirst({ where: { id, ...publicListingWhere }, select: { id: true } });
    if (!listing) return Response.json({ ok: false, error: 'LISTING_NOT_FOUND' }, { status: 404 });
    const comment = await db.comment.create({
      data: { listingId: listing.id, userId: user.id, content: parsed.data.content },
      select: { id: true, content: true, createdAt: true },
    });
    return Response.json({ ok: true, comment: { ...comment, authorLabel: 'مستخدم' } }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'RATE_LIMITED') return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    return Response.json({ ok: false, error: 'COMMENT_FAILED' }, { status: 500 });
  }
}
