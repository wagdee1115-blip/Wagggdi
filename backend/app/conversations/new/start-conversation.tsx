'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight, LoaderCircle, MessageCircle, ShieldCheck } from 'lucide-react';

const identifierPattern = /^[A-Za-z0-9_-]{8,64}$/;

function startError(code: string) {
  const messages: Record<string, string> = {
    INVALID_INPUT: 'رابط الإعلان غير صالح.',
    LISTING_NOT_FOUND: 'الإعلان غير موجود.',
    LISTING_NOT_AVAILABLE: 'لم يعد الإعلان أو المركبة متاحًا لبدء محادثة.',
    SELLER_UNAVAILABLE: 'البائع غير متاح للمراسلة حاليًا.',
    OWN_LISTING: 'هذا إعلانك؛ لا تحتاج إلى إنشاء محادثة مع نفسك.',
    RATE_LIMITED: 'بدأت عددًا كبيرًا من المحادثات. حاول لاحقًا.',
  };
  return messages[code] || 'تعذر بدء المحادثة الآن. حاول مجددًا.';
}

export default function StartConversation({ listingId }: { listingId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);
  const validListingId = identifierPattern.test(listingId);

  async function start(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validListingId || pending) return;
    setPending(true);
    setError('');
    setUnauthorized(false);
    try {
      const response = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingId }),
      });
      const result = await response.json().catch(() => ({ ok: false, error: 'CONVERSATION_CREATE_FAILED' }));
      if (response.status === 401) {
        setUnauthorized(true);
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'CONVERSATION_CREATE_FAILED');
      router.replace(`/conversations/${result.conversation.id}`);
    } catch (caught) {
      setError(startError(caught instanceof Error ? caught.message : ''));
    } finally {
      setPending(false);
    }
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50 p-4 md:p-7"><div className="mx-auto max-w-xl">
    <Link href={validListingId ? `/market/${listingId}` : '/market'} className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight aria-hidden="true" size={18} />العودة إلى الإعلان</Link>
    <section className="mt-5 rounded-3xl border bg-white p-6 shadow-sm md:p-8">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-primary-900"><MessageCircle aria-hidden="true" size={28} /></span>
      <h1 className="mt-4 text-2xl font-black">بدء محادثة مع البائع</h1>
      <p className="mt-2 text-sm leading-7 text-slate-600">سينشئ النظام محادثة خاصة مرتبطة بهذا الإعلان. إذا كانت هناك محادثة سابقة لنفس المركبة والبائع فسيتم فتحها بدل إنشاء نسخة جديدة.</p>
      <div className="mt-5 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-7 text-emerald-900"><ShieldCheck className="mt-1 shrink-0" aria-hidden="true" size={18} /><p>لا تشارك رقم الهوية أو بيانات البطاقة والحساب. الاتفاق المالي ونقل الملكية يجب أن يكتمل عبر خطوات المنصة فقط.</p></div>

      {!validListingId && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">رابط الإعلان غير صالح. ارجع إلى السوق واختر إعلانًا متاحًا.</div>}
      {error && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
      {unauthorized && <div role="alert" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><p>يلزم تسجيل الدخول قبل بدء محادثة خاصة.</p><Link href={`/auth/login?next=/conversations/new?listingId=${encodeURIComponent(listingId)}`} className="mt-3 inline-block font-bold text-primary-900 underline">تسجيل الدخول والمتابعة</Link></div>}

      <form onSubmit={start} className="mt-6">
        <button disabled={!validListingId || pending} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary-900 px-6 py-3 font-bold text-white disabled:opacity-50">{pending ? <LoaderCircle className="animate-spin" aria-hidden="true" size={19} /> : <MessageCircle aria-hidden="true" size={19} />}{pending ? 'جارٍ فتح المحادثة…' : 'بدء المحادثة'}</button>
      </form>
      <Link href="/conversations" className="mt-4 block text-center text-sm font-bold text-primary-900">عرض محادثاتي</Link>
    </section>
  </div></main>;
}
