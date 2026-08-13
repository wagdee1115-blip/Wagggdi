'use client';

import { FormEvent, useState } from 'react';
import { ArrowRight, CheckCircle2, Send, UserPlus } from 'lucide-react';

type FormState = {
  fullName: string;
  phone: string;
  email: string;
  nationalId: string;
  dateOfBirth: string;
  password: string;
};

const initialForm: FormState = { fullName: '', phone: '', email: '', nationalId: '', dateOfBirth: '', password: '' };

const errorText: Record<string, string> = {
  INVALID_INPUT: 'تحقق من البيانات المدخلة.',
  REGISTRATION_FAILED: 'تعذر إنشاء الحساب حالياً.',
  RATE_LIMITED: 'تم تجاوز عدد المحاولات المسموح. حاول لاحقاً.',
  OTP_RESEND_TOO_SOON: 'انتظر قليلاً قبل إعادة إرسال الرمز.',
  OTP_EXPIRED: 'انتهت صلاحية رمز التحقق. أرسل رمزاً جديداً.',
  OTP_ATTEMPTS_EXCEEDED: 'تم تجاوز محاولات رمز التحقق.',
  'NOT_CONFIGURED:PHONE_PROVIDER_REQUIRED': 'خدمة الرسائل النصية غير مفعلة حالياً.',
};

export default function RegisterPage() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [userId, setUserId] = useState('');
  const [otpId, setOtpId] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const operationId = userId ? `REGISTRATION:${userId}` : '';

  async function sendOtp(id: string) {
    const op = `REGISTRATION:${id}`;
    const response = await fetch('/api/auth/otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: op, type: 'BUYER' }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'OTP_SEND_FAILED');
    setOtpId(result.otpId);
    setMessage('تم إرسال رمز تحقق مكوّن من 4 أرقام إلى رقم الجوال المسجل.');
  }

  async function register(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const payload = {
        fullName: form.fullName.trim(),
        phone: form.phone.trim(),
        password: form.password,
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        ...(form.nationalId.trim() ? { nationalId: form.nationalId.trim() } : {}),
        ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
      };
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'REGISTRATION_FAILED');
      setUserId(result.user.id);
      setMessage('تم إنشاء الحساب. جارٍ تجهيز التحقق من رقم الجوال...');
      try {
        await sendOtp(result.user.id);
      } catch (otpError) {
        const code = otpError instanceof Error ? otpError.message : 'OTP_SEND_FAILED';
        setError(errorText[code] || code);
      }
    } catch (e) {
      const code = e instanceof Error ? e.message : 'REGISTRATION_FAILED';
      setError(errorText[code] || code);
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp(e: FormEvent) {
    e.preventDefault();
    if (!otpId || !operationId) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otpId, operationId, type: 'BUYER', otp }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'OTP_VERIFY_FAILED');
      setMessage('تم توثيق رقم الجوال وتفعيل الحساب بنجاح.');
      window.setTimeout(() => { window.location.href = '/auth/login?verified=1'; }, 500);
    } catch (e) {
      const code = e instanceof Error ? e.message : 'OTP_VERIFY_FAILED';
      setError(errorText[code] || code);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main dir="rtl" className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-xl">
        <a href="/auth/login" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18} /> تسجيل الدخول</a>
        <section className="rounded-3xl border bg-white p-6 shadow-sm md:p-8">
          <div className="mb-6 flex items-center gap-3">
            <span className="rounded-2xl bg-emerald-50 p-3 text-primary-900"><UserPlus size={26} /></span>
            <div><h1 className="text-2xl font-black">إنشاء حساب</h1><p className="mt-1 text-sm text-slate-500">لن يصبح الحساب نشطاً قبل التحقق من رقم الجوال.</p></div>
          </div>

          {!userId ? (
            <form onSubmit={register} className="space-y-4">
              <input required minLength={3} value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} placeholder="الاسم الكامل" className="w-full rounded-xl border px-4 py-3" />
              <input required minLength={9} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="رقم الجوال" inputMode="tel" className="w-full rounded-xl border px-4 py-3" />
              <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="البريد الإلكتروني (اختياري)" className="w-full rounded-xl border px-4 py-3" />
              <input value={form.nationalId} onChange={e => setForm({ ...form, nationalId: e.target.value })} placeholder="رقم الهوية (اختياري الآن)" className="w-full rounded-xl border px-4 py-3" />
              <label className="block text-sm text-slate-600">تاريخ الميلاد (اختياري)<input type="date" value={form.dateOfBirth} onChange={e => setForm({ ...form, dateOfBirth: e.target.value })} className="mt-2 w-full rounded-xl border px-4 py-3" /></label>
              <input required minLength={8} type="password" autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="كلمة المرور — 8 أحرف على الأقل" className="w-full rounded-xl border px-4 py-3" />
              <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-60"><UserPlus size={19} />{loading ? 'جارٍ إنشاء الحساب...' : 'إنشاء الحساب'}</button>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900"><CheckCircle2 className="mb-2" />تم إنشاء الحساب. أكمل توثيق رقم الجوال لتفعيله.</div>
              {otpId ? (
                <form onSubmit={verifyOtp} className="space-y-3">
                  <input required maxLength={4} pattern="[0-9]{4}" inputMode="numeric" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="رمز التحقق من 4 أرقام" className="w-full rounded-xl border px-4 py-3 text-center text-2xl tracking-[0.4em]" />
                  <button disabled={loading || otp.length !== 4} className="w-full rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-60">{loading ? 'جارٍ التحقق...' : 'تأكيد الرمز وتفعيل الحساب'}</button>
                </form>
              ) : (
                <button disabled={loading} onClick={() => sendOtp(userId).catch(e => setError(errorText[e.message] || e.message))} className="flex w-full items-center justify-center gap-2 rounded-xl border px-5 py-3 font-bold"><Send size={18} />إرسال رمز التحقق</button>
              )}
            </div>
          )}

          {message && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{message}</div>}
          {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        </section>
      </div>
    </main>
  );
}
