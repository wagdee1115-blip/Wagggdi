import { getCurrentUser } from '@/lib/api-auth';
import { generateVehicleDescription } from '@/lib/vehicle-description';
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(); if (!user) return Response.json({ ok:false, error:'UNAUTHORIZED' }, { status:401 });
    const body = await req.json().catch(() => ({}));
    const description = await generateVehicleDescription({ vehicleId: (await params).id, userId: user.id, additionalNotes: typeof body.additionalNotes === 'string' ? body.additionalNotes : undefined });
    return Response.json({ ok:true, description });
  } catch(e) { const m=e instanceof Error?e.message:'DESCRIPTION_FAILED'; return Response.json({ok:false,error:m},{status:m.startsWith('NOT_CONFIGURED')?503:400}); }
}
