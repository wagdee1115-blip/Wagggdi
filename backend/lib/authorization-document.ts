import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { readBoundedResponseText } from './http-bounds';
import {
  AUTHORIZATION_TERMS_VERSION,
  authorizationTermsHash,
  buildAuthorizationTerms,
  maskAuthorizationNationalId,
  maskAuthorizationPhone,
} from './authorization-policy';

export const authorizationDocumentSelect = {
  id: true,
  authorizationNumber: true,
  vehicleId: true,
  ownerId: true,
  authorizedUserId: true,
  type: true,
  status: true,
  minPrice: true,
  validUntil: true,
  termsVersion: true,
  pdfUrl: true,
  qrValue: true,
  sha256Hash: true,
  acceptedAt: true,
  authorizedOtpVerifiedAt: true,
  revokedAt: true,
  createdAt: true,
  owner: { select: { fullName: true, nationalId: true, phone: true } },
  authorizedUser: { select: { fullName: true, nationalId: true, phone: true } },
  vehicle: { select: { plateNumber: true, vin: true, make: true, model: true, year: true, color: true } },
} satisfies Prisma.VehicleAuthorizationSelect;

export type AuthorizationDocumentRecord = Prisma.VehicleAuthorizationGetPayload<{ select: typeof authorizationDocumentSelect }>;

const documentStorageResponseSchema = z.object({ url: z.string().trim().min(1).max(4096) }).strict();

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

function simpleHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function verifyAuthorizationIntegrity(auth: Pick<AuthorizationDocumentRecord, 'authorizationNumber' | 'vehicleId' | 'ownerId' | 'authorizedUserId' | 'type' | 'minPrice' | 'validUntil' | 'termsVersion' | 'qrValue' | 'sha256Hash'>) {
  if (!auth.sha256Hash) return false;
  if (auth.termsVersion === AUTHORIZATION_TERMS_VERSION) {
    return authorizationTermsHash(buildAuthorizationTerms(auth)) === auth.sha256Hash;
  }
  if (auth.termsVersion === '2026-08-11-v2') {
    const common = {
      authorizationNumber: auth.authorizationNumber,
      vehicleId: auth.vehicleId,
      ownerId: auth.ownerId,
      authorizedUserId: auth.authorizedUserId,
      type: auth.type,
    };
    const createdPayload = {
      ...common,
      minPrice: auth.minPrice ? Number(auth.minPrice) : null,
      validUntil: auth.validUntil.toISOString(),
      qrValue: auth.qrValue ?? null,
      termsVersion: auth.termsVersion,
    };
    const storedDocumentPayload = {
      ...common,
      minPrice: auth.minPrice?.toString() ?? null,
      validUntil: auth.validUntil.toISOString(),
      termsVersion: auth.termsVersion,
      qrValue: auth.qrValue ?? null,
    };
    return [simpleHash(createdPayload), simpleHash(storedDocumentPayload)].includes(auth.sha256Hash);
  }
  return false;
}

const STATUS_TEXT: Record<string, string> = {
  ACTIVE: 'ساري',
  REVOKED: 'ملغى',
  EXPIRED: 'منتهي',
};

const TYPE_TEXT: Record<string, string> = {
  SELL_ONLY: 'تفويض بالبيع فقط؛ تؤول حصيلة البيع إلى المالك',
  SELL_AND_RECEIVE: 'تفويض بالبيع واستلام الحصيلة وفق ضوابط الدفع في المنصة',
};

