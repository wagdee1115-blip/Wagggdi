'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Headphones, RefreshCw } from 'lucide-react';

type Ticket = {
  id: string;
  ticketNumber: string;
  category: string;
  subject: string;
  status: string;
  priority: string;
  updatedAt: string;
  user: { fullName: string };
  _count: { messages: number; attachments: number };
};

const statuses = ['', 'OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED'] as const;
const statusText: Record<string, string> = { OPEN: 'مفتوحة', IN_PROGRESS: 'قيد المعالجة', WAITING_USER: 'بانتظار المستخدم', RESOLVED: 'محلولة', CLOSED: 'مغلقة' };
const priorityText: Record<string, string> = { LOW: 'منخفضة', NORMAL: 'عادية', HIGH: 'عالية', URGENT: 'عاجلة' };

export default function AdminSupportPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const query = status ? `?status=${encodeURIComponent(status)}` : '';
      const response = await fetch(`/api/admin/support${query}`, { signal, cache: 'no-store' });
      const result = await response.json();
      if (response.status === 401) { router.replace('/auth/login?next=/admin/support'); return; }
      if (response.status === 403) { setForbidden(true); setTickets([]); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'SUPPORT_ADMIN_FAILED');
      setForbidden(false);
      setTickets(result.tickets || []);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setError('تعذر تحميل تذاكر الدعم.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [router, status]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-5xl p-4 md:p-7">
    <div className="mb-5 flex items-center justify-between gap-3"><Link href="/account" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>الحساب</Link><button type="button" onClick={() => void load()} disabled={loading} aria-label="تحديث التذاكر" className="rounded-xl border bg-white p-2 disabled:opacity-50"><RefreshCw size={18}/></button></div>
    <div className="flex items-center gap-3"><span className="rounded-2xl bg-emerald-50 p-3 text-primary-900"><Headphones/></span><div><h1 className="text-2xl font-black">إدارة الدعم</h1><p className="text-sm text-slate-500">واجهة الموظفين للرد والمتابعة وتغيير الحالة والأولوية.</p></div></div>
    <label className="mt-5 block max-w-sm text-sm font-bold">تصفية حسب الحالة<select value={status} onChange={event => setStatus(event.target.value)} className="mt-2 w-full rounded-xl border bg-white p-3 font-normal"><option value="">كل الحالات</option>{statuses.filter(Boolean).map(item => <option key={item} value={item}>{statusText[item]}</option>)}</select></label>
    {error && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">{error}</div>}
    {forbidden ? <div role="alert" className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-7 text-center">هذه الصفحة مخصصة لفريق الدعم المخول.</div> : loading ? <div role="status" className="mt-5 rounded-2xl border bg-white p-8 text-center">جارٍ تحميل التذاكر…</div> : <section className="mt-5 space-y-3" aria-label="تذاكر الدعم">
      {tickets.map(ticket => <Link key={ticket.id} href={`/admin/support/${ticket.id}`} className="block rounded-2xl border bg-white p-5 shadow-sm transition hover:shadow-md"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-slate-500">{ticket.ticketNumber} · {ticket.category}</p><h2 className="mt-1 font-black">{ticket.subject}</h2><p className="mt-1 text-sm text-slate-500">{ticket.user.fullName}</p></div><div className="text-left text-xs"><span className="block rounded-full bg-slate-100 px-3 py-1 font-bold">{statusText[ticket.status] || ticket.status}</span><span className="mt-2 block text-slate-500">{priorityText[ticket.priority] || ticket.priority}</span></div></div><p className="mt-3 text-xs text-slate-500">{ticket._count.messages} رسالة · {ticket._count.attachments} مرفق · آخر تحديث {new Date(ticket.updatedAt).toLocaleString('ar-YE')}</p></Link>)}
      {tickets.length === 0 && <div className="rounded-2xl border bg-white p-8 text-center text-slate-500">لا توجد تذاكر ضمن هذا المرشح.</div>}
    </section>}
  </div></main>;
}
