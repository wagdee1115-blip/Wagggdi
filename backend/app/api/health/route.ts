import { db } from '@/lib/db';
export async function GET() {
  const started = Date.now();
  try { await db.$queryRaw`SELECT 1`; return Response.json({ ok: true, service: 'markabat-api', database: 'ok', latencyMs: Date.now()-started, timestamp: new Date().toISOString() }); }
  catch { return Response.json({ ok: false, service: 'markabat-api', database: 'error' }, { status: 503 }); }
}
