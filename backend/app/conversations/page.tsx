'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, CarFront, ChevronLeft, MessageCircle, MessagesSquare } from 'lucide-react';

type ConversationSummary = {
  id: string;
  counterpartName: string;
  vehicle: { make: string; model: string; year: number } | null;
  createdAt: string;
  updatedAt: string;
  unreadCount: number;
  lastMessage: { content: string; createdAt: string; fromMe: boolean } | null;
};

type ConversationPage = {
  conversations: ConversationSummary[];
  nextCursor: string | null;
};

class ConversationRequestError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
}

const timeFormatter = new Intl.DateTimeFormat('ar-YE', { dateStyle: 'medium', timeStyle: 'short' });

async function requestConversations(cursor?: string, signal?: AbortSignal): Promise<ConversationPage> {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`/api/conversations?${query}`, { cache: 'no-store', signal });
  const result = await response.json().catch(() => ({ ok: false, error: 'CONVERSATIONS_UNAVAILABLE' }));
  if (!response.ok || !result.ok) throw new ConversationRequestError(result.error || 'CONVERSATIONS_UNAVAILABLE', response.status);
  return { conversations: result.conversations || [], nextCursor: result.nextCursor || null };
}

function formatTime(value: string) {
  return timeFormatter.format(new Date(value));
}

function errorMessage(code: string) {
  if (code === 'RATE_LIMITED') return 'تم إجراء طلبات كثيرة. انتظر قليلًا ثم أعد المحاولة.';
  return 'تعذر تحميل المحادثات الآن. تحقق من الاتصال ثم أعد المحاولة.';
}

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);

  async function reload() {
    setLoading(true);
    setError('');
    setUnauthorized(false);
    try {
      const page = await requestConversations();
      setConversations(page.conversations);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (caught instanceof ConversationRequestError && caught.status === 401) setUnauthorized(true);
      else setError(errorMessage(caught instanceof ConversationRequestError ? caught.code : ''));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    requestConversations(undefined, controller.signal)
      .then(page => {
        setConversations(page.conversations);
        setNextCursor(page.nextCursor);
      })
      .catch(caught => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (caught instanceof ConversationRequestError && caught.status === 401) setUnauthorized(true);
        else setError(errorMessage(caught instanceof ConversationRequestError ? caught.code : ''));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const page = await requestConversations(nextCursor);
      setConversations(current => {
        const known = new Set(current.map(item => item.id));
        return [...current, ...page.conversations.filter(item => !known.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (caught instanceof ConversationRequestError && caught.status === 401) setUnauthorized(true);
      else setError(errorMessage(caught instanceof ConversationRequestError ? caught.code : ''));
    } finally {
      setLoadingMore(false);
    }
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50 p-4 md:p-7">
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight aria-hidden="true" size={18} />الرئيسية</Link>
        <Link href="/market" className="text-sm font-bold text-primary-900">تصفّح السوق</Link>
      </div>

      <header className="mt-5 rounded-3xl bg-gradient-to-l from-primary-900 to-slate-800 p-6 text-white md:p-8">
        <MessagesSquare aria-hidden="true" size={32} />
        <h1 className="mt-3 text-3xl font-black">المحادثات</h1>
        <p className="mt-2 max-w-xl text-sm leading-7 text-slate-200">تواصل حول الإعلانات من داخل المنصة، وتجنّب مشاركة بيانات حساسة أو تحويل أموال خارج مسار البيع الآمن.</p>
      </header>

      {loading ? <div role="status" aria-live="polite" className="mt-5 rounded-2xl border bg-white p-10 text-center text-slate-500">جارٍ تحميل المحادثات…</div>
        : unauthorized ? <section className="mt-5 rounded-2xl border bg-white p-8 text-center" aria-labelledby="login-title">
          <MessageCircle className="mx-auto text-slate-400" aria-hidden="true" size={36} />
          <h2 id="login-title" className="mt-3 text-xl font-black">سجّل الدخول لعرض محادثاتك</h2>
          <p className="mt-2 text-sm text-slate-500">المحادثات خاصة بأطرافها ولا تظهر للزوار.</p>
          <Link href="/auth/login?next=/conversations" className="mt-5 inline-block rounded-xl bg-primary-900 px-6 py-3 font-bold text-white">تسجيل الدخول</Link>
        </section>
          : <>
            {error && <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><span>{error}</span><button type="button" onClick={reload} className="font-bold underline">إعادة المحاولة</button></div>}
            <section aria-label="قائمة المحادثات" className="mt-5 space-y-3">
              {conversations.map(conversation => <article key={conversation.id} className="rounded-2xl border bg-white shadow-sm transition hover:border-emerald-300">
                <Link href={`/conversations/${conversation.id}`} className="flex items-center gap-4 rounded-2xl p-4 outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 md:p-5">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-primary-900"><MessageCircle aria-hidden="true" size={23} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2"><strong className="truncate text-base">{conversation.counterpartName}</strong>{conversation.unreadCount > 0 && <span className="rounded-full bg-primary-900 px-2 py-0.5 text-xs font-bold text-white" aria-label={`${conversation.unreadCount} رسائل غير مقروءة`}>{conversation.unreadCount.toLocaleString('ar-YE')}</span>}</span>
                    {conversation.vehicle && <span className="mt-1 flex items-center gap-1 text-xs font-bold text-emerald-800"><CarFront aria-hidden="true" size={14} />{conversation.vehicle.make} {conversation.vehicle.model} · {conversation.vehicle.year}</span>}
                    <span className="mt-2 block truncate text-sm text-slate-600">{conversation.lastMessage ? `${conversation.lastMessage.fromMe ? 'أنت: ' : ''}${conversation.lastMessage.content}` : 'ابدأ المحادثة برسالة جديدة'}</span>
                    <time dateTime={conversation.lastMessage?.createdAt || conversation.updatedAt} className="mt-1 block text-xs text-slate-400">{formatTime(conversation.lastMessage?.createdAt || conversation.updatedAt)}</time>
                  </span>
                  <ChevronLeft className="shrink-0 text-slate-400" aria-hidden="true" size={20} />
                </Link>
              </article>)}
              {conversations.length === 0 && !error && <div className="rounded-2xl border bg-white p-10 text-center">
                <MessageCircle className="mx-auto text-slate-300" aria-hidden="true" size={42} />
                <h2 className="mt-3 text-lg font-black">لا توجد محادثات بعد</h2>
                <p className="mt-2 text-sm text-slate-500">افتح إعلانًا متاحًا من السوق ثم اختر «مراسلة البائع».</p>
                <Link href="/market" className="mt-5 inline-block rounded-xl bg-primary-900 px-6 py-3 font-bold text-white">الذهاب إلى السوق</Link>
              </div>}
            </section>
            {nextCursor && <button type="button" disabled={loadingMore} onClick={loadMore} className="mt-5 w-full rounded-xl border bg-white px-5 py-3 font-bold text-primary-900 disabled:opacity-60">{loadingMore ? 'جارٍ تحميل المزيد…' : 'تحميل محادثات أقدم'}</button>}
          </>}
    </div>
  </main>;
}
