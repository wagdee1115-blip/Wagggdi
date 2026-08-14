import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { setAutoBid } from '@/lib/auction';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';

const schema = z.object({ maxAmount: z.number().positive() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user || user.status !== 'ACTIVE') return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    if (user.phoneStatus !== 'VERIFIED') return Response.json({ ok: false, error: 'PHONE_NOT_VERIFIED' }, { status: 409 });
    await consumeCompositeRateLimit({ scope: 'auction-auto-bid', limit: 20, windowMs: 60_000, userId: user.id, ip: req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined, deviceId: req.headers.get('x-device-id') ?? undefined });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const autoBid = await setAutoBid({ auctionId: (await params).id, bidderId: user.id, maxAmount: parsed.data.maxAmount });
    return Response.json({ ok: true, autoBid });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'AUTO_BID_FAILED' }, { status: 400 });
  }
}
