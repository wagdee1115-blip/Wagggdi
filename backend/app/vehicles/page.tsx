'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CarFront, FilePlus2, Search } from 'lucide-react';

type Vehicle = {
  id: string;
  plateNumber: string;
  make: string;
  model: string;
  year: number;
  price: string | number;
  city: string;
  status: string;
  isReserved: boolean;
  hasLegalBlock: boolean;
  governmentStatus: string;
  listings: { id: string; status: string; listingType: string }[];
};

const statusText: Record<string, string> = {
  DRAFT: 'مسودة', PENDING: 'قيد المراجعة', ACTIVE: 'نشطة', SOLD: 'مباعة',
  HIDDEN: 'مخفية', REJECTED: 'مرفوضة',
};

export default function Vehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/api/vehicles', { cache: 'no-store', signal: controller.signal });
        const result = await response.json().catch(() => ({ ok: false }));
        if (response.status === 401) { setUnauthorized(true); return; }
        if (!response.ok || !result.ok) throw new Error('VEHICLES_UNAVAILABLE');
        setVehicles(result.vehicles || []);
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError('تعذر تحميل مركباتك الآن. حاول مرة أخرى.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ar');
    if (!needle) return vehicles;
    return vehicles.filter(vehicle => [vehicle.make, vehicle.model, vehicle.plateNumber, String(vehicle.year), vehicle.city]
      .some(value => value.toLocaleLowerCase('ar').includes(needle)));
  }, [query, vehicles]);

  return (
    <main dir="rtl" className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl p-4 md:p-7">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <Link href="/account" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18} />الحساب</Link>
          <Link href="/vehicles/new" className="inline-flex items-center gap-2 rounded-xl bg-primary-900 px-4 py-2.5 font-bold text-white"><FilePlus2 size={18} />إضافة مركبة</Link>
        </div>
        <header className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="flex items-center gap-3"><span className="rounded-2xl bg-emerald-50 p-3 text-primary-900"><CarFront /></span><div><h1 className="text-2xl font-black">مركباتي</h1><p className="text-sm text-slate-500">بياناتك الخاصة لا تظهر في السوق إلا عبر إعلان منشور وآمن.</p></div></div>
        </header>

        {unauthorized ? (
          <section className="mt-5 rounded-2xl border bg-white p-8 text-center"><h2 className="font-black">يلزم تسجيل الدخول</h2><p className="mt-2 text-sm text-slate-500">سجّل الدخول لعرض مركباتك وإدارتها.</p><Link href="/auth/login?next=/vehicles" className="mt-4 inline-block rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تسجيل الدخول</Link></section>
        ) : <>
          <label className="relative mt-5 block"><span className="sr-only">البحث في مركباتي</span><Search className="pointer-events-none absolute right-4 top-3.5 text-slate-400" size={20} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="ابحث بالماركة أو الموديل أو اللوحة…" className="w-full rounded-2xl border bg-white py-3 pe-12 ps-4 outline-none focus:ring-2 focus:ring-emerald-200" /></label>
          {error && <div role="alert" className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800">{error}</div>}
          {loading ? <div role="status" aria-live="polite" className="mt-5 rounded-2xl border bg-white p-8 text-center text-slate-500">جارٍ تحميل مركباتك…</div> : (
            <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filtered.map(vehicle => <article key={vehicle.id} className="rounded-2xl border bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-black">{vehicle.make} {vehicle.model}</h2><p className="mt-1 text-sm text-slate-500">{vehicle.year} · {vehicle.city}</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold">{statusText[vehicle.status] || vehicle.status}</span></div>
                <dl className="mt-4 space-y-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-slate-500">رقم اللوحة</dt><dd className="font-bold">{vehicle.plateNumber}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">القيمة</dt><dd className="font-bold">{Number(vehicle.price).toLocaleString('ar-YE')} ر.ي</dd></div></dl>
                {(vehicle.isReserved || vehicle.hasLegalBlock) && <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{vehicle.hasLegalBlock ? 'توجد قيود قانونية على المركبة.' : 'المركبة محجوزة ضمن عملية حالية.'}</p>}
                {vehicle.listings[0]?.status === 'ACTIVE' && <p className="mt-3 text-xs font-bold text-emerald-700">لها إعلان منشور في السوق</p>}
                <div className="mt-4 flex gap-2 border-t pt-4"><Link href={`/vehicles/${vehicle.id}`} className="flex-1 rounded-xl border px-3 py-2 text-center text-sm font-bold">التفاصيل</Link><Link href={`/vehicles/${vehicle.id}/edit`} className="flex-1 rounded-xl bg-slate-100 px-3 py-2 text-center text-sm font-bold">تعديل</Link></div>
              </article>)}
              {filtered.length === 0 && <div className="rounded-2xl border bg-white p-8 text-center text-slate-500 md:col-span-2 lg:col-span-3">{vehicles.length ? 'لا توجد نتيجة مطابقة.' : 'لم تُضف أي مركبة بعد.'}</div>}
            </div>
          )}
        </>}
      </div>
    </main>
  );
}
