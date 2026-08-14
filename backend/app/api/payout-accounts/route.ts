import { z } from 'zod';
import { getCurrentUser, safeApiErrorCode } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { payoutAccountPublicSelect, verifyPayoutAccount } from '@/lib/payout-account';

const schema = z.object({
  provider: z.string().trim().min(2).max(100).transform(value => value.toLocaleUpperCase('en-US')),
  accountIdentifier: z.string().trim().min(4).max(200),
  accountHolderName: z.string().trim().min(2).max(200),
}).strict();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
  const accounts = await db.payoutAccount.findMany({ where: { userId: user.id }, select: payoutAccountPublicSelect, orderBy: { createdAt: 'desc' } });
  return Response.json({ ok: true, accounts }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT', details: parsed.error.flatten() }, { status: 400 });
    const account = await verifyPayoutAccount({ userId: user.id, ...parsed.data });
    const safeAccount = await db.payoutAccount.findUniqueOrThrow({ where: { id: account.id }, select: payoutAccountPublicSelect });
    return Response.json({ ok: true, account: safeAccount });
  } catch (error) {
    const message = safeApiErrorCode(error);
    const status = message === 'INTERNAL_ERROR' ? 500
      : message.startsWith('NOT_CONFIGURED') || message.startsWith('INVALID_CONFIG') ? 503
        : ['BANK_PROVIDER_FAILED', 'BANK_PROVIDER_UNAVAILABLE', 'BANK_PROVIDER_RESPONSE_INVALID'].includes(message) ? 502
          : ['IDENTITY_NOT_VERIFIED', 'PHONE_NOT_VERIFIED', 'PAYOUT_ACCOUNT_NOT_VERIFIED', 'PAYOUT_PROVIDER_REFERENCE_REPLAY'].includes(message) ? 409
            : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
