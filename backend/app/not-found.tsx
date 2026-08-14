import Link from 'next/link';
import { SearchX } from 'lucide-react';

export default function NotFound() {
  return <main dir="rtl" className="grid min-h-screen place-items-center bg-slate-50 p-6"><section className="w-full max-w-lg rounded-3xl border bg-white p-7 text-center shadow-sm"><SearchX className="mx-auto text-slate-500" size={40} /><h1 className="mt-4 text-2xl font-black">الصفحة غير موجودة</h1><p className="mt-2 text-sm leading-7 text-slate-500">قد يكون الرابط قديمًا، أو أن العنصر لم يعد متاحًا.</p><div className="mt-5 flex flex-wrap justify-center gap-3"><Link href="/market" className="rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تصفح السوق</Link><Link href="/" className="rounded-xl border px-5 py-3 font-bold">الرئيسية</Link></div></section></main>;
}

