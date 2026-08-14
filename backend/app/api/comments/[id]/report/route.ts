import { z } from 'zod';
import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { consumeRateLimit } from '@/lib/rate-limit';

const schema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeRateLimit(`comment-report:user:${user.id}`, 10, 60_000);
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const comment = await db.comment.findUnique({ where: { id: (await params).id }, select: { id: true } });
    if (!comment) return Response.json({ ok: false, error: 'COMMENT_NOT_FOUND' }, { status: 404 });
    const report = await db.commentReport.create({ data: { commentId: comment.id, reporterId: user.id, reason: parsed.data.reason }, select: { id: true, createdAt: true } });
    return Response.json({ ok: true, report }, { status: 201 });
  } catch (error) {
    const code = safeApiErrorCode(error);
    return Response.json({ ok: false, error: code }, { status: code === 'INTERNAL_ERROR' ? 500 : code === 'RATE_LIMITED' ? 429 : 400 });
  }
}
