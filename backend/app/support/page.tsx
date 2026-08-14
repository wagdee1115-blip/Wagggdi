'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Headphones, Plus, Send, X } from 'lucide-react';

type Ticket = {
  id: string; ticketNumber: string; category: string; subject: string; description: string;
  status: string; priority: string; updatedAt: string;
};

const statusText: Record<string, string> = {
  OPEN: 'مفتوحة', IN_PROGRESS: 'قيد المعالجة', WAITING_USER: 'بانتظار ردك', RESOLVED: 'تم الحل', CLOSED: 'مغلقة',
};
const errorText: Record<string, string> = {
  INVALID_INPUT: 'أكمل الحقول المطلوبة وتأكد أن الوصف لا يقل عن 10 أحرف.',
  RATE_LIMITED: 'وصلت إلى الحد المؤقت لرفع التذاكر. حاول لاحقًا.',
};

async function requestTickets(): Promise<Ticket[]> {
  const response = await fetch('/api/support', { cache: 'no-store' });
  const result = await response.json().catch(() => ({ ok: false }));
  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok || !result.ok) throw new Error('SUPPORT_UNAVAILABLE');
  return result.tickets || [];
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ category: 'دعم فني', subject: '', description: '', priority: 'NORMAL' });
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadTickets = useCallback(async () => {
    setError('');
    try {
      setTickets(await requestTickets());
    } catch (caught) {
      if (caught instanceof Error && caught.message === 'UNAUTHORIZED') setUnauthorized(true);
      else setError('تعذر تحميل تذاكر الدعم الآن. حاول مرة أخرى.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    requestTickets()
      .then(result => { if (active) setTickets(result); })
      .catch(caught => {
        if (!active) return;
        if (caught instanceof Error && caught.message === 'UNAUTHORIZED') setUnauthorized(true);
        else setError('تعذر تحميل تذاكر الدعم الآن. حاول مرة أخرى.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/support', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const result = await response.json().catch(() => ({ ok: false }));
      if (!response.ok || !result.ok) throw new Error(result.error || 'SUPPORT_CREATE_FAILED');
      setOpen(false);
      setForm({ category: 'دعم فني', subject: '', description: '', priority: 'NORMAL' });
      setMessage(`تم إنشاء التذكرة ${result.ticket.ticketNumber}.`);
      await loadTickets();
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : 'SUPPORT_CREATE_FAILED';
      setError(errorText[code] || 'تعذر إنشاء التذكرة الآن. حاول مرة أخرى.');
    } finally {
      setPending(false);
    }
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-3xl p-4 md:p-7">
    <div className="mb-6 flex items-center justify-between gap-3"><Link href="/account" className="flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18} />الحساب</Link>{!unauthorized && <button type="button" disabled={loading} onClick={() => setOpen(current => !current)} aria-expanded={open} aria-controls="new-support-ticket" className="flex items-center gap-2 rounded-xl bg-primary-900 px-4 py-2 text-white disabled:cursor-wait disabled:opacity-60">{open ? <X size={18} /> : <Plus size={18} />}{open ? 'إلغاء' : 'رفع تذكرة'}</button>}</div>
    <section className="rounded-3xl bg-primary-900 p-6 text-white"><Headphones size={28} /><h1 className="mt-3 text-2xl font-black">الدعم الفني واتصل بنا</h1><p className="mt-2 text-sm text-slate-200">ارفع تذكرة، اشرح المشكلة، وتابع الردود بأمان من داخل حسابك.</p></section>
    {unauthorized ? <section className="mt-5 rounded-2xl border bg-white p-8 text-center"><h2 className="font-black">يلزم تسجيل الدخول</h2><p className="mt-2 text-sm text-slate-500">تذاكر الدعم خاصة بحسابك ولا يمكن عرضها دون جلسة نشطة.</p><Link href="/auth/login?next=/support" className="mt-4 inline-block rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تسجيل الدخول</Link></section> : <>
      {open && <form id="new-support-ticket" onSubmit={create} className="mt-4 space-y-4 rounded-2xl border bg-white p-5" aria-busy={pending}>
        <h2 className="font-black">تذكرة جديدة</h2>
        <label className="block text-sm font-bold">التصنيف<select value={form.category} onChange={e => setForm(current => ({ ...current, category: e.target.value }))} className="mt-1 w-full rounded-xl border p-3"><option>دعم فني</option><option>مزاد</option><option>نقل ملكية</option><option>دفع ووسيط</option><option>الحساب والأمان</option><option>شكوى</option></select></label>
        <label className="block text-sm font-bold">الأولوية<select value={form.priority} onChange={e => setForm(current => ({ ...current, priority: e.target.value }))} className="mt-1 w-full rounded-xl border p-3"><option value="LOW">منخفضة</option><option value="NORMAL">عادية</option><option value="HIGH">عالية</option><option value="URGENT">عاجلة</option></select></label>
        <label className="block text-sm font-bold">عنوان المشكلة<input required minLength={3} maxLength={160} value={form.subject} onChange={e => setForm(current => ({ ...current, subject: e.target.value }))} className="mt-1 w-full rounded-xl border p-3" /></label>
        <label className="block text-sm font-bold">التفاصيل<textarea required minLength={10} maxLength={5000} value={form.description} onChange={e => setForm(current => ({ ...current, description: e.target.value }))} rows={6} className="mt-1 w-full rounded-xl border p-3" placeholder="اشرح المشكلة والخطوات التي سبقتها…" /></label>
        <button disabled={pending} className="inline-flex items-center gap-2 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-60"><Send size={18} />{pending ? 'جارٍ الإرسال…' : 'إرسال التذكرة'}</button>
      </form>}
      <div aria-live="polite">{message && <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}</div>
      {error && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button type="button" onClick={loadTickets} className="me-3 underline">إعادة التحميل</button></div>}
      <h2 className="mb-3 mt-7 text-xl font-black">تذاكري</h2>
      {loading ? <div role="status" className="rounded-2xl border bg-white p-7 text-center text-slate-500">جارٍ تحميل التذاكر…</div> : tickets.length === 0 ? <div className="rounded-2xl border bg-white p-7 text-center text-slate-500">لا توجد تذاكر حتى الآن.</div> : <div className="space-y-3">{tickets.map(ticket => <Link href={`/support/${ticket.id}`} key={ticket.id} className="block rounded-2xl border bg-white p-4 transition hover:shadow-sm"><div className="flex justify-between gap-3"><b>{ticket.subject}</b><span className="text-xs text-primary-900">{ticket.ticketNumber}</span></div><div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500"><span>{ticket.category}</span><span>·</span><span>{statusText[ticket.status] || ticket.status}</span><span>·</span><time dateTime={ticket.updatedAt}>{new Date(ticket.updatedAt).toLocaleDateString('ar-YE')}</time></div><p className="mt-2 text-sm text-slate-600">{ticket.description.slice(0, 180)}{ticket.description.length > 180 ? '…' : ''}</p></Link>)}</div>}
    </>}
  </div></main>;
}
