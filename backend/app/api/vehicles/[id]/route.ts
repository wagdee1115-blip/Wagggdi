import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/api-auth';
import { vehicleSchema } from '@/lib/validations';
import { ownerVehicleDetailSelect } from '../owner-vehicle';

const updateSchema = vehicleSchema.partial().extend({
  plateNumber: z.string().trim().min(2).max(50).optional(),
  vin: z.string().trim().min(10).max(50).optional(),
  make: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(80).optional(),
  color: z.string().trim().min(1).max(60).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
}).refine(value => Object.keys(value).length > 0, { message: 'EMPTY_UPDATE' });

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const { id } = await params;
    const vehicle = await db.vehicle.findFirst({
      where: { id, ownerId: user.id },
      select: ownerVehicleDetailSelect,
    });
    if (!vehicle) return Response.json({ ok: false, error: 'VEHICLE_NOT_FOUND' }, { status: 404 });
    return Response.json({ ok: true, vehicle }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, error: 'VEHICLE_UNAVAILABLE' }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'INVALID_INPUT', details: parsed.error.flatten() }, { status: 400 });
    }
    const { id } = await params;
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.vehicle.findUnique({
        where: { id },
        select: { ownerId: true, isReserved: true, status: true, plateNumber: true, vin: true, governmentStatus: true },
      });
      if (!current) return 'NOT_FOUND' as const;
      if (current.ownerId !== user.id) return 'NOT_FOUND' as const;
      if (current.isReserved || current.status === 'SOLD') return 'LOCKED' as const;
      if (current.governmentStatus !== 'UNKNOWN' && (
        (parsed.data.plateNumber !== undefined && parsed.data.plateNumber !== current.plateNumber)
        || (parsed.data.vin !== undefined && parsed.data.vin !== current.vin)
      )) return 'VERIFIED_IDENTIFIER_LOCKED' as const;
      return tx.vehicle.update({ where: { id }, data: parsed.data, select: ownerVehicleDetailSelect });
    });
    if (result === 'NOT_FOUND') return Response.json({ ok: false, error: 'VEHICLE_NOT_FOUND' }, { status: 404 });
    if (result === 'LOCKED') return Response.json({ ok: false, error: 'VEHICLE_LOCKED' }, { status: 409 });
    if (result === 'VERIFIED_IDENTIFIER_LOCKED') return Response.json({ ok: false, error: 'VERIFIED_VEHICLE_IDENTIFIER_CHANGE_REQUIRES_SUPPORT' }, { status: 409 });
    return Response.json({ ok: true, vehicle: result });
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code === 'P2002') return Response.json({ ok: false, error: 'VEHICLE_IDENTIFIER_EXISTS' }, { status: 409 });
    return Response.json({ ok: false, error: 'VEHICLE_UPDATE_FAILED' }, { status: 500 });
  }
}
