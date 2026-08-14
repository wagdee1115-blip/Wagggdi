import { z } from 'zod';
import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { verifySalePartyOtp } from '@/lib/transfer-workflow';
const schema = z.object({ otpId: z.string().min(1).max(100), otp: z.string().regex(/^\d{4}$/) }).strict();
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const u = await getCurrentUser(); if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const p = schema.safeParse(await req.json()); if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const sale = await verifySalePartyOtp({ saleId: (await params).id, actorId: u.id, otpId: p.data.otpId, otp: p.data.otp, party: 'BUYER' });
    return Response.json({ ok: true, sale: { id: sale.id, status: sale.status, buyerOtpVerified: sale.buyerOtpVerified, expiresAt: sale.expiresAt } });
  } catch (e) {
    const error = safeApiErrorCode(e);
    return Response.json({ ok: false, error }, { status: error === 'INTERNAL_ERROR' ? 500 : error === 'FORBIDDEN' ? 403 : error.endsWith('_NOT_FOUND') ? 404 : error === 'OTP_REPLAY' ? 409 : 400 });
  }
}
