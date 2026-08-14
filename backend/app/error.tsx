'use client';

import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main dir="rtl" className="grid min-h-screen place-items-center bg-slate-50 p-6"><section role="alert" className="w-full max-w-lg rounded-3xl border bg-white p-7 text-center shadow-sm"><AlertTriangle className="mx-auto text-amber-600" size={38} /><h1 className="mt-4 text-2xl font-black">حدث خطأ غير متوقع</h1><p className="mt-2 text-sm leading-7 text-slate-500">تعذر عرض هذه الصفحة الآن. جرّب مرة أخرى أو ارجع للرئيسية.</p><div className="mt-5 flex flex-wrap justify-center gap-3"><button onClick={reset} className="inline-flex items-center gap-2 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white"><RotateCcw size={18} />إعادة المحاولة</button><Link href="/" className="rounded-xl border px-5 py-3 font-bold">الرئيسية</Link></div></section></main>;
}

