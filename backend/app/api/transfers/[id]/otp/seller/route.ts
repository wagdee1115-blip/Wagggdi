import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { verifySalePartyOtp } from '@/lib/transfer-workflow';
const schema = z.object({ otpId: z.string().min(1), otp: z.string().regex(/^\d{4}$/) });
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const u = await getCurrentUser(); if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const p = schema.safeParse(await req.json()); if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const sale = await verifySalePartyOtp({ saleId: (await params).id, actorId: u.id, otpId: p.data.otpId, otp: p.data.otp, party: 'SELLER' });
    return Response.json({ ok: true, sale });
  } catch (e) { return Response.json({ ok: false, error: e instanceof Error ? e.message : 'SELLER_OTP_FAILED' }, { status: 400 }); }
}
