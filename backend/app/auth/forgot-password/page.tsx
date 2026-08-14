'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { ArrowRight, CheckCircle2, KeyRound, ShieldCheck } from 'lucide-react';

type Stage = 'REQUEST' | 'OTP' | 'RESET' | 'DONE';

const errors: Record<string, string> = {
  INVALID_INPUT: 'تحقق من البيانات المدخلة.',
  RATE_LIMITED: 'محاولات كثيرة. انتظر قليلاً ثم حاول مجددًا.',
  OTP_INVALID_OR_EXPIRED: 'الرمز غير صحيح أو انتهت صلاحيته. ابدأ طلبًا جديدًا عند الحاجة.',
  IDENTITY_VERIFICATION_REQUIRED: 'يتطلب هذا الحساب تحققًا إضافيًا. تواصل مع الدعم لاستعادة الوصول بأمان.',
  RESET_TOKEN_INVALID: 'انتهت جلسة الاستعادة. ابدأ طلبًا جديدًا.',
  RESET_TOKEN_STALE: 'تغيّرت حالة أمان الحساب بعد إصدار الرمز. ابدأ طلبًا جديدًا.',
  RESET_REQUEST_INVALID: 'انتهت جلسة الاستعادة أو استُخدمت سابقًا.',
  PASSWORD_RESET_FAILED: 'تعذر تغيير كلمة المرور. ابدأ طلبًا جديدًا.',
};

export default function ForgotPasswordPage() {
  const [stage, setStage] = useState<Stage>('REQUEST');
  const [phone, setPhone] = useState('');
  const [recoveryToken, setRecoveryToken] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function showError(value: unknown, fallback: string) {
    const code = value instanceof Error ? value.message : fallback;
    setError(errors[code] || errors[fallback] || 'تعذر إكمال الطلب حاليًا.');
  }

  async function requestReset(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/auth/forgot-password/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !result.recoveryToken) throw new Error(result.error || 'PASSWORD_RESET_FAILED');
      setRecoveryToken(result.recoveryToken);
      setNotice('إذا كان الرقم مرتبطًا بحساب نشط فسيصل رمز تحقق من 4 أرقام. لا نكشف ما إذا كان الرقم مسجلًا.');
      setStage('OTP');
    } catch (requestError) {
      showError(requestError, 'PASSWORD_RESET_FAILED');
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/auth/forgot-password/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recoveryToken, otp }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !result.resetToken) throw new Error(result.error || 'OTP_INVALID_OR_EXPIRED');
      setResetToken(result.resetToken);
      setExpiresAt(result.expiresAt || '');
      setNotice('تم التحقق من الرمز. اختر كلمة مرور جديدة قبل انتهاء جلسة الاستعادة.');
      setStage('RESET');
    } catch (verifyError) {
      showError(verifyError, 'OTP_INVALID_OR_EXPIRED');
    } finally {
      setLoading(false);
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (password !== confirmation) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/auth/forgot-password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetToken, password }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'PASSWORD_RESET_FAILED');
      setPassword('');
      setConfirmation('');
      setOtp('');
      setRecoveryToken('');
      setResetToken('');
      setNotice('تم تغيير كلمة المرور وإلغاء جميع الجلسات السابقة. يمكنك تسجيل الدخول الآن.');
      setStage('DONE');
    } catch (resetError) {
      showError(resetError, 'PASSWORD_RESET_FAILED');
    } finally {
      setLoading(false);
    }
  }

  function restart() {
    setStage('REQUEST');
    setRecoveryToken('');
    setResetToken('');
    setOtp('');
    setPassword('');
    setConfirmation('');
    setExpiresAt('');
    setError('');
    setNotice('');
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50 px-4 py-8"><div className="mx-auto max-w-lg">
    <Link href="/auth/login" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>تسجيل الدخول</Link>
    <section className="rounded-3xl border bg-white p-6 shadow-sm md:p-8">
      <div className="flex items-center gap-3"><span className="rounded-2xl bg-emerald-50 p-3 text-primary-900"><KeyRound/></span><div><h1 className="text-2xl font-black">استعادة كلمة المرور</h1><p className="mt-1 text-sm text-slate-500">رمز الهاتف ثم كلمة مرور جديدة، دون كشف وجود الحساب.</p></div></div>

      {stage === 'REQUEST' && <form onSubmit={requestReset} className="mt-6 space-y-4">
        <label className="block text-sm font-bold">رقم الجوال المسجل<input required minLength={7} maxLength={30} inputMode="tel" autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal" placeholder="+967…"/></label>
        <button disabled={loading} className="w-full rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50">{loading ? 'جارٍ إرسال الطلب…' : 'إرسال رمز الاستعادة'}</button>
      </form>}

      {stage === 'OTP' && <form onSubmit={verifyOtp} className="mt-6 space-y-4">
        <label className="block text-sm font-bold">رمز التحقق<input required pattern="[0-9]{4}" maxLength={4} inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, '').slice(0, 4))} className="mt-2 w-full rounded-xl border p-3 text-center text-2xl tracking-[0.4em]" placeholder="0000"/></label>
        <button disabled={loading || otp.length !== 4} className="w-full rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50">{loading ? 'جارٍ التحقق…' : 'تحقق من الرمز'}</button>
        <button type="button" onClick={restart} className="w-full rounded-xl border px-5 py-3 font-bold">بدء طلب جديد</button>
      </form>}

      {stage === 'RESET' && <form onSubmit={resetPassword} className="mt-6 space-y-4">
        {expiresAt && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">صلاحية طلب الاستعادة حتى: {new Date(expiresAt).toLocaleString('ar-YE')}</p>}
        <label className="block text-sm font-bold">كلمة المرور الجديدة<input required minLength={10} maxLength={200} type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"/><small className="mt-1 block font-normal text-slate-500">10 أحرف على الأقل.</small></label>
        <label className="block text-sm font-bold">تأكيد كلمة المرور<input required minLength={10} maxLength={200} type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
        <button disabled={loading} className="w-full rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50">{loading ? 'جارٍ التغيير…' : 'تغيير كلمة المرور'}</button>
      </form>}

      {stage === 'DONE' && <div className="mt-6 text-center"><CheckCircle2 className="mx-auto text-emerald-600" size={44}/><p className="mt-3 font-bold">اكتملت الاستعادة بنجاح.</p><Link href="/auth/login?passwordReset=1" className="mt-5 inline-block rounded-xl bg-primary-900 px-6 py-3 font-bold text-white">تسجيل الدخول</Link></div>}

      {(notice || error) && <div role={error ? 'alert' : 'status'} aria-live="polite" className={`mt-5 rounded-xl border p-4 text-sm leading-7 ${error ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{error || notice}</div>}
      <div className="mt-5 flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-xs leading-6 text-slate-600"><ShieldCheck className="mt-0.5 shrink-0" size={17}/>رموز الاستعادة قصيرة الصلاحية وتُستهلك مرة واحدة، وتغيير كلمة المرور يبطل كل الجلسات القديمة.</div>
    </section>
  </div></main>;
}
