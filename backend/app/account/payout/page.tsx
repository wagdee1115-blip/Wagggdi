'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ArrowRight, Landmark, ShieldCheck } from 'lucide-react';

type PayoutAccount = {
  id: string;
  provider: string;
  accountIdentifierMasked: string;
  accountHolderName: string;
  verified: boolean;
  nameMatchStatus: string;
  createdAt: string;
};

const errors: Record<string, string> = {
  UNAUTHORIZED: 'سجّل الدخول أولاً.',
  INVALID_INPUT: 'تحقق من بيانات الحساب.',
  PHONE_NOT_VERIFIED: 'وثّق رقم الهاتف قبل إضافة حساب الاستلام.',
  IDENTITY_NOT_VERIFIED: 'وثّق الهوية والرقم الوطني قبل إضافة حساب الاستلام.',
  PAYOUT_ACCOUNT_NOT_VERIFIED: 'لم يؤكد المزود صحة الحساب.',
  PAYOUT_PROVIDER_REFERENCE_REPLAY: 'رفض النظام مرجع تحقق سبق ربطه بحساب آخر. تواصل مع الدعم ولا تعِد المحاولة بنفس المرجع.',
  BANK_PROVIDER_FAILED: 'تعذر الاتصال بمزود التحقق البنكي.',
  BANK_PROVIDER_UNAVAILABLE: 'مزود التحقق البنكي غير متاح حاليًا.',
  BANK_PROVIDER_RESPONSE_INVALID: 'أعاد مزود التحقق البنكي استجابة غير صالحة؛ لم يُحفظ الحساب.',
  'NOT_CONFIGURED:BANK_PROVIDER_REQUIRED': 'مزود التحقق البنكي غير مربوط بعد؛ لن نخزّن حسابًا غير موثق.',
  'NOT_CONFIGURED:PAYOUT_ENCRYPTION_KEY_REQUIRED': 'تشفير بيانات حسابات الاستلام غير مهيأ على الخادم.',
};

export default function PayoutAccountsPage() {
  const [accounts, setAccounts] = useState<PayoutAccount[]>([]);
  const [form, setForm] = useState({ provider: '', accountIdentifier: '', accountHolderName: '' });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/payout-accounts', { signal });
      const result = await response.json();
      if (response.status === 401) {
        window.location.replace('/auth/login?next=/account/payout');
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'PAYOUT_ACCOUNTS_FAILED');
      setAccounts(result.accounts || []);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      const code = loadError instanceof Error ? loadError.message : 'PAYOUT_ACCOUNTS_FAILED';
      setError(errors[code] || 'تعذر تحميل حسابات الاستلام.');
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
      const response = await fetch('/api/payout-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'PAYOUT_ACCOUNT_FAILED');
      setForm({ provider: '', accountIdentifier: '', accountHolderName: '' });
      setNotice(result.account.verified ? 'تم التحقق من الحساب وربطه باسمك.' : 'تمت مراجعة الحساب، لكن الاسم لا يطابق اسم الهوية ولن يُستخدم للصرف.');
      await load();
    } catch (submitError) {
      const code = submitError instanceof Error ? submitError.message : 'PAYOUT_ACCOUNT_FAILED';
      setError(errors[code] || code);
    } finally {
      setSubmitting(false);
    }
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-3xl p-4 md:p-7">
    <Link href="/account" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>الحساب</Link>
    <section className="rounded-3xl border bg-white p-6 shadow-sm">
      <div className="flex items-center gap-3"><span className="rounded-2xl bg-emerald-50 p-3 text-primary-900"><Landmark/></span><div><h1 className="text-2xl font-black">حسابات الاستلام</h1><p className="mt-1 text-sm text-slate-500">لا يمكن بدء بيع أو مزاد قبل حساب موثق مطابق لاسم الهوية.</p></div></div>
      <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-7 text-blue-900"><ShieldCheck className="mb-2"/>يُرسل رقم الحساب مباشرة إلى مزود التحقق عبر اتصال الخادم، ثم يُخزّن مشفرًا ولا تعيده الواجهة أبدًا.</div>
      <form onSubmit={submit} className="mt-6 grid gap-4 md:grid-cols-2">
        <label className="text-sm font-bold">البنك أو مزود المحفظة<input required value={form.provider} onChange={event => setForm({ ...form, provider: event.target.value })} autoComplete="organization" className="mt-2 w-full rounded-xl border p-3 font-normal" placeholder="اسم البنك"/></label>
        <label className="text-sm font-bold">اسم صاحب الحساب<input required value={form.accountHolderName} onChange={event => setForm({ ...form, accountHolderName: event.target.value })} autoComplete="name" className="mt-2 w-full rounded-xl border p-3 font-normal" placeholder="كما يظهر لدى البنك"/></label>
        <label className="text-sm font-bold md:col-span-2">رقم الحساب أو المحفظة<input required value={form.accountIdentifier} onChange={event => setForm({ ...form, accountIdentifier: event.target.value })} autoComplete="off" className="mt-2 w-full rounded-xl border p-3 font-normal" dir="ltr"/></label>
        <button disabled={submitting} className="rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50 md:col-span-2">{submitting ? 'جارٍ التحقق…' : 'تحقق واحفظ الحساب'}</button>
      </form>
      {(error || notice) && <div role={error ? 'alert' : 'status'} aria-live="polite" className={`mt-4 rounded-xl border p-3 text-sm ${error ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{error || notice}</div>}
    </section>
    <section className="mt-5"><h2 className="text-xl font-black">الحسابات المضافة</h2>{loading ? <div role="status" className="mt-3 rounded-2xl border bg-white p-6 text-center">جارٍ التحميل…</div> : <div className="mt-3 space-y-3">{accounts.map(account => <article key={account.id} className="rounded-2xl border bg-white p-5"><div className="flex items-start justify-between gap-4"><div><h3 className="font-black">{account.provider}</h3><p className="mt-1 text-sm text-slate-600" dir="ltr">{account.accountIdentifierMasked}</p><p className="mt-1 text-sm text-slate-500">{account.accountHolderName}</p></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${account.verified ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{account.verified ? 'موثق ومطابق' : account.nameMatchStatus === 'MISMATCH' ? 'الاسم غير مطابق' : 'قيد التحقق'}</span></div></article>)}{accounts.length === 0 && <div className="rounded-2xl border bg-white p-6 text-center text-slate-500">لم تضف حساب استلام بعد.</div>}</div>}</section>
  </div></main>;
}
