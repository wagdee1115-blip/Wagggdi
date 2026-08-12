import { z } from 'zod';
import { requestPasswordReset } from '@/lib/password-recovery';
import { getTrustedClientIp } from '@/lib/request-identity';

const schema = z.object({ phone: z.string().min(7), deviceId: z.string().max(200).optional() });
export const PASSWORD_RESET_PUBLIC_RESPONSE = { ok: true, message: 'IF_ACCOUNT_EXISTS_RESET_INSTRUCTIONS_WILL_BE_SENT' } as const;

export async function POST(req: Request) {
  try {
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    await requestPasswordReset({ phone: p.data.phone, ip: getTrustedClientIp(req) });
    return Response.json(PASSWORD_RESET_PUBLIC_RESPONSE, { status: 202 });
  } catch (e) {
    const m = e instanceof Error ? e.message : 'PASSWORD_RESET_FAILED';
    if (m === 'RATE_LIMITED') return Response.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
    // Provider/configuration/account differences are never exposed publicly.
    return Response.json(PASSWORD_RESET_PUBLIC_RESPONSE, { status: 202 });
  }
}