export function renderAuthorizationDocumentHtml(auth: AuthorizationDocumentRecord) {
  if (!auth.authorizedOtpVerifiedAt || !['ACTIVE', 'REVOKED', 'EXPIRED'].includes(auth.status)) throw new Error('AUTHORIZATION_DOCUMENT_NOT_AVAILABLE');
  if (!verifyAuthorizationIntegrity(auth)) throw new Error('AUTHORIZATION_INTEGRITY_FAILED');
  const effectiveStatus = auth.validUntil <= new Date() && auth.status === 'ACTIVE' ? 'EXPIRED' : auth.status;
  const status = STATUS_TEXT[effectiveStatus] ?? effectiveStatus;
  const minPrice = auth.minPrice ? `${Number(auth.minPrice).toLocaleString('ar-YE')} ريال يمني` : 'غير محدد';
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(auth.authorizationNumber)}</title>
  <style>
    :root{font-family:Arial,Tahoma,sans-serif;color:#0f172a;background:#f8fafc}*{box-sizing:border-box}body{margin:0;padding:24px}.sheet{max-width:850px;margin:auto;background:#fff;border:1px solid #cbd5e1;border-radius:18px;padding:36px}.brand{color:#064e3b;margin:0}.badge{display:inline-block;margin-top:10px;border-radius:999px;padding:6px 12px;background:#ecfdf5;color:#065f46;font-weight:700}.warning{background:#fffbeb;border:1px solid #fde68a;padding:14px;border-radius:12px;line-height:1.8}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px}.label{display:block;color:#64748b;font-size:13px;margin-bottom:4px}.hash{direction:ltr;overflow-wrap:anywhere;font-family:monospace;font-size:12px}.footer{margin-top:28px;color:#475569;font-size:13px;line-height:1.8}@media(max-width:650px){body{padding:8px}.sheet{padding:20px}.grid{grid-template-columns:1fr}}@media print{body{padding:0;background:#fff}.sheet{border:0;border-radius:0;max-width:none}.warning{break-inside:avoid}}
  </style>
</head>
<body>
  <main class="sheet">
    <h1 class="brand">ملخص تفويض إلكتروني — مركبات</h1>
    <p>نسخة مخصصة للأطراف المعنية ويمكن طباعتها من المتصفح.</p>
    <span class="badge">الحالة: ${escapeHtml(status)}</span>
    <div class="warning" style="margin-top:18px"><strong>تنبيه:</strong> هذا ملخص صادر من منصة مركبات، وليس وثيقة حكومية ولا إثباتًا لاعتماد جهة رسمية. تُحدَّد الحجية القانونية وفق الأنظمة والجهة المختصة.</div>
    <h2>بيانات التفويض</h2>
    <div class="grid">
      <div class="card"><span class="label">رقم التفويض</span><strong>${escapeHtml(auth.authorizationNumber)}</strong></div>
      <div class="card"><span class="label">نوع التفويض</span><strong>${escapeHtml(TYPE_TEXT[auth.type] ?? auth.type)}</strong></div>
      <div class="card"><span class="label">تاريخ الإنشاء</span><strong>${escapeHtml(auth.createdAt.toLocaleString('ar-YE'))}</strong></div>
      <div class="card"><span class="label">ساري حتى</span><strong>${escapeHtml(auth.validUntil.toLocaleString('ar-YE'))}</strong></div>
      <div class="card"><span class="label">الحد الأدنى للبيع</span><strong>${escapeHtml(minPrice)}</strong></div>
      <div class="card"><span class="label">تاريخ القبول</span><strong>${auth.acceptedAt ? escapeHtml(auth.acceptedAt.toLocaleString('ar-YE')) : '—'}</strong></div>
    </div>
    <h2>الأطراف</h2>
    <div class="grid">
      <div class="card"><span class="label">المالك</span><strong>${escapeHtml(auth.owner.fullName)}</strong><br>هوية: ${escapeHtml(maskAuthorizationNationalId(auth.owner.nationalId))}<br>جوال: ${escapeHtml(maskAuthorizationPhone(auth.owner.phone))}</div>
      <div class="card"><span class="label">الطرف المفوض</span><strong>${escapeHtml(auth.authorizedUser.fullName)}</strong><br>هوية: ${escapeHtml(maskAuthorizationNationalId(auth.authorizedUser.nationalId))}<br>جوال: ${escapeHtml(maskAuthorizationPhone(auth.authorizedUser.phone))}</div>
    </div>
    <h2>المركبة</h2>
    <div class="grid">
      <div class="card"><span class="label">المركبة</span><strong>${escapeHtml(`${auth.vehicle.make} ${auth.vehicle.model} ${auth.vehicle.year}`)}</strong></div>
      <div class="card"><span class="label">اللون</span><strong>${escapeHtml(auth.vehicle.color)}</strong></div>
      <div class="card"><span class="label">رقم اللوحة</span><strong>${escapeHtml(auth.vehicle.plateNumber)}</strong></div>
      <div class="card"><span class="label">رقم الهيكل</span><strong dir="ltr">${escapeHtml(auth.vehicle.vin)}</strong></div>
    </div>
    ${auth.revokedAt ? `<div class="warning" style="margin-top:18px"><strong>أُلغي التفويض في:</strong> ${escapeHtml(auth.revokedAt.toLocaleString('ar-YE'))}. لا يجوز استخدامه لبدء بيع جديد.</div>` : ''}
    <div class="footer"><strong>بصمة شروط التفويض SHA-256</strong><div class="hash">${escapeHtml(auth.sha256Hash!)}</div><p>إصدار الشروط: ${escapeHtml(auth.termsVersion)}. لا تعرض هذه النسخة رموز OTP أو معرّفات المستخدمين الداخلية.</p></div>
  </main>
</body>
</html>`;
}

function assertSafeProviderUrl(value: string, label: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label}_INVALID`); }
  if (!['http:', 'https:'].includes(url.protocol) || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error(`${label}_INVALID`);
  return url.toString();
}

