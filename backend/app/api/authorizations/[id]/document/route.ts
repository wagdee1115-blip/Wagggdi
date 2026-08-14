import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import {
  authorizationDocumentSelect,
  issueAuthorizationDocument,
  renderAuthorizationDocumentHtml,
} from '@/lib/authorization-document';
import { authorizationErrorResponse, getAuthorizationView } from '../../authorization-view';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try {
    const id = (await params).id;
    const authorization = await db.vehicleAuthorization.findFirst({
      where: { id, OR: [{ ownerId: user.id }, { authorizedUserId: user.id }] },
      select: authorizationDocumentSelect,
    });
    if (!authorization) return Response.json({ ok: false, error: 'AUTHORIZATION_NOT_FOUND' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const html = renderAuthorizationDocumentHtml(authorization);
    return new Response(html, { headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `inline; filename="${authorization.authorizationNumber.replace(/[^A-Za-z0-9_-]/g, '_')}.html"`,
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Authorization-SHA256': authorization.sha256Hash ?? '',
    } });
  } catch (error) {
    return authorizationErrorResponse(error, 'AUTHORIZATION_DOCUMENT_FAILED');
  }
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try {
    const id = (await params).id;
    const allowed = await db.vehicleAuthorization.findFirst({ where: { id, OR: [{ ownerId: user.id }, { authorizedUserId: user.id }] }, select: { id: true } });
    if (!allowed) return Response.json({ ok: false, error: 'AUTHORIZATION_NOT_FOUND' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const stored = await issueAuthorizationDocument(id);
    const authorization = await getAuthorizationView(id, user.id);
    if (!authorization) throw new Error('AUTHORIZATION_NOT_FOUND');
    return Response.json({ ok: true, storedDocumentAvailable: Boolean(stored.pdfUrl), authorization }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return authorizationErrorResponse(error, 'AUTHORIZATION_DOCUMENT_FAILED');
  }
}
