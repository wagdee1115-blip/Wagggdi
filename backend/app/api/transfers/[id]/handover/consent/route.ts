import { z } from 'zod';
import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { recordHandoverPartyConsent } from '@/lib/transfer-workflow';
import { consumeRateLimit } from '@/lib/rate-limit';

const schema = z.object({ otpId: z.string().min(1).max(100), otp: z.string().regex(/^\d{4}$/) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeRateLimit(`handover-consent:${user.id}`, 10, 60_000);
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const consent = await recordHandoverPartyConsent({ saleId: (await params).id, actorId: user.id, ...parsed.data });
    return Response.json({ ok: true, consent });
  } catch (error) {
    const message = safeApiErrorCode(error);
    return Response.json({ ok: false, error: message }, { status: message === 'INTERNAL_ERROR' ? 500 : message === 'FORBIDDEN' ? 403 : message === 'RATE_LIMITED' ? 429 : message.endsWith('_NOT_FOUND') ? 404 : 400 });
  }
}
