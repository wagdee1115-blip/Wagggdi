import { db } from '@/lib/db';
import { hashPassword, signJwt } from '@/lib/auth';
import { registerSchema } from '@/lib/validations';
import { cookies } from 'next/headers';
export async function POST(req: Request) {
  try {
    const parsed = registerSchema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok:false, error:'INVALID_INPUT', details: parsed.error.flatten() }, { status:400 });
    const data = parsed.data;
    const or = [{ phone: data.phone }];
    if (data.email) or.push({ email: data.email } as any);
    if (data.nationalId) or.push({ nationalId: data.nationalId } as any);
    const existing = await db.user.findFirst({ where: { OR: or } });
    if (existing) return Response.json({ ok:false, error:'ACCOUNT_ALREADY_EXISTS' }, { status:409 });
    const user = await db.user.create({ data: { fullName:data.fullName, nationalId:data.nationalId ?? null, dateOfBirth:data.dateOfBirth ? new Date(data.dateOfBirth) : null, phone:data.phone, email:data.email ?? null, passwordHash:await hashPassword(data.password), role:'USER', status:'PENDING' } });
    const token = await signJwt({ sub:user.id, role:user.role });
    cookies().set('markabat_session',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:30*60});
    return Response.json({ ok:true, user:{id:user.id,fullName:user.fullName,status:user.status} }, { status:201 });
  } catch { return Response.json({ ok:false, error:'REGISTRATION_FAILED' }, { status:500 }); }
}
