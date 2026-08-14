'use client';

import Link from 'next/link';

export default function ConversationsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main dir="rtl" className="min-h-screen bg-slate-50 p-4 md:p-7"><section role="alert" className="mx-auto max-w-xl rounded-2xl border bg-white p-8 text-center"><h1 className="text-xl font-black">حدث خطأ أثناء فتح المحادثات</h1><p className="mt-2 text-sm text-slate-600">لم تُرسل أو تُحذف أي رسالة. أعد المحاولة أو ارجع إلى السوق.</p><div className="mt-5 flex flex-wrap justify-center gap-3"><button type="button" onClick={reset} className="rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">إعادة المحاولة</button><Link href="/market" className="rounded-xl border px-5 py-3 font-bold">السوق</Link></div></section></main>;
}
