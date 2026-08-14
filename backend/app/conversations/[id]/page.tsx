'use client';

import Link from 'next/link';
import { use, useEffect, useRef, useState } from 'react';
import { ArrowRight, CarFront, LoaderCircle, Send, ShieldCheck } from 'lucide-react';

type ConversationMessage = { id: string; content: string; createdAt: string; fromMe: boolean };
type ConversationHeader = {
  id: string;
  counterpartName: string;
  vehicle: { make: string; model: string; year: number } | null;
};
type MessagePage = { conversation: ConversationHeader; messages: ConversationMessage[]; nextCursor: string | null };

class MessageRequestError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
}

const timeFormatter = new Intl.DateTimeFormat('ar-YE', { dateStyle: 'medium', timeStyle: 'short' });

async function requestMessages(id: string, cursor?: string, signal?: AbortSignal): Promise<MessagePage> {
  const query = new URLSearchParams({ limit: '30' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`/api/conversations/${id}/messages?${query}`, { cache: 'no-store', signal });
  const result = await response.json().catch(() => ({ ok: false, error: 'MESSAGES_UNAVAILABLE' }));
  if (!response.ok || !result.ok) throw new MessageRequestError(result.error || 'MESSAGES_UNAVAILABLE', response.status);
  return { conversation: result.conversation, messages: result.messages || [], nextCursor: result.nextCursor || null };
}

function friendlyError(error: unknown) {
  if (error instanceof MessageRequestError) {
    if (error.status === 401) return 'UNAUTHORIZED';
    if (error.status === 404) return 'المحادثة غير موجودة أو لا تملك صلاحية عرضها.';
    if (error.code === 'RATE_LIMITED') return 'تم إجراء طلبات كثيرة. انتظر قليلًا ثم أعد المحاولة.';
  }
  return 'تعذر تحميل المحادثة الآن. تحقق من الاتصال ثم أعد المحاولة.';
}

function formatTime(value: string) {
  return timeFormatter.format(new Date(value));
}

function mergeMessages(first: ConversationMessage[], second: ConversationMessage[]) {
  const byId = new Map<string, ConversationMessage>();
  for (const item of [...first, ...second]) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
}

export default function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [conversation, setConversation] = useState<ConversationHeader | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [fatalError, setFatalError] = useState('');
  const [notice, setNotice] = useState('');
  const messageList = useRef<HTMLOListElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const initialScrollDone = useRef(false);

  function markRead() {
    void fetch(`/api/conversations/${id}/messages`, { method: 'PATCH', cache: 'no-store' });
  }

  async function reload() {
    setLoading(true);
    setFatalError('');
    try {
      const page = await requestMessages(id);
      setConversation(page.conversation);
      setMessages(page.messages);
      setNextCursor(page.nextCursor);
      initialScrollDone.current = false;
      markRead();
    } catch (caught) {
      setFatalError(friendlyError(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    requestMessages(id, undefined, controller.signal)
      .then(page => {
        setConversation(page.conversation);
        setMessages(page.messages);
        setNextCursor(page.nextCursor);
        void fetch(`/api/conversations/${id}/messages`, { method: 'PATCH', cache: 'no-store', signal: controller.signal }).catch(() => undefined);
      })
      .catch(caught => {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) setFatalError(friendlyError(caught));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id]);

  useEffect(() => {
    if (!loading && messages.length && !initialScrollDone.current && messageList.current) {
      messageList.current.scrollTop = messageList.current.scrollHeight;
      initialScrollDone.current = true;
    }
  }, [loading, messages.length]);

  async function loadOlder() {
    if (!nextCursor || loadingOlder || !messageList.current) return;
    const list = messageList.current;
    const previousHeight = list.scrollHeight;
    setLoadingOlder(true);
    setNotice('');
    try {
      const page = await requestMessages(id, nextCursor);
      setMessages(current => mergeMessages(page.messages, current));
      setNextCursor(page.nextCursor);
      requestAnimationFrame(() => {
        if (messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight - previousHeight;
      });
    } catch (caught) {
      setNotice(friendlyError(caught) === 'UNAUTHORIZED' ? 'انتهت الجلسة. سجّل الدخول مجددًا.' : String(friendlyError(caught)));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = content.trim();
    if (!normalized || sending) return;
    setSending(true);
    setNotice('');
    try {
      const response = await fetch(`/api/conversations/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: normalized }),
      });
      const result = await response.json().catch(() => ({ ok: false, error: 'MESSAGE_SEND_FAILED' }));
      if (!response.ok || !result.ok) throw new MessageRequestError(result.error || 'MESSAGE_SEND_FAILED', response.status);
      setMessages(current => mergeMessages(current, [result.message]));
      setContent('');
      requestAnimationFrame(() => {
        if (messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight;
        composer.current?.focus();
      });
    } catch (caught) {
      if (caught instanceof MessageRequestError && caught.status === 401) setNotice('انتهت الجلسة. سجّل الدخول مجددًا.');
      else if (caught instanceof MessageRequestError && caught.code === 'RATE_LIMITED') setNotice('أرسلت عددًا كبيرًا من الرسائل. انتظر قليلًا ثم حاول مجددًا.');
      else if (caught instanceof MessageRequestError && caught.code === 'CONVERSATION_UNAVAILABLE') setNotice('لا يمكن إرسال رسائل جديدة لأن الطرف الآخر غير متاح حاليًا.');
      else if (caught instanceof MessageRequestError && ['INVALID_INPUT', 'PAYLOAD_TOO_LARGE'].includes(caught.code)) setNotice('الرسالة فارغة أو أطول من الحد المسموح.');
      else setNotice('تعذر إرسال الرسالة الآن. لم تُحذف مسودتك؛ حاول مجددًا.');
    } finally {
      setSending(false);
    }
  }

  if (loading) return <main dir="rtl" className="min-h-screen bg-slate-50 p-4 md:p-7"><div role="status" aria-live="polite" className="mx-auto max-w-3xl rounded-2xl border bg-white p-10 text-center text-slate-500">جارٍ تحميل المحادثة…</div></main>;
  if (fatalError) return <main dir="rtl" className="min-h-screen bg-slate-50 p-4 md:p-7"><section className="mx-auto max-w-xl rounded-2xl border bg-white p-8 text-center" role="alert"><h1 className="text-xl font-black">تعذر فتح المحادثة</h1><p className="mt-2 text-sm text-slate-600">{fatalError === 'UNAUTHORIZED' ? 'سجّل الدخول للوصول إلى محادثاتك الخاصة.' : fatalError}</p><div className="mt-5 flex flex-wrap justify-center gap-3">{fatalError === 'UNAUTHORIZED' ? <Link href={`/auth/login?next=/conversations/${id}`} className="rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تسجيل الدخول</Link> : <button type="button" onClick={reload} className="rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">إعادة المحاولة</button>}<Link href="/conversations" className="rounded-xl border px-5 py-3 font-bold">المحادثات</Link></div></section></main>;

  return <main dir="rtl" className="min-h-screen bg-slate-50 p-4 md:p-7">
    <div className="mx-auto max-w-3xl">
      <Link href="/conversations" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight aria-hidden="true" size={18} />المحادثات</Link>
      <header className="mt-4 rounded-2xl border bg-white p-4 shadow-sm md:p-5">
        <h1 className="text-xl font-black">{conversation?.counterpartName || 'محادثة'}</h1>
        {conversation?.vehicle && <p className="mt-2 flex items-center gap-2 text-sm font-bold text-emerald-800"><CarFront aria-hidden="true" size={17} />{conversation.vehicle.make} {conversation.vehicle.model} · {conversation.vehicle.year}</p>}
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-emerald-50 p-3 text-xs leading-6 text-emerald-900"><ShieldCheck className="mt-0.5 shrink-0" aria-hidden="true" size={16} />لا ترسل رقم الهوية أو بيانات الدفع في الرسائل، ولا تحوّل أي مبلغ خارج خطوات البيع داخل المنصة.</p>
      </header>

      {nextCursor && <button type="button" onClick={loadOlder} disabled={loadingOlder} className="mt-4 w-full rounded-xl border bg-white px-4 py-2.5 text-sm font-bold text-primary-900 disabled:opacity-60">{loadingOlder ? 'جارٍ تحميل الرسائل الأقدم…' : 'تحميل رسائل أقدم'}</button>}
      <ol ref={messageList} role="log" aria-live="polite" aria-relevant="additions" aria-label="رسائل المحادثة" className="mt-4 max-h-[55vh] min-h-72 space-y-3 overflow-y-auto rounded-2xl border bg-slate-100 p-3 md:p-5">
        {messages.map(message => <li key={message.id} className={`flex ${message.fromMe ? 'justify-start' : 'justify-end'}`}>
          <article className={`max-w-[88%] rounded-2xl px-4 py-3 shadow-sm md:max-w-[75%] ${message.fromMe ? 'rounded-tr-sm bg-primary-900 text-white' : 'rounded-tl-sm border bg-white text-slate-900'}`}>
            <span className="sr-only">{message.fromMe ? 'أنت' : conversation?.counterpartName || 'الطرف الآخر'}: </span>
            <p className="whitespace-pre-wrap break-words text-sm leading-7">{message.content}</p>
            <time dateTime={message.createdAt} className={`mt-1 block text-[11px] ${message.fromMe ? 'text-emerald-100' : 'text-slate-400'}`}>{formatTime(message.createdAt)}</time>
          </article>
        </li>)}
        {messages.length === 0 && <li className="grid min-h-64 place-items-center text-center text-sm text-slate-500">لا توجد رسائل بعد. ابدأ بتحية قصيرة واستفسر عن المركبة دون مشاركة بيانات حساسة.</li>}
      </ol>

      {notice && <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{notice}{notice.includes('سجّل الدخول') && <Link href={`/auth/login?next=/conversations/${id}`} className="me-2 font-bold underline">تسجيل الدخول</Link>}</div>}
      <form onSubmit={sendMessage} className="mt-3 rounded-2xl border bg-white p-3 shadow-sm" aria-label="إرسال رسالة">
        <label htmlFor="message-content" className="sr-only">نص الرسالة</label>
        <textarea ref={composer} id="message-content" required rows={3} maxLength={2000} value={content} onChange={event => setContent(event.target.value)} aria-describedby="message-help message-count" placeholder="اكتب رسالتك…" className="w-full resize-y rounded-xl border p-3 text-sm leading-7 outline-none focus:ring-2 focus:ring-emerald-200" />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-500"><span id="message-help">الحد الأقصى 2000 حرف.</span> <span id="message-count" aria-live="polite">{content.length.toLocaleString('ar-YE')} / ٢٠٠٠</span></div>
          <button disabled={sending || !content.trim()} className="inline-flex items-center gap-2 rounded-xl bg-primary-900 px-5 py-2.5 font-bold text-white disabled:opacity-50">{sending ? <LoaderCircle className="animate-spin" aria-hidden="true" size={18} /> : <Send aria-hidden="true" size={18} />}{sending ? 'جارٍ الإرسال…' : 'إرسال'}</button>
        </div>
      </form>
    </div>
  </main>;
}
