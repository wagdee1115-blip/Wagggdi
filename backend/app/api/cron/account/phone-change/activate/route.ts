import { processDuePhoneChanges } from '@/lib/phone-change';

export async function GET(req: Request) {
  const authorization = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const result = await processDuePhoneChanges();
  return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
}
