import { getCurrentUser } from '@/lib/api-auth';
import { getLatestPhoneChange, phoneChangeError } from '@/lib/phone-change';

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const request = await getLatestPhoneChange(user.id);
    return Response.json({ ok: true, request }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const result = phoneChangeError(error);
    return Response.json({ ok: false, error: result.code }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  }
}
