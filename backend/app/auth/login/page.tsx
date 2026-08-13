'use client';

import { FormEvent, useState } from 'react';
import { ArrowRight, LogIn, ShieldCheck } from 'lucide-react';

const messages: Record<string, string> = {
  INVALID_INPUT: 'تحقق من رقم الجوال أو البريد وكلمة المرور.',
  INVALID_CREDENTIALS: 'بيانات الدخول غير صحيحة.',
  ACCOUNT_UNAVAILABLE: 'الحساب غير مفعل بعد. أكمل التحقق من رقم الجوال أولاً.',
  RATE_LIMITED: 'محاولات كثيرة. حاول مرة أخرى بعد قليل.',
  LOGIN_FAILED: 'تعذر تسجيل الدخول حالياً.',
};

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim(), password }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'LOGIN_FAILED');
      window.location.href = '/';
    } catch (e) {
      const code = e instanceof Error ? e.message : 'LOGIN_FAILED';
      setError(messages[code] || code);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main dir="rtl" className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-md">
        <a href="/" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-primary-900">
          <ArrowRight size={18} /> الرئيسية
        </a>

        <section className="rounded-3xl border bg-white p-6 shadow-sm md:p-8">
          <div className="mb-6 flex items-center gap-3">
            <span className="rounded-2xl bg-emerald-50 p-3 text-primary-900"><ShieldCheck size={26} /></span>
            <div>
              <h1 className="text-2xl font-black">تسجيل الدخول</h1>
              <p className="mt-1 text-sm text-slate-500">استخدم رقم الجوال أو البريد الإلكتروني.</p>
            </div>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <label className="block text-sm font-bold">
              رقم الجوال أو البريد الإلكتروني
              <input
                required
                autoComplete="username"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                className="mt-2 w-full rounded-xl border px-4 py-3 font-normal outline-none focus:ring-2 focus:ring-emerald-200"
                placeholder="+967... أو name@example.com"
              />
            </label>

            <label className="block text-sm font-bold">
              كلمة المرور
              <input
                required
                minLength={8}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="mt-2 w-full rounded-xl border px-4 py-3 font-normal outline-none focus:ring-2 focus:ring-emerald-200"
                placeholder="••••••••"
              />
            </label>

            {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

            <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-60">
              <LogIn size={19} /> {loading ? 'جارٍ تسجيل الدخول...' : 'دخول'}
            </button>
          </form>

          <div className="mt-6 border-t pt-5 text-center text-sm text-slate-600">
            ليس لديك حساب؟ <a href="/auth/register" className="font-bold text-primary-900">إنشاء حساب</a>
          </div>
        </section>
      </div>
    </main>
  );
}
