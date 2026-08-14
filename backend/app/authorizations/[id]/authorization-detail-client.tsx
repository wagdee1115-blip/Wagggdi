'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ArrowRight, Ban, CheckCircle2, Clock3, FileText, KeyRound, RefreshCw, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';

type AuthorizationDetail = {
  id: string;
  authorizationNumber: string;
  viewerRole: 'OWNER' | 'AUTHORIZED';
  type: 'SELL_ONLY' | 'SELL_AND_RECEIVE';
  status: string;
  minPrice: string | null;
  validUntil: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  owner: { fullName: string; phoneMasked: string };
  authorizedParty: { fullName: string; phoneMasked: string };
  vehicle: { id: string; plateNumber: string; vinMasked: string; make: string; model: string; year: number; color: string; city: string };
  consent: { ownerVerified: boolean; authorizedVerified: boolean; ownerVerifiedAt: string | null; authorizedVerifiedAt: string | null };
  capabilities: { canOwnerRequestOtp: boolean; canAuthorizedRequestOtp: boolean; canAuthorizedReject: boolean; canOwnerRevoke: boolean; canPrint: boolean };
  integrity: { termsVersion: string; sha256: string | null };
  printUrl: string | null;
};

const STATUS_TEXT: Record<string, string> = {
  PENDING: 'بانتظار الموافقات', ACTIVE: 'ساري', REJECTED: 'مرفوض', REVOKED: 'ملغى', EXPIRED: 'منتهي',
};

const ERROR_TEXT: Record<string, string> = {
  AUTHORIZATION_NOT_FOUND: 'لم يُعثر على التفويض أو لا تملك صلاحية عرضه.',
  AUTHORIZATION_EXPIRED: 'انتهت صلاحية التفويض.',
  AUTHORIZATION_NOT_PENDING: 'لم يعد التفويض في حالة تسمح بهذه الخطوة.',
  AUTHORIZATION_STATE_CHANGED: 'تغيرت حالة التفويض أثناء الطلب. حدّث الصفحة.',
  AUTHORIZATION_CANNOT_BE_REVOKED: 'لا يمكن إلغاء التفويض في حالته الحالية.',
  AUTHORIZATION_ALREADY_ACCEPTED: 'سبق قبول التفويض.',
  OWNER_CONSENT_REQUIRED: 'يجب أن يؤكد المالك أولًا برمز هاتفه.',
  OWNER_CONSENT_ALREADY_RECORDED: 'سبق تسجيل موافقة المالك.',
  OWNER_PHONE_NOT_VERIFIED: 'جوال المالك غير موثق.', OWNER_IDENTITY_NOT_VERIFIED: 'هوية المالك غير موثقة.',
  AUTHORIZED_PHONE_NOT_VERIFIED: 'جوال الطرف المفوض غير موثق.', AUTHORIZED_IDENTITY_NOT_VERIFIED: 'هوية الطرف المفوض غير موثقة.',
  OTP_RESEND_TOO_SOON: 'انتظر دقيقة قبل طلب رمز آخر.',
  OTP_PHONE_RATE_LIMIT: 'تجاوزت محاولات الرموز الحد المؤقت.', OTP_IP_RATE_LIMIT: 'تجاوزت محاولات الرموز الحد المؤقت.', OTP_DEVICE_RATE_LIMIT: 'تجاوزت محاولات الرموز الحد المؤقت.', OTP_USER_RATE_LIMIT: 'تجاوزت محاولات الرموز الحد المؤقت.',
  OTP_NOT_FOUND: 'رمز التحقق غير موجود.', OTP_MISMATCH: 'رمز التحقق لا يخص هذا التفويض.', OTP_USER_MISMATCH: 'رمز التحقق لا يخص هذا الحساب.',
  OTP_REPLAY: 'استُخدم هذا الرمز من قبل.', OTP_EXPIRED: 'انتهت مهلة الرمز.', OTP_MAX_ATTEMPTS: 'تم استنفاد محاولات الرمز.', OTP_INVALID: 'رمز التحقق غير صحيح.',
  'NOT_CONFIGURED:SMS_PROVIDER_REQUIRED': 'خدمة رسائل OTP غير مهيأة حاليًا. لا يمكن تجاوز التحقق.',
};

function messageFor(error: unknown) {
  const code = error instanceof Error ? error.message : 'AUTHORIZATION_ACTION_FAILED';
  return ERROR_TEXT[code] || 'تعذر تنفيذ الخطوة. حدّث الصفحة وحاول مرة أخرى.';
}

