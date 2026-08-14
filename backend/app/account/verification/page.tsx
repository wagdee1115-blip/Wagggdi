'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ArrowRight, BadgeCheck, ShieldCheck } from 'lucide-react';

type IdentityProfile = {
  identityStatus: string;
  phoneStatus: string;
  nationalId: string | null;
  nationalIdMasked: string | null;
  dateOfBirth: string | null;
  verified: boolean;
};

type Verification = {
  id: string;
  status: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
};

const identityLabels: Record<string, string> = {
  UNVERIFIED: 'غير موثقة', MOBILE_VERIFIED: 'الهاتف فقط', IDENTITY_VERIFIED: 'موثقة',
  IDENTITY_FACE_VERIFIED: 'موثقة مع تحقق إضافي', ADVANCED_VERIFIED: 'توثيق متقدم',
  PENDING: 'قيد المراجعة', VERIFIED: 'موثقة', REJECTED: 'مرفوضة',
};
const verificationLabels: Record<string, string> = { UNVERIFIED: 'لم يكتمل الاتصال بالمزود', PENDING: 'قيد معالجة المزود', VERIFIED: 'تم التحقق', REJECTED: 'لم يتم التحقق' };
const phoneLabels: Record<string, string> = { PENDING: 'قيد التحقق', VERIFIED: 'موثق', FAILED: 'فشل التحقق', EXPIRED: 'انتهت الصلاحية' };
const errorMessages: Record<string, string> = {
  INVALID_INPUT: 'تحقق من رقم الهوية وتاريخ الميلاد.',
  INVALID_NATIONAL_ID: 'رقم الهوية يجب أن يتكون من 6 إلى 20 رقمًا.',
  INVALID_DATE_OF_BIRTH: 'أدخل تاريخ ميلاد صحيحًا لشخص يبلغ 18 عامًا على الأقل.',
  IDENTITY_ALREADY_VERIFIED: 'هذه الهوية موثقة بالفعل.',
  VERIFIED_IDENTITY_CHANGE_REQUIRES_SUPPORT: 'لا يمكن تغيير هوية موثقة من هذه الصفحة. تواصل مع الدعم.',
  IDENTITY_SUBMISSION_CONFLICT: 'تعذر اعتماد بيانات الهوية. تواصل مع الدعم إذا كانت البيانات صحيحة.',
  'NOT_CONFIGURED:IDENTITY_PROVIDER_REQUIRED': 'مزود الهوية غير مربوط بعد؛ لن نعتمد الهوية دون تحقق خارجي حقيقي.',
  'NOT_CONFIGURED:IDENTITY_PROVIDER_URL_INVALID': 'إعداد عنوان مزود الهوية غير صالح.',
  'NOT_CONFIGURED:IDENTITY_PROVIDER_HTTPS_REQUIRED': 'مزود الهوية في الإنتاج يجب أن يستخدم اتصال HTTPS.',
  IDENTITY_PROVIDER_UNAVAILABLE: 'تعذر الاتصال بمزود الهوية. لم يتم اعتماد الحساب؛ حاول لاحقًا.',
  IDENTITY_PROVIDER_RESPONSE_INVALID: 'أعاد مزود الهوية استجابة غير موثوقة؛ لم يتم اعتماد الحساب.',
  IDENTITY_PROVIDER_SUBJECT_MISMATCH: 'بيانات رد المزود لا تطابق الطلب؛ لم يتم اعتماد الحساب.',
  RATE_LIMITED: 'تجاوزت عدد محاولات التحقق المسموح. حاول لاحقًا.',
  PHONE_NOT_VERIFIED: 'يجب توثيق رقم الهاتف قبل إرسال بيانات الهوية.',
};

