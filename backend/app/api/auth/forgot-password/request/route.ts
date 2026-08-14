import { z } from 'zod';
import { createRecoveryToken, requestPasswordReset } from '@/lib/password-recovery';
import { getTrustedClientIp } from '@/lib/request-identity';
import { passwordResetPublicResponse } from '@/lib/auth-public-contracts';

const schema = z.object({ phone: z.string().trim().min(7).max(30) });

export async function POST(req: Request) {
  try {
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const result = await requestPasswordReset({ phone: p.data.phone, ip: getTrustedClientIp(req) });
    return Response.json(passwordResetPublicResponse(result.recoveryToken), { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const m = e instanceof Error ? e.message : 'PASSWORD_RESET_FAILED';
    if (m === 'RATE_LIMITED') return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    // Provider/configuration/account differences are never exposed publicly.
    return Response.json(passwordResetPublicResponse(createRecoveryToken()), { status: 202, headers: { 'Cache-Control': 'no-store' } });
  }
}
