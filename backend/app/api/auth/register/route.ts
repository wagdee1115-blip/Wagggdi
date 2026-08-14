import { db } from '@/lib/db';
import { hashPassword, signJwt } from '@/lib/auth';
import { registerSchema } from '@/lib/validations';
import { cookies } from 'next/headers';
import { consumeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp, rateLimitTarget } from '@/lib/request-identity';
import { REGISTRATION_DUPLICATE_RESPONSE } from '@/lib/auth-public-contracts';

export async function POST(req: Request) {
  try {
    const parsed = registerSchema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok:false, error:'INVALID_INPUT', details: parsed.error.flatten() }, { status:400 });
    const data = parsed.data;
    await consumeRateLimit('register:global', 100, 60 * 60 * 1000);
    const ip = getTrustedClientIp(req);
    if (ip) await consumeRateLimit(`register:ip:${ip}`, 10, 60 * 60 * 1000);
    await consumeRateLimit(`register:phone:${rateLimitTarget(data.phone)}`, 3, 60 * 60 * 1000);
    if (data.email) await consumeRateLimit(`register:email:${rateLimitTarget(data.email)}`, 3, 60 * 60 * 1000);
    if (data.nationalId) await consumeRateLimit(`register:national-id:${rateLimitTarget(data.nationalId)}`, 3, 60 * 60 * 1000);
    const or = [{ phone: data.phone }];
    if (data.email) or.push({ email: data.email } as any);
    if (data.nationalId) or.push({ nationalId: data.nationalId } as any);
    const existing = await db.user.findFirst({ where: { OR: or } });
    if (existing) return Response.json(REGISTRATION_DUPLICATE_RESPONSE, { status:409 });
    const user = await db.user.create({ data: { fullName:data.fullName, nationalId:data.nationalId ?? null, dateOfBirth:data.dateOfBirth ? new Date(data.dateOfBirth) : null, phone:data.phone, email:data.email ?? null, passwordHash:await hashPassword(data.password), role:'USER', status:'PENDING' } });
    const token = await signJwt({ sub:user.id, role:user.role, sessionVersion:user.sessionVersion, sessionType:'REGISTRATION' });
    (await cookies()).set('markabat_session',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:30*60});
    return Response.json({ ok:true, user:{id:user.id,fullName:user.fullName,status:user.status} }, { status:201 });
  } catch (e) {
    if (e instanceof Error && e.message === 'RATE_LIMITED') return Response.json({ ok:false, error:'RATE_LIMITED' }, { status:429 });
    // Unique-constraint races and identifier collisions use the same public response.
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'P2002') return Response.json(REGISTRATION_DUPLICATE_RESPONSE, { status:409 });
    return Response.json({ ok:false, error:'REGISTRATION_FAILED' }, { status:500 });
  }
}
