import { NextRequest, NextResponse } from 'next/server';

export function proxy(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith('/api/')) return NextResponse.next();
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/payments/webhook') || req.nextUrl.pathname.startsWith('/api/cron/') || req.nextUrl.pathname.startsWith('/api/transfers/') && req.nextUrl.pathname.endsWith('/ownership-transfer')) return NextResponse.next();
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin) {
    try {
      if (new URL(origin).host !== host) return NextResponse.json({ ok:false, error:'CSRF_ORIGIN_REJECTED' }, { status:403 });
    } catch { return NextResponse.json({ ok:false, error:'CSRF_ORIGIN_INVALID' }, { status:403 }); }
  }
  return NextResponse.next();
}

export const config = { matcher: ['/api/:path*'] };
