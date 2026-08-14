import { GET as processPhoneChanges } from '../account/phone-change/activate/route';
import { GET as finalizeAuctions } from '../auctions/finalize/route';
import { GET as expireAuthorizations } from '../authorizations/expire/route';
import { GET as expireSales } from '../sales/expire/route';

const tasks = [
  ['auctions', finalizeAuctions],
  ['sales', expireSales],
  ['phoneChanges', processPhoneChanges],
  ['authorizations', expireAuthorizations],
] as const;

export async function GET(req: Request) {
  const authorization = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  const results = await Promise.all(tasks.map(async ([name, handler]) => {
    try {
      const response = await handler(req);
      const body = await response.json().catch(() => ({ ok: false, error: 'INVALID_TASK_RESPONSE' }));
      return { name, ok: response.ok && body.ok !== false, status: response.status, body };
    } catch (error) {
      return { name, ok: false, status: 500, body: { error: error instanceof Error ? error.message : 'TASK_FAILED' } };
    }
  }));

  const ok = results.every(result => result.ok);
  return Response.json({ ok, results }, { status: ok ? 200 : 500, headers: { 'Cache-Control': 'no-store' } });
}