export default function AuthorizationDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const [authorization, setAuthorization] = useState<AuthorizationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [otpId, setOtpId] = useState('');
  const [otp, setOtp] = useState('');
  const [otpParty, setOtpParty] = useState<'OWNER' | 'AUTHORIZED' | null>(null);
  const [otpExpiresAt, setOtpExpiresAt] = useState('');
  const [confirming, setConfirming] = useState<'REVOKE' | 'REJECT' | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/authorizations/${id}`, { cache: 'no-store', signal });
      const result = await response.json().catch(() => ({ ok: false, error: 'AUTHORIZATION_UNAVAILABLE' }));
      if (response.status === 401) { router.replace(`/auth/login?next=/authorizations/${id}`); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'AUTHORIZATION_UNAVAILABLE');
      setAuthorization(result.authorization);
      setError('');
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(messageFor(caught));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function readActionResponse(response: Response) {
    const result = await response.json().catch(() => ({ ok: false, error: 'AUTHORIZATION_ACTION_FAILED' }));
    if (response.status === 401) { router.replace(`/auth/login?next=/authorizations/${id}`); throw new Error('UNAUTHORIZED'); }
    if (!response.ok || !result.ok) throw new Error(result.error || 'AUTHORIZATION_ACTION_FAILED');
    return result;
  }

  async function requestOtp() {
    if (!authorization) return;
    setPending(true); setError(''); setNotice('');
    try {
      const party = authorization.viewerRole;
      const endpoint = party === 'OWNER' ? 'owner' : 'authorized';
      const result = await readActionResponse(await fetch(`/api/authorizations/${id}/otp/${endpoint}`, { method: 'POST' }));
      setOtpId(result.otpId);
      setOtpParty(party);
      setOtpExpiresAt(result.expiresAt);
      setOtp('');
      setNotice(`أُرسل رمز التحقق إلى جوالك المسجل وينتهي ${new Date(result.expiresAt).toLocaleTimeString('ar-YE')}.`);
    } catch (caught) { if (caught instanceof Error && caught.message !== 'UNAUTHORIZED') setError(messageFor(caught)); }
    finally { setPending(false); }
  }

  async function verifyOtp(event: FormEvent) {
    event.preventDefault();
    if (!authorization || !otpParty) return;
    setPending(true); setError(''); setNotice('');
    try {
      const endpoint = otpParty === 'OWNER' ? 'owner-consent' : 'accept';
      const result = await readActionResponse(await fetch(`/api/authorizations/${id}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ otpId, otp }) }));
      setAuthorization(result.authorization);
      setOtpId(''); setOtp(''); setOtpParty(null); setOtpExpiresAt('');
      setNotice(otpParty === 'OWNER' ? 'تم تسجيل موافقة المالك. أصبح الطلب بانتظار قبول الطرف المفوض.' : 'تم قبول التفويض وتفعيله بنجاح.');
    } catch (caught) { if (caught instanceof Error && caught.message !== 'UNAUTHORIZED') setError(messageFor(caught)); }
    finally { setPending(false); }
  }

  async function finalAction(action: 'REVOKE' | 'REJECT') {
    setPending(true); setError(''); setNotice('');
    try {
      const endpoint = action === 'REVOKE' ? 'revoke' : 'reject';
      const result = await readActionResponse(await fetch(`/api/authorizations/${id}/${endpoint}`, { method: 'POST' }));
      setAuthorization(result.authorization);
      setConfirming(null); setOtpId(''); setOtpParty(null);
      setNotice(action === 'REVOKE' ? 'تم إلغاء التفويض. أي بيع مرتبط قبل اكتماله أُحيل للمراجعة.' : 'تم رفض طلب التفويض.');
    } catch (caught) { if (caught instanceof Error && caught.message !== 'UNAUTHORIZED') setError(messageFor(caught)); }
    finally { setPending(false); }
  }

  if (loading) return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div role="status" className="mx-auto max-w-3xl rounded-2xl border bg-white p-10 text-center">جارٍ تحميل التفويض…</div></main>;

  if (!authorization) return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div className="mx-auto max-w-2xl"><Link href="/authorizations" className="font-bold text-primary-900">العودة للتفويضات</Link><div role="alert" className="mt-8 rounded-2xl border border-red-200 bg-red-50 p-8 text-center text-red-800">{error || 'التفويض غير متاح.'}</div></div></main>;

  const canRequestOtp = authorization.capabilities.canOwnerRequestOtp || authorization.capabilities.canAuthorizedRequestOtp;
  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-4xl p-4 md:p-7">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><Link href="/authorizations" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>التفويضات</Link><button onClick={() => { setLoading(true); void load(); }} disabled={pending} className="rounded-xl border bg-white p-2.5 disabled:opacity-50" aria-label="تحديث"><RefreshCw size={18}/></button></div>
    <header className="rounded-3xl border bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold text-slate-400">{authorization.authorizationNumber}</p><h1 className="mt-1 text-2xl font-black">تفويض {authorization.vehicle.make} {authorization.vehicle.model}</h1><p className="mt-2 text-sm text-slate-500">أنت {authorization.viewerRole === 'OWNER' ? 'مالك المركبة' : 'الطرف المطلوب تفويضه'}.</p></div><span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-bold">{STATUS_TEXT[authorization.status] || authorization.status}</span></div></header>

    {error && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}{error.includes('موثق') && <div><Link href="/account/verification" className="font-bold underline">مراجعة توثيق الحساب</Link></div>}</div>}
    {notice && <div role="status" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</div>}

    <section className="mt-5 grid gap-4 md:grid-cols-2">
      <article className="rounded-2xl border bg-white p-5"><h2 className="font-black">المركبة</h2><div className="mt-3 space-y-2 text-sm"><p>{authorization.vehicle.make} {authorization.vehicle.model} {authorization.vehicle.year} — {authorization.vehicle.color}</p><p>اللوحة: <b>{authorization.vehicle.plateNumber}</b></p><p>رقم الهيكل: <b dir="ltr">{authorization.vehicle.vinMasked}</b></p><p>المدينة: {authorization.vehicle.city}</p></div>{authorization.viewerRole === 'OWNER' && <Link href={`/vehicles/${authorization.vehicle.id}`} className="mt-4 inline-block text-sm font-bold text-primary-900 underline">عرض المركبة</Link>}</article>
      <article className="rounded-2xl border bg-white p-5"><h2 className="font-black">الأطراف والشروط</h2><div className="mt-3 space-y-2 text-sm"><p>المالك: <b>{authorization.owner.fullName}</b> — {authorization.owner.phoneMasked}</p><p>المفوض: <b>{authorization.authorizedParty.fullName}</b> — {authorization.authorizedParty.phoneMasked}</p><p>النطاق: <b>{authorization.type === 'SELL_ONLY' ? 'البيع فقط؛ الحصيلة للمالك' : 'البيع واستلام الحصيلة'}</b></p><p>الحد الأدنى: <b>{authorization.minPrice ? `${Number(authorization.minPrice).toLocaleString('ar-YE')} ريال` : 'غير محدد'}</b></p><p><Clock3 className="ml-1 inline" size={16}/>ينتهي: {new Date(authorization.validUntil).toLocaleString('ar-YE')}</p></div></article>
    </section>

    <section className="mt-5 rounded-2xl border bg-white p-5 md:p-6"><h2 className="text-lg font-black">الموافقات</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">
      <div className={`rounded-xl border p-4 ${authorization.consent.ownerVerified ? 'border-emerald-200 bg-emerald-50' : 'bg-slate-50'}`}>{authorization.consent.ownerVerified ? <CheckCircle2 className="text-emerald-700"/> : <KeyRound className="text-amber-700"/>}<b className="mt-2 block">موافقة المالك</b><p className="mt-1 text-xs text-slate-500">{authorization.consent.ownerVerifiedAt ? new Date(authorization.consent.ownerVerifiedAt).toLocaleString('ar-YE') : 'لم تُؤكد بعد'}</p></div>
      <div className={`rounded-xl border p-4 ${authorization.consent.authorizedVerified ? 'border-emerald-200 bg-emerald-50' : 'bg-slate-50'}`}>{authorization.consent.authorizedVerified ? <CheckCircle2 className="text-emerald-700"/> : <KeyRound className="text-amber-700"/>}<b className="mt-2 block">موافقة الطرف المفوض</b><p className="mt-1 text-xs text-slate-500">{authorization.consent.authorizedVerifiedAt ? new Date(authorization.consent.authorizedVerifiedAt).toLocaleString('ar-YE') : 'لم تُؤكد بعد'}</p></div>
    </div>

      {authorization.status === 'PENDING' && authorization.viewerRole === 'AUTHORIZED' && !authorization.consent.ownerVerified && <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">بانتظار أن يؤكد المالك أولًا. لا يمكنك طلب رمز القبول قبل ذلك.</div>}
      {canRequestOtp && !otpId && <button onClick={requestOtp} disabled={pending} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary-900 p-3 font-bold text-white disabled:opacity-50"><KeyRound size={18}/>{authorization.viewerRole === 'OWNER' ? 'إرسال OTP المالك وتأكيد التفويض' : 'إرسال OTP لقبول التفويض'}</button>}
      {otpId && <form onSubmit={verifyOtp} className="mt-4 rounded-xl border bg-slate-50 p-4"><p className="text-sm font-bold">أدخل الرمز المرسل إلى جوالك المسجل</p>{otpExpiresAt && <p className="mt-1 text-xs text-slate-500">ينتهي {new Date(otpExpiresAt).toLocaleTimeString('ar-YE')}</p>}<input required value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, '').slice(0, 4))} pattern="[0-9]{4}" inputMode="numeric" autoComplete="one-time-code" maxLength={4} className="mt-3 w-full rounded-xl border p-3 text-center text-2xl tracking-[0.4em]" aria-label="رمز التحقق"/><button disabled={pending || otp.length !== 4} className="mt-3 w-full rounded-xl bg-emerald-800 p-3 font-bold text-white disabled:opacity-50">{otpParty === 'OWNER' ? 'تأكيد موافقة المالك' : 'قبول وتفعيل التفويض'}</button></form>}
    </section>

    {authorization.capabilities.canPrint && authorization.printUrl && <section className="mt-5 rounded-2xl border bg-white p-5"><div className="flex gap-3"><FileText className="text-primary-900"/><div><h2 className="font-black">نسخة للطباعة</h2><p className="mt-1 text-sm leading-6 text-slate-500">ملخص HTML آمن للأطراف المعنية، وليس PDF حكوميًا أو اعتمادًا رسميًا.</p></div></div><a href={authorization.printUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 font-bold"><FileText size={18}/>فتح ملخص التفويض للطباعة</a><div className="mt-4 rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">بصمة الشروط — {authorization.integrity.termsVersion}</p><p dir="ltr" className="mt-1 break-all font-mono text-xs">{authorization.integrity.sha256 || 'غير متاحة'}</p></div></section>}

    {(authorization.capabilities.canOwnerRevoke || authorization.capabilities.canAuthorizedReject) && <section className="mt-5 rounded-2xl border border-red-200 bg-white p-5"><div className="flex gap-3"><ShieldAlert className="text-red-700"/><div><h2 className="font-black">إنهاء التفويض</h2><p className="mt-1 text-sm leading-6 text-slate-500">{authorization.capabilities.canOwnerRevoke ? 'الإلغاء يمنع أي بيع جديد، ويحوّل البيع الجاري قبل نقل الملكية إلى مراجعة يدوية.' : 'يمكنك رفض الطلب ما دام معلقًا.'}</p></div></div>
      {!confirming ? <button onClick={() => setConfirming(authorization.capabilities.canOwnerRevoke ? 'REVOKE' : 'REJECT')} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-red-300 px-4 py-2.5 font-bold text-red-800">{authorization.capabilities.canOwnerRevoke ? <Ban size={18}/> : <XCircle size={18}/>}{authorization.capabilities.canOwnerRevoke ? 'إلغاء التفويض' : 'رفض طلب التفويض'}</button> : <div className="mt-4 rounded-xl bg-red-50 p-4"><p className="font-bold text-red-900">هل أنت متأكد؟ لا يمكن التراجع عن هذه الحالة.</p><div className="mt-3 flex gap-2"><button disabled={pending} onClick={() => finalAction(confirming)} className="rounded-lg bg-red-700 px-4 py-2 font-bold text-white disabled:opacity-50">تأكيد</button><button disabled={pending} onClick={() => setConfirming(null)} className="rounded-lg border px-4 py-2 font-bold">عودة</button></div></div>}
    </section>}

    <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-950"><ShieldCheck className="mb-2"/><strong>حدود الخدمة:</strong> المنصة تتحقق من هوية وجوال الطرفين وتوثق موافقتهما الداخلية. لا تدّعي هذه الشاشة اتصالًا حكوميًا أو إصدار وثيقة مرور.</div>
  </div></main>;
}
