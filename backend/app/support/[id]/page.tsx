'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Send } from 'lucide-react';

type Ticket = {
  id: string; ticketNumber: string; subject: string; category: string; status: string; createdAt: string;
  messages: { id: string; content: string; createdAt: string }[];
  attachments: { id: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: string }[];
};

const statusText: Record<string, string> = { OPEN: 'مفتوحة', IN_PROGRESS: 'قيد المعالجة', WAITING_USER: 'بانتظار ردك', RESOLVED: 'تم الحل', CLOSED: 'مغلقة' };

async function requestTicket(id: string): Promise<Ticket> {
  const response = await fetch(`/api/support/${id}`, { cache: 'no-store' });
  const result = await response.json().catch(() => ({ ok: false }));
  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (response.status === 404) throw new Error('NOT_FOUND');
  if (!response.ok || !result.ok) throw new Error('SUPPORT_UNAVAILABLE');
  return result.ticket;
}

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [uploadPending, setUploadPending] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setTicket(await requestTicket(id));
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : '';
      setError(code === 'UNAUTHORIZED' ? 'سجّل الدخول لعرض هذه التذكرة.' : code === 'NOT_FOUND' ? 'التذكرة غير موجودة أو لا تملك صلاحية عرضها.' : 'تعذر تحميل التذكرة الآن.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    let active = true;
    requestTicket(id)
      .then(result => { if (active) setTicket(result); })
      .catch(caught => {
        if (!active) return;
        const code = caught instanceof Error ? caught.message : '';
        setError(code === 'UNAUTHORIZED' ? 'سجّل الدخول لعرض هذه التذكرة.' : code === 'NOT_FOUND' ? 'التذكرة غير موجودة أو لا تملك صلاحية عرضها.' : 'تعذر تحميل التذكرة الآن.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || pending) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/support/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message.trim() }) });
      const result = await response.json().catch(() => ({ ok: false }));
      if (!response.ok || !result.ok) {
        if (result.error === 'TICKET_CLOSED') throw new Error('لا يمكن الرد لأن التذكرة مغلقة.');
        if (result.error === 'RATE_LIMITED') throw new Error('أرسلت عددًا كبيرًا من الردود. حاول لاحقًا.');
        throw new Error('تعذر إرسال الرد الآن.');
      }
      setMessage('');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر إرسال الرد الآن.');
    } finally {
      setPending(false);
    }
  }

  async function uploadAttachment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile || uploadPending) return;
    setUploadPending(true);
    setError('');
    try {
      const form = new FormData();
      form.set('file', selectedFile);
      const response = await fetch(`/api/support/${id}/attachments`, { method: 'POST', body: form });
      const result = await response.json().catch(() => ({ ok: false }));
      if (!response.ok || !result.ok) {
        const messages: Record<string, string> = {
          'NOT_CONFIGURED:STORAGE_PROVIDER_REQUIRED': 'خدمة حفظ المرفقات غير مفعلة حاليًا.',
          FILE_SIZE_LIMIT: 'حجم الملف يجب ألا يتجاوز 10 ميجابايت.',
          FILE_TYPE_NOT_ALLOWED: 'يُسمح بصور JPG وPNG وWebP أو ملف PDF فقط.',
          FILE_MAGIC_BYTES_INVALID: 'محتوى الملف لا يطابق نوعه.',
          TICKET_CLOSED: 'لا يمكن الإرفاق بعد إغلاق التذكرة.',
          RATE_LIMITED: 'وصلت إلى الحد المؤقت لرفع المرفقات.',
        };
        throw new Error(messages[result.error] || 'تعذر رفع المرفق الآن.');
      }
      setSelectedFile(null);
      if (fileInput.current) fileInput.current.value = '';
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر رفع المرفق الآن.');
    } finally {
      setUploadPending(false);
    }
  }

  const closed = ticket ? ['CLOSED', 'RESOLVED'].includes(ticket.status) : false;
  return <main dir="rtl" className="min-h-screen bg-slate-50 p-4 md:p-7"><div className="mx-auto max-w-2xl">
    <Link href="/support" className="inline-flex items-center gap-2 font-bold text-primary-900"><ArrowRight size={18} />الدعم</Link>
    {loading ? <div role="status" className="mt-5 rounded-2xl border bg-white p-8 text-center text-slate-500">جارٍ تحميل التذكرة…</div> : error && !ticket ? <div role="alert" className="mt-5 rounded-2xl border bg-white p-8 text-center"><p>{error}</p><button onClick={load} className="mt-3 font-bold text-primary-900 underline">إعادة المحاولة</button></div> : ticket && <>
      <header className="mt-5 rounded-2xl border bg-white p-5"><h1 className="text-xl font-black">{ticket.subject}</h1><p className="mt-1 text-sm text-slate-500">{ticket.ticketNumber} · {statusText[ticket.status] || ticket.status}</p></header>
      <section aria-label="محادثة التذكرة" className="my-4 space-y-3">{ticket.messages.map(item => <article key={item.id} className="rounded-2xl border bg-white p-4"><p className="whitespace-pre-wrap leading-7">{item.content}</p><time dateTime={item.createdAt} className="mt-2 block text-xs text-slate-400">{new Date(item.createdAt).toLocaleString('ar-YE')}</time></article>)}{ticket.messages.length === 0 && <p className="rounded-2xl border bg-white p-6 text-center text-slate-500">لا توجد رسائل ظاهرة في هذه التذكرة.</p>}</section>
      {ticket.attachments.length > 0 && <section className="mb-4 rounded-2xl border bg-white p-4" aria-labelledby="attachments-title"><h2 id="attachments-title" className="font-black">المرفقات</h2><ul className="mt-3 space-y-2">{ticket.attachments.map(item => <li key={item.id} className="flex flex-wrap justify-between gap-2 rounded-xl bg-slate-50 p-3 text-sm"><span className="break-all font-bold">{item.fileName}</span><span className="text-slate-500">{(item.sizeBytes / 1024).toLocaleString('ar-YE', { maximumFractionDigits: 1 })} ك.ب</span></li>)}</ul></section>}
      {error && <div role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      {closed ? <p className="rounded-xl border bg-slate-100 p-4 text-sm text-slate-600">هذه التذكرة {ticket.status === 'RESOLVED' ? 'تم حلها' : 'مغلقة'} ولا تستقبل ردودًا جديدة.</p> : <div className="space-y-4"><form onSubmit={send} className="flex items-end gap-2"><label className="flex-1 text-sm font-bold">إضافة رد<textarea required rows={3} maxLength={5000} value={message} onChange={e => setMessage(e.target.value)} className="mt-1 w-full rounded-xl border p-3" placeholder="اكتب ردك…" /></label><button disabled={pending || !message.trim()} aria-label="إرسال الرد" className="mb-0.5 grid h-12 w-12 place-items-center rounded-xl bg-primary-900 text-white disabled:opacity-50"><Send size={19} /></button></form><form onSubmit={uploadAttachment} className="rounded-xl border bg-white p-4"><label className="block text-sm font-bold">إرفاق صورة أو PDF<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event => setSelectedFile(event.target.files?.[0] || null)} className="mt-2 block w-full text-sm" /></label><p className="mt-2 text-xs text-slate-500">الحد الأقصى 10 ميجابايت، ويُفحص الملف قبل حفظه.</p><button disabled={!selectedFile || uploadPending} className="mt-3 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50">{uploadPending ? 'جارٍ الرفع…' : 'رفع المرفق'}</button></form></div>}
    </>}
  </div></main>;
}
