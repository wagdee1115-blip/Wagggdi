'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ArrowRight, Clock3, KeyRound, LockKeyhole, Phone, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';

type SecurityUser = { phone: string; phoneStatus: string };
type PhoneChangeRequest = {
  id: string;
  status: 'OTP_PENDING' | 'SECURITY_DELAY' | 'ACTIVATED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  newPhoneMasked: string;
  otpExpiresAt: string | null;
  resendAvailableAt: string | null;
  activateAt: string | null;
  activatedAt: string | null;
  canCancel: boolean;
  canResend: boolean;
  createdAt: string;
};

const errorMessages: Record<string, string> = {
  INVALID_INPUT: 'كلمة المرور الجديدة يجب أن تكون 10 أحرف على الأقل.',
  CURRENT_PASSWORD_INVALID: 'كلمة المرور الحالية غير صحيحة.',
  NEW_PASSWORD_MUST_DIFFER: 'اختر كلمة مرور مختلفة عن الحالية.',
  ACCOUNT_CHANGED_RETRY: 'تغيّرت حالة الحساب أثناء الطلب. سجّل الدخول مجددًا وحاول مرة أخرى.',
  RATE_LIMITED: 'محاولات كثيرة. حاول لاحقًا.',
  PASSWORD_CHANGE_FAILED: 'تعذر تغيير كلمة المرور حاليًا.',
  INVALID_PHONE: 'أدخل رقم هاتف صحيحًا من 9 إلى 15 رقمًا.',
  PHONE_CHANGE_UNAVAILABLE: 'لا يمكن استخدام هذا الرقم أو يوجد طلب تغيير نشط. ألغِ الطلب الحالي أولًا.',
  PHONE_CHANGE_NOT_ACTIVE: 'لم يعد طلب تغيير الهاتف نشطًا.',
  PHONE_CHANGE_ALREADY_ACTIVATED: 'تم تفعيل الرقم بالفعل.',
  OTP_INVALID: 'رمز التحقق غير صحيح.',
  OTP_INVALID_FORMAT: 'رمز التحقق يجب أن يتكون من 6 أرقام.',
  OTP_EXPIRED: 'انتهت صلاحية الرمز. ابدأ طلبًا جديدًا.',
  OTP_MAX_ATTEMPTS: 'تم إيقاف الطلب بعد تجاوز محاولات التحقق.',
  OTP_RESEND_TOO_SOON: 'انتظر دقيقة قبل إعادة إرسال الرمز.',
  OTP_DELIVERY_PENDING: 'إرسال الرمز قيد المعالجة. حاول بعد لحظات.',
  SMS_DELIVERY_FAILED: 'تعذر إرسال الرسالة عبر مزود SMS. لم يُفعّل أي تغيير.',
  'NOT_CONFIGURED:SMS_PROVIDER_REQUIRED': 'مزود الرسائل غير مهيأ حاليًا. لم يُفعّل أي تغيير.',
  'NOT_CONFIGURED:SMS_PROVIDER_HTTPS_REQUIRED': 'إعداد مزود الرسائل غير آمن. لم يُفعّل أي تغيير.',
  PHONE_CHANGE_FAILED: 'تعذر إكمال طلب تغيير الهاتف حاليًا.',
};

const phoneLabels: Record<string, string> = { PENDING: 'قيد التحقق', VERIFIED: 'موثق', FAILED: 'فشل التحقق', EXPIRED: 'انتهت صلاحية التحقق' };