export default function VerificationPage() {
  const [profile, setProfile] = useState<IdentityProfile | null>(null);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [nationalId, setNationalId] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/identity-verifications', { signal, cache: 'no-store' });
      const result = await response.json();
      if (response.status === 401) {
        setAuthRequired(true);
        setProfile(null);
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'IDENTITY_LOAD_FAILED');
      setProfile(result.profile);
      setVerifications(result.verifications || []);
      setNationalId(result.profile.verified ? (result.profile.nationalIdMasked || '') : (result.profile.nationalId || ''));
      setDateOfBirth(result.profile.dateOfBirth || '');
      setAuthRequired(false);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setError('تعذر تحميل بيانات التحقق.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/identity-verifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nationalId, dateOfBirth }),
      });
      const result = await response.json();
      if (response.status === 401) {
        setAuthRequired(true);
        setProfile(null);
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'IDENTITY_VERIFICATION_FAILED');
      const status = result.verification.status;
      setNotice(status === 'VERIFIED' ? 'تم توثيق رقم الهوية وتاريخ الميلاد.' : status === 'REJECTED' ? 'لم يؤكد المزود تطابق البيانات. راجعها أو تواصل مع الدعم.' : 'استلم المزود الطلب وما زال قيد المعالجة.');
      await load();
    } catch (submitError) {
      const code = submitError instanceof Error ? submitError.message : 'IDENTITY_VERIFICATION_FAILED';
      setError(errorMessages[code] || 'تعذر إكمال التحقق حاليًا.');
    } finally {
      setSubmitting(false);
    }
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div className="mx-auto max-w-2xl">
    <Link href="/account" className="inline-flex items-center gap-2 font-bold text-primary-900"><ArrowRight size={18}/>الحساب</Link>
    <section className="mt-6 rounded-3xl border bg-white p-6 shadow-sm">
      <div className="flex items-center gap-3"><span className="rounded-2xl bg-emerald-50 p-3 text-primary-900"><BadgeCheck/></span><div><h1 className="text-2xl font-black">التحقق من الهوية</h1><p className="mt-1 text-sm text-slate-500">مطابقة رقم الهوية وتاريخ الميلاد عبر مزود خارجي حقيقي.</p></div></div>
      <div className="mt-5 flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-7 text-blue-900"><ShieldCheck className="mt-1 shrink-0" size={18}/>هذا المسار لا يطلب صورة هوية أو صورة شخصية، ولا يدّعي تنفيذ مطابقة وجه أو فحص حيوية. لا تتغير حالة حسابك إلى «موثق» إلا بعد رد VERIFIED مطابق من المزود.</div>
      {loading && <div role="status" className="mt-6 rounded-xl bg-slate-50 p-5 text-center">جارٍ تحميل حالة الهوية…</div>}
      {!loading && authRequired && <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-center"><p className="font-bold">سجّل الدخول أولًا.</p><Link href="/auth/login?next=/account/verification" className="mt-4 inline-block rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تسجيل الدخول</Link></div>}
      {!loading && profile && <>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-slate-50 p-4"><dt className="text-sm text-slate-500">الهاتف</dt><dd className="mt-1 font-bold">{phoneLabels[profile.phoneStatus] || profile.phoneStatus}</dd></div><div className="rounded-xl bg-slate-50 p-4"><dt className="text-sm text-slate-500">حالة الهوية</dt><dd className="mt-1 font-bold">{identityLabels[profile.identityStatus] || profile.identityStatus}</dd></div></dl>
        <form onSubmit={submit} className="mt-6 space-y-4 border-t pt-6">
          <label className="block text-sm font-bold">رقم الهوية<input required disabled={profile.verified} minLength={6} maxLength={40} inputMode="numeric" autoComplete="off" value={nationalId} onChange={event => setNationalId(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal disabled:bg-slate-100" dir="ltr"/></label>
          <label className="block text-sm font-bold">تاريخ الميلاد<input required disabled={profile.verified} type="date" value={dateOfBirth} onChange={event => setDateOfBirth(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal disabled:bg-slate-100"/></label>
          {profile.verified ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">الهوية موثقة ({profile.nationalIdMasked}). أي تغيير لاحق يتطلب مراجعة الدعم.</div> : <button disabled={submitting || profile.phoneStatus !== 'VERIFIED'} className="w-full rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50">{submitting ? 'جارٍ الاتصال بالمزود…' : 'تحقق من البيانات'}</button>}
          {profile.phoneStatus !== 'VERIFIED' && !profile.verified && <p className="text-sm text-amber-800">يجب توثيق رقم الهاتف قبل إرسال بيانات الهوية.</p>}
        </form>
      </>}
      {(error || notice) && <div role={error ? 'alert' : 'status'} aria-live="polite" className={`mt-5 rounded-xl border p-4 text-sm ${error ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{error || notice}</div>}
    </section>
      {!loading && verifications.length > 0 && <section className="mt-5"><h2 className="text-xl font-black">سجل الطلبات</h2><div className="mt-3 space-y-3">{verifications.map(verification => <article key={verification.id} className="rounded-2xl border bg-white p-4"><div className="flex items-center justify-between gap-3"><div><b>{verificationLabels[verification.status] || verification.status}</b><p className="mt-1 text-xs text-slate-500">{new Date(verification.createdAt).toLocaleString('ar-YE')}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold">{verification.provider === 'HTTP_IDENTITY_PROVIDER' ? 'مزود الهوية المرتبط' : 'سجل مزود سابق'}</span></div></article>)}</div></section>}
  </div></main>;
}
