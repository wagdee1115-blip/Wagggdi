import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/api-auth';
import { vehicleSchema } from '@/lib/validations';
import { ownerVehicleSummarySelect } from './owner-vehicle';

const createVehicleSchema = vehicleSchema.extend({
  plateNumber: z.string().trim().min(2).max(50),
  vin: z.string().trim().min(10).max(50),
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  color: z.string().trim().min(1).max(60),
  city: z.string().trim().min(1).max(80),
  description: z.string().trim().max(10_000).nullable().optional(),
});

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const q = new URL(req.url).searchParams.get('q')?.trim().slice(0, 80) || '';
    const vehicles = await db.vehicle.findMany({
      where: {
        ownerId: user.id,
        ...(q ? {
          OR: [
            { plateNumber: { contains: q, mode: 'insensitive' } },
            { vin: { contains: q, mode: 'insensitive' } },
            { make: { contains: q, mode: 'insensitive' } },
            { model: { contains: q, mode: 'insensitive' } },
          ],
        } : {}),
      },
      select: ownerVehicleSummarySelect,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return Response.json({ ok: true, vehicles }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, error: 'VEHICLES_UNAVAILABLE' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = createVehicleSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'INVALID_INPUT', details: parsed.error.flatten() }, { status: 400 });
    }
    const vehicle = await db.vehicle.create({
      data: { ...parsed.data, ownerId: user.id, status: 'DRAFT' },
      select: ownerVehicleSummarySelect,
    });
    return Response.json({ ok: true, vehicle }, { status: 201 });
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code === 'P2002') return Response.json({ ok: false, error: 'VEHICLE_IDENTIFIER_EXISTS' }, { status: 409 });
    return Response.json({ ok: false, error: 'VEHICLE_CREATE_FAILED' }, { status: 500 });
  }
}
