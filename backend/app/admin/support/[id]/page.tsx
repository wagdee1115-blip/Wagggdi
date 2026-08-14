'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ArrowRight, Paperclip, Send } from 'lucide-react';

type Ticket = {
  id: string; ticketNumber: string; category: string; subject: string; description: string;
  status: string; priority: string; createdAt: string; updatedAt: string;
  user: { fullName: string; phoneMasked: string; emailMasked: string | null };
  messages: Array<{ id: string; content: string; isInternal: boolean; createdAt: string; sender: { fullName: string; role: string } }>;
  attachments: Array<{ id: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: string }>;
};

const statuses = ['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED'] as const;
const priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const statusText: Record<string, string> = { OPEN: 'مفتوحة', IN_PROGRESS: 'قيد المعالجة', WAITING_USER: 'بانتظار المستخدم', RESOLVED: 'محلولة', CLOSED: 'مغلقة' };
const priorityText: Record<string, string> = { LOW: 'منخفضة', NORMAL: 'عادية', HIGH: 'عالية', URGENT: 'عاجلة' };

export default function AdminSupportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [content, setContent] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/support?id=${encodeURIComponent(id)}`, { signal, cache: 'no-store' });
      const result = await response.json();
      if (response.status === 401) { router.replace(`/auth/login?next=/admin/support/${id}`); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'SUPPORT_ADMIN_FAILED');
      setTicket(result.ticket);
      setError('');
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      const code = loadError instanceof Error ? loadError.message : '';
      setError(code === 'FORBIDDEN' ? 'لا تملك صلاحية إدارة الدعم.' : code === 'TICKET_NOT_FOUND' ? 'التذكرة غير موجودة.' : 'تعذر تحميل التذكرة.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function reply(event: FormEvent) {
    event.preventDefault();
    if (!ticket) return;
    setPending(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/support', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ticket.id, content, isInternal }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'REPLY_FAILED');
      setContent(''); setIsInternal(false); setNotice(isInternal ? 'أضيفت الملاحظة الداخلية.' : 'أُرسل الرد للمستخدم.');
      await load();
    } catch { setError('تعذر حفظ الرد.'); } finally { setPending(false); }
  }

  async function update(values: { status?: string; priority?: string }) {
    if (!ticket) return;
    setPending(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/support', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ticket.id, ...values }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'UPDATE_FAILED');
      setNotice('تم تحديث التذكرة.'); await load();
    } catch { setError('تعذر تحديث التذكرة.'); } finally { setPending(false); }
  }

  if (loading) return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div role="status" className="mx-auto max-w-4xl rounded-2xl border bg-white p-8 text-center">جارٍ تحميل التذكرة…</div></main>;
  if (!ticket) return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div role="alert" className="mx-auto max-w-3xl rounded-2xl border border-red-200 bg-red-50 p-8 text-center">{error || 'التذكرة غير متاحة.'}<div><Link href="/admin/support" className="mt-4 inline-block font-bold underline">العودة</Link></div></div></main>;

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-5xl p-4 md:p-7">
    <Link href="/admin/support" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>إدارة الدعم</Link>
    <section className="mt-5 rounded-3xl border bg-white p-6"><p className="text-xs text-slate-500">{ticket.ticketNumber} · {ticket.category}</p><h1 className="mt-1 text-2xl font-black">{ticket.subject}</h1><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">{ticket.description}</p><dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">صاحب التذكرة</dt><dd className="font-bold">{ticket.user.fullName}</dd></div><div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">الهاتف</dt><dd dir="ltr" className="font-bold">{ticket.user.phoneMasked}</dd></div><div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">البريد</dt><dd dir="ltr" className="break-all font-bold">{ticket.user.emailMasked || '—'}</dd></div></dl>
      <div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="text-sm font-bold">الحالة<select disabled={pending} value={ticket.status} onChange={event => void update({ status: event.target.value })} className="mt-2 w-full rounded-xl border p-3 font-normal">{statuses.map(value => <option key={value} value={value}>{statusText[value]}</option>)}</select></label><label className="text-sm font-bold">الأولوية<select disabled={pending} value={ticket.priority} onChange={event => void update({ priority: event.target.value })} className="mt-2 w-full rounded-xl border p-3 font-normal">{priorities.map(value => <option key={value} value={value}>{priorityText[value]}</option>)}</select></label></div>
    </section>
    {(error || notice) && <div role={error ? 'alert' : 'status'} aria-live="polite" className={`mt-4 rounded-xl border p-4 ${error ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{error || notice}</div>}
    <section className="mt-5 rounded-2xl border bg-white p-5"><h2 className="text-xl font-black">المحادثة</h2><div className="mt-4 space-y-3">{ticket.messages.map(message => <article key={message.id} className={`rounded-xl border p-4 ${message.isInternal ? 'border-amber-300 bg-amber-50' : 'bg-slate-50'}`}><div className="flex flex-wrap justify-between gap-2 text-xs text-slate-500"><b>{message.sender.fullName} · {message.sender.role}</b><time>{new Date(message.createdAt).toLocaleString('ar-YE')}</time></div>{message.isInternal && <span className="mt-2 inline-block rounded-full bg-amber-200 px-2 py-1 text-xs font-bold">ملاحظة داخلية</span>}<p className="mt-2 whitespace-pre-wrap text-sm leading-7">{message.content}</p></article>)}</div>
      <form onSubmit={reply} className="mt-5 border-t pt-5"><label className="text-sm font-bold">الرد أو الملاحظة<textarea required minLength={1} maxLength={5000} value={content} onChange={event => setContent(event.target.value)} className="mt-2 min-h-28 w-full rounded-xl border p-3 font-normal"/></label><label className="mt-3 flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={isInternal} onChange={event => setIsInternal(event.target.checked)}/>ملاحظة داخلية لا تظهر للمستخدم</label><button disabled={pending || !content.trim()} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50"><Send size={18}/>{pending ? 'جارٍ الحفظ…' : isInternal ? 'حفظ الملاحظة' : 'إرسال الرد'}</button></form>
    </section>
    <section className="mt-5 rounded-2xl border bg-white p-5"><h2 className="flex items-center gap-2 text-xl font-black"><Paperclip size={20}/>المرفقات</h2><div className="mt-3 space-y-2">{ticket.attachments.map(file => <div key={file.id} className="rounded-xl bg-slate-50 p-3 text-sm"><b>{file.fileName}</b><p className="mt-1 text-xs text-slate-500">{file.mimeType} · {(file.sizeBytes / 1024).toFixed(1)} KB · {new Date(file.createdAt).toLocaleString('ar-YE')}</p></div>)}{ticket.attachments.length === 0 && <p className="text-sm text-slate-500">لا توجد مرفقات.</p>}</div><p className="mt-3 text-xs leading-6 text-slate-500">تظهر البيانات الوصفية فقط؛ لا تُكشف مفاتيح التخزين أو البصمات أو هوية الرافع.</p></section>
  </div></main>;
}
