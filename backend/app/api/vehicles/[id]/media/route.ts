import { getCurrentUser } from '@/lib/api-auth';
import { uploadVehicleMedia } from '@/lib/vehicle-media';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const form = await req.formData();
    const file = form.get('file');
    const mediaType = String(form.get('mediaType') || 'ADDITIONAL');
    if (!(file instanceof File)) return Response.json({ ok: false, error: 'FILE_REQUIRED' }, { status: 400 });
    const result = await uploadVehicleMedia({ vehicleId: params.id, userId: user.id, file, mediaType });
    return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'MEDIA_UPLOAD_FAILED';
    return Response.json({ ok: false, error: message }, { status: message.startsWith('NOT_CONFIGURED') ? 503 : 400 });
  }
}