export default function SecurityPage() {
  const [user, setUser] = useState<SecurityUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [changed, setChanged] = useState(false);
  const [sessionsRevoked, setSessionsRevoked] = useState(false);
  const [sessionSubmitting, setSessionSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [phoneChange, setPhoneChange] = useState<PhoneChangeRequest | null>(null);
  const [newPhone, setNewPhone] = useState('');
  const [phonePassword, setPhonePassword] = useState('');
  const [phoneOtp, setPhoneOtp] = useState('');
  const [phoneSubmitting, setPhoneSubmitting] = useState(false);
  const [phoneError, setPhoneError] = useState('');
  const [phoneMessage, setPhoneMessage] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [response, phoneResponse] = await Promise.all([
        fetch('/api/me', { signal, cache: 'no-store' }),
        fetch('/api/account/phone-change', { signal, cache: 'no-store' }),
      ]);
      const [result, phoneResult] = await Promise.all([response.json(), phoneResponse.json()]);
      if (response.status === 401) {
        setAuthRequired(true);
        setUser(null);
        return;
      }
      if (!response.ok || !result.ok) throw new Error('SECURITY_LOAD_FAILED');
      if (!phoneResponse.ok || !phoneResult.ok) throw new Error('SECURITY_LOAD_FAILED');
      setUser(result.user);
      setPhoneChange(phoneResult.request ?? null);
      setAuthRequired(false);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setError('تعذر تحميل حالة الأمان.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmation) {
      setError('كلمتا المرور الجديدتان غير متطابقتين.');
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const result = await response.json();
      if (response.status === 401) {
        setAuthRequired(true);
        setUser(null);
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'PASSWORD_CHANGE_FAILED');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setChanged(true);
      setUser(null);
    } catch (changeError) {
      const code = changeError instanceof Error ? changeError.message : 'PASSWORD_CHANGE_FAILED';
      setError(errorMessages[code] || errorMessages.PASSWORD_CHANGE_FAILED);
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeAllSessions() {
    setSessionSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error('SESSION_REVOCATION_FAILED');
      setSessionsRevoked(true);
      setUser(null);
    } catch {
      setError('تعذر تأكيد إلغاء جميع الجلسات. أُغلقت هذه الجلسة محليًا؛ سجّل الدخول مجددًا وحاول مرة أخرى.');
      setUser(null);
      setAuthRequired(true);
    } finally {
      setSessionSubmitting(false);
    }
  }

  function phoneErrorText(code: string) {
    if (code === 'INVALID_INPUT') return 'تحقق من رقم الهاتف والحقول المطلوبة.';
    return errorMessages[code] || errorMessages.PHONE_CHANGE_FAILED;
  }

  async function startPhoneChange(event: FormEvent) {
    event.preventDefault();
    setPhoneSubmitting(true);
    setPhoneError('');
    setPhoneMessage('');
    try {
      const response = await fetch('/api/account/phone-change/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPhone, currentPassword: phonePassword }),
      });
      const result = await response.json();
      if (response.status === 401) { setAuthRequired(true); setUser(null); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'PHONE_CHANGE_FAILED');
      setPhoneChange(result.request);
      setNewPhone('');
      setPhonePassword('');
      setPhoneOtp('');
      setPhoneMessage('أُرسل رمز من 6 أرقام إلى الرقم الجديد. لم يتغير رقم حسابك بعد.');
    } catch (requestError) {
      setPhoneError(phoneErrorText(requestError instanceof Error ? requestError.message : 'PHONE_CHANGE_FAILED'));
    } finally {
      setPhoneSubmitting(false);
    }
  }

  async function verifyPhoneOtp(event: FormEvent) {
    event.preventDefault();
    if (!phoneChange) return;
    setPhoneSubmitting(true);
    setPhoneError('');
    setPhoneMessage('');
    try {
      const response = await fetch('/api/account/phone-change/otp/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: phoneChange.id, otp: phoneOtp }),
      });
      const result = await response.json();
      if (response.status === 401) { setAuthRequired(true); setUser(null); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'PHONE_CHANGE_FAILED');
      setPhoneChange(result.request);
      setPhoneOtp('');
      setPhoneMessage('تم التحقق. بدأت مهلة حماية ثابتة مدتها 48 ساعة ويمكنك الإلغاء قبل التفعيل.');
    } catch (verifyError) {
      setPhoneError(phoneErrorText(verifyError instanceof Error ? verifyError.message : 'PHONE_CHANGE_FAILED'));
    } finally {
      setPhoneSubmitting(false);
    }
  }

  async function resendPhoneOtp() {
    if (!phoneChange) return;
    setPhoneSubmitting(true);
    setPhoneError('');
    setPhoneMessage('');
    try {
      const response = await fetch('/api/account/phone-change/otp/resend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: phoneChange.id }),
      });
      const result = await response.json();
      if (response.status === 401) { setAuthRequired(true); setUser(null); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'PHONE_CHANGE_FAILED');
      setPhoneChange(result.request);
      setPhoneOtp('');
      setPhoneMessage('أُرسل رمز جديد وأُلغي الرمز السابق.');
    } catch (resendError) {
      setPhoneError(phoneErrorText(resendError instanceof Error ? resendError.message : 'PHONE_CHANGE_FAILED'));
    } finally {
      setPhoneSubmitting(false);
    }
  }

  async function cancelPhoneRequest() {
    if (!phoneChange) return;
    setPhoneSubmitting(true);
    setPhoneError('');
    setPhoneMessage('');
    try {
      const response = await fetch('/api/account/phone-change/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: phoneChange.id }),
      });
      const result = await response.json();
      if (response.status === 401) { setAuthRequired(true); setUser(null); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'PHONE_CHANGE_FAILED');
      setPhoneChange(result.request);
      setPhoneOtp('');
      setPhoneMessage('تم إلغاء الطلب. لم يتغير رقم حسابك.');
    } catch (cancelError) {
      setPhoneError(phoneErrorText(cancelError instanceof Error ? cancelError.message : 'PHONE_CHANGE_FAILED'));
    } finally {
      setPhoneSubmitting(false);
    }
  }

  const activePhoneChange = phoneChange?.status === 'OTP_PENDING' || phoneChange?.status === 'SECURITY_DELAY';

  return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div className="mx-auto max-w-2xl">
    <Link href="/account" className="inline-flex items-center gap-2 font-bold text-primary-900"><ArrowRight size={18}/>الحساب</Link>
    <section className="mt-6 rounded-3xl border bg-white p-6 shadow-sm">
      <div className="flex items-center gap-3"><span className="rounded-2xl bg-emerald-50 p-3 text-primary-900"><LockKeyhole/></span><div><h1 className="text-2xl font-black">الأمان وتسجيل الدخول</h1><p className="mt-1 text-sm text-slate-500">حالة دقيقة للحساب وتغيير آمن لكلمة المرور.</p></div></div>
      {loading && <div role="status" className="mt-6 rounded-xl bg-slate-50 p-5 text-center">جارٍ تحميل حالة الأمان…</div>}
      {!loading && authRequired && <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-center"><p className="font-bold">انتهت الجلسة أو لم تسجّل الدخول.</p><Link href="/auth/login?next=/account/security" className="mt-4 inline-block rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تسجيل الدخول</Link></div>}
      {!loading && user && !changed && <>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-slate-50 p-4"><dt className="text-sm text-slate-500">رقم الهاتف</dt><dd className="mt-1 font-bold" dir="ltr">{user.phone}</dd><dd className="mt-1 text-sm">{phoneLabels[user.phoneStatus] || user.phoneStatus}</dd></div>
          <div className="rounded-xl bg-slate-50 p-4"><dt className="text-sm text-slate-500">الجلسات</dt><dd className="mt-1 font-bold">الجلسة الحالية صالحة الآن</dd><dd className="mt-1 text-xs leading-5 text-slate-500">يمكنك إلغاء كل الجلسات المسجلة على أي جهاز فورًا.</dd><button type="button" disabled={sessionSubmitting} onClick={() => void revokeAllSessions()} className="mt-3 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-50">{sessionSubmitting ? 'جارٍ الإلغاء…' : 'إلغاء جميع الجلسات'}</button></div>
        </dl>
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-7 text-blue-900"><ShieldCheck className="mt-1 shrink-0" size={18}/>عند نجاح التغيير تُلغى جميع الجلسات فورًا، بما فيها هذه الجلسة، ويُسجل الحدث ويصل تنبيه داخل التطبيق.</div>
        <section className="mt-6 border-t pt-6" aria-labelledby="phone-change-title">
          <h2 id="phone-change-title" className="flex items-center gap-2 text-xl font-black"><Phone size={21}/>تغيير رقم الهاتف</h2>
          <p className="mt-2 text-sm leading-7 text-slate-600">يتطلب كلمة المرور الحالية والتحقق من ملكية الرقم الجديد. بعد التحقق تبدأ مهلة حماية 48 ساعة؛ لا يتغير الرقم قبل انتهائها، ويمكن إلغاء الطلب حتى لحظة التفعيل.</p>

          {phoneChange && <div className={`mt-4 rounded-xl border p-4 text-sm ${activePhoneChange ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
            <p className="font-bold">الرقم الجديد: <span dir="ltr">{phoneChange.newPhoneMasked}</span></p>
            {phoneChange.status === 'OTP_PENDING' && <p className="mt-1">بانتظار رمز التحقق{phoneChange.otpExpiresAt ? ` حتى ${new Date(phoneChange.otpExpiresAt).toLocaleString('ar-YE')}` : ''}.</p>}
            {phoneChange.status === 'SECURITY_DELAY' && <p className="mt-1 flex items-center gap-2"><Clock3 size={17}/>موعد التفعيل المتوقع: {phoneChange.activateAt ? new Date(phoneChange.activateAt).toLocaleString('ar-YE') : 'بعد اكتمال 48 ساعة'}</p>}
            {phoneChange.status === 'CANCELLED' && <p className="mt-1">أُلغي هذا الطلب ولم يتغير الرقم.</p>}
            {phoneChange.status === 'EXPIRED' && <p className="mt-1">انتهت صلاحية الطلب ولم يتغير الرقم.</p>}
            {phoneChange.status === 'FAILED' && <p className="mt-1">توقف الطلب بأمان ولم يتغير الرقم.</p>}
            {phoneChange.status === 'ACTIVATED' && <p className="mt-1">تم التفعيل وإلغاء جميع الجلسات.</p>}
          </div>}

          {phoneChange?.status === 'OTP_PENDING' && <form onSubmit={verifyPhoneOtp} className="mt-4 space-y-3">
            <label className="block text-sm font-bold">رمز التحقق المرسل للرقم الجديد<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={phoneOtp} onChange={event => setPhoneOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} className="mt-2 w-full rounded-xl border p-3 font-normal" dir="ltr"/></label>
            <button disabled={phoneSubmitting || phoneOtp.length !== 6} className="w-full rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50">{phoneSubmitting ? 'جارٍ التحقق…' : 'تحقق وابدأ مهلة 48 ساعة'}</button>
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" disabled={phoneSubmitting} onClick={() => void resendPhoneOtp()} className="inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-3 font-bold disabled:opacity-50"><RefreshCw size={17}/>إعادة إرسال الرمز</button>
              <button type="button" disabled={phoneSubmitting} onClick={() => void cancelPhoneRequest()} className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 px-4 py-3 font-bold text-red-700 disabled:opacity-50"><XCircle size={17}/>إلغاء الطلب</button>
            </div>
          </form>}

          {phoneChange?.status === 'SECURITY_DELAY' && <button type="button" disabled={phoneSubmitting} onClick={() => void cancelPhoneRequest()} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 px-4 py-3 font-bold text-red-700 disabled:opacity-50"><XCircle size={17}/>{phoneSubmitting ? 'جارٍ الإلغاء…' : 'إلغاء التغيير قبل التفعيل'}</button>}

          {!activePhoneChange && <form onSubmit={startPhoneChange} className="mt-5 space-y-4">
            <label className="block text-sm font-bold">رقم الهاتف الجديد<input required inputMode="tel" autoComplete="tel" pattern="\+?[0-9]{9,15}" placeholder="+967777000000" value={newPhone} onChange={event => setNewPhone(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal" dir="ltr"/></label>
            <label className="block text-sm font-bold">كلمة المرور الحالية<input required minLength={8} maxLength={200} type="password" autoComplete="current-password" value={phonePassword} onChange={event => setPhonePassword(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
            <button disabled={phoneSubmitting} className="w-full rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50">{phoneSubmitting ? 'جارٍ إنشاء الطلب…' : 'تحقق من الرقم الجديد'}</button>
          </form>}
          {phoneMessage && <div role="status" aria-live="polite" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{phoneMessage}</div>}
          {phoneError && <div role="alert" aria-live="polite" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{phoneError}</div>}
        </section>
        <form onSubmit={changePassword} className="mt-6 space-y-4 border-t pt-6">
          <h2 className="flex items-center gap-2 text-xl font-black"><KeyRound size={21}/>تغيير كلمة المرور</h2>
          <label className="block text-sm font-bold">كلمة المرور الحالية<input required minLength={8} maxLength={200} type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
          <label className="block text-sm font-bold">كلمة المرور الجديدة<input required minLength={10} maxLength={200} type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"/><small className="mt-1 block font-normal text-slate-500">10 أحرف على الأقل، ومختلفة عن الحالية.</small></label>
          <label className="block text-sm font-bold">تأكيد كلمة المرور الجديدة<input required minLength={10} maxLength={200} type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
          <button disabled={submitting} className="w-full rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50">{submitting ? 'جارٍ التغيير…' : 'غيّر كلمة المرور وألغِ الجلسات'}</button>
        </form>
      </>}
      {(changed || sessionsRevoked) && <div role="status" aria-live="polite" className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-center text-emerald-900"><ShieldCheck className="mx-auto"/><p className="mt-2 font-bold">{changed ? 'تم تغيير كلمة المرور وإلغاء جميع الجلسات.' : 'تم إلغاء جميع الجلسات بنجاح.'}</p><Link href={changed ? '/auth/login?passwordChanged=1' : '/auth/login'} className="mt-4 inline-block rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تسجيل الدخول من جديد</Link></div>}
      {error && <div role="alert" aria-live="polite" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
    </section>
  </div></main>;
}