export async function issueAuthorizationDocument(authorizationId: string) {
  const auth = await db.vehicleAuthorization.findUnique({ where: { id: authorizationId }, select: authorizationDocumentSelect });
  if (!auth) throw new Error('AUTHORIZATION_NOT_FOUND');
  if (auth.status !== 'ACTIVE' || auth.validUntil <= new Date()) throw new Error('AUTHORIZATION_DOCUMENT_NOT_AVAILABLE');
  if (auth.pdfUrl) return auth;
  const html = renderAuthorizationDocumentHtml(auth);
  const storageUrl = process.env.AUTHORIZATION_DOCUMENT_STORAGE_URL;
  const storageSecret = process.env.AUTHORIZATION_DOCUMENT_STORAGE_SECRET;
  if (!storageUrl || !storageSecret) throw new Error('NOT_CONFIGURED:AUTHORIZATION_DOCUMENT_STORAGE_REQUIRED');
  const response = await fetch(assertSafeProviderUrl(storageUrl, 'AUTHORIZATION_DOCUMENT_STORAGE_URL'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${storageSecret}` },
    body: JSON.stringify({ authorizationId, html, fileName: `${auth.authorizationNumber}.pdf`, format: 'pdf', idempotencyKey: `AUTHORIZATION_DOCUMENT:${auth.id}:${auth.sha256Hash}` }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('AUTHORIZATION_DOCUMENT_UPLOAD_FAILED');
  const body = await readBoundedResponseText(response, 64 * 1024, 'AUTHORIZATION_DOCUMENT_RESPONSE_INVALID');
  if (!body) throw new Error('AUTHORIZATION_DOCUMENT_RESPONSE_INVALID');
  let json: unknown;
  try { json = JSON.parse(body); } catch { throw new Error('AUTHORIZATION_DOCUMENT_RESPONSE_INVALID'); }
  const result = documentStorageResponseSchema.safeParse(json);
  if (!result.success) throw new Error('AUTHORIZATION_DOCUMENT_RESPONSE_INVALID');
  const pdfUrl = assertSafeProviderUrl(result.data.url, 'AUTHORIZATION_DOCUMENT_URL');
  return db.vehicleAuthorization.update({ where: { id: authorizationId }, data: { pdfUrl }, select: authorizationDocumentSelect });
}
