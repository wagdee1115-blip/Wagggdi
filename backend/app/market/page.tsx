'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CarFront, Search, ShieldCheck } from 'lucide-react';

type PublicListing = {
  id: string;
  listingType: string;
  publicationStatus: 'PUBLISHED';
  price: string;
  currency: string;
  description?: string | null;
  publishedAt: string;
  vehicle: { make: string; model: string; year: number; mileage: number; transmission: string; fuelType: string; color: string; city: string };
};

type MarketFilters = { q: string; city: string; year: string };

async function requestListings(filters: MarketFilters): Promise<PublicListing[]> {
  const query = new URLSearchParams();
  if (filters.q.trim()) query.set('q', filters.q.trim());
  if (filters.city.trim()) query.set('city', filters.city.trim());
  if (filters.year.trim()) query.set('year', filters.year.trim());
  const response = await fetch(`/api/listings?${query}`, { cache: 'no-store' });
  const result = await response.json().catch(() => ({ ok: false }));
  if (!response.ok || !result.ok) throw new Error(result.error || 'LISTINGS_UNAVAILABLE');
  return result.listings || [];
}

const listingTypeText: Record<string, string> = { DIRECT: 'بيع مباشر', MARKET: 'السوق', EXHIBITION: 'معرض' };

export default function MarketPage() {
  const [listings, setListings] = useState<PublicListing[]>([]);
  const [filters, setFilters] = useState({ q: '', city: '', year: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);

  async function load(nextFilters = filters) {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await requestListings(nextFilters);
      if (requestId === requestSequence.current) setListings(result);
    } catch {
      if (requestId === requestSequence.current) setError('تعذر تحميل السوق الآن. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    const requestId = ++requestSequence.current;
    requestListings({ q: '', city: '', year: '' })
      .then(result => { if (active && requestId === requestSequence.current) setListings(result); })
      .catch(() => { if (active && requestId === requestSequence.current) setError('تعذر تحميل السوق الآن. تحقق من الاتصال ثم أعد المحاولة.'); })
      .finally(() => { if (active && requestId === requestSequence.current) setLoading(false); });
    return () => { active = false; };
  }, []);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    load();
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-6xl p-4 md:p-7">
    <div className="mb-6 flex items-center justify-between gap-3"><Link href="/" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18} />الرئيسية</Link><Link href="/vehicles" className="text-sm font-bold text-primary-900">مركباتي</Link></div>
    <section className="rounded-3xl bg-gradient-to-l from-primary-900 to-slate-800 p-6 text-white md:p-8"><CarFront size={32} /><h1 className="mt-3 text-3xl font-black">سوق المركبات</h1><p className="mt-2 max-w-2xl text-sm leading-7 text-slate-200">إعلانات المركبات المتاحة فقط. نحجب أرقام اللوحات والهياكل وهوية المالك من العرض العام.</p></section>
    <form onSubmit={submit} className="mt-5 grid gap-3 rounded-2xl border bg-white p-4 md:grid-cols-[1fr_220px_150px_auto]" role="search">
      <label><span className="mb-1 block text-xs font-bold text-slate-600">الماركة أو الموديل</span><input value={filters.q} onChange={e => setFilters(current => ({ ...current, q: e.target.value }))} maxLength={80} placeholder="مثال: تويوتا" className="w-full rounded-xl border p-3 outline-none focus:ring-2 focus:ring-emerald-200" /></label>
      <label><span className="mb-1 block text-xs font-bold text-slate-600">المدينة</span><input value={filters.city} onChange={e => setFilters(current => ({ ...current, city: e.target.value }))} maxLength={60} placeholder="صنعاء" className="w-full rounded-xl border p-3 outline-none focus:ring-2 focus:ring-emerald-200" /></label>
      <label><span className="mb-1 block text-xs font-bold text-slate-600">السنة</span><input value={filters.year} onChange={e => setFilters(current => ({ ...current, year: e.target.value }))} type="number" min="1980" max="2100" inputMode="numeric" className="w-full rounded-xl border p-3 outline-none focus:ring-2 focus:ring-emerald-200" /></label>
      <button disabled={loading} className="mt-auto inline-flex h-[50px] items-center justify-center gap-2 rounded-xl bg-primary-900 px-5 font-bold text-white disabled:opacity-60"><Search size={18} />بحث</button>
    </form>
    <div className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"><ShieldCheck className="mt-0.5 shrink-0" size={18} /><p>تختفي المركبة تلقائيًا من هذا السوق عند حجزها أو وجود قيد عليها. ظهور الإعلان لا يغني عن خطوات التحقق ونقل الملكية الآمنة.</p></div>
    {error && <div role="alert" className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800">{error}<button onClick={() => load()} className="me-3 underline">إعادة المحاولة</button></div>}
    {loading ? <div role="status" aria-live="polite" className="mt-5 rounded-2xl border bg-white p-10 text-center text-slate-500">جارٍ تحميل الإعلانات…</div> : <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {listings.map(listing => <article key={listing.id} className="flex flex-col rounded-2xl border bg-white p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-emerald-700">{listingTypeText[listing.listingType] || 'إعلان'}</p><h2 className="mt-1 text-xl font-black">{listing.vehicle.make} {listing.vehicle.model}</h2><p className="mt-1 text-sm text-slate-500">{listing.vehicle.year} · {listing.vehicle.city} · {listing.vehicle.color}</p></div><span className="rounded-2xl bg-slate-100 p-3 text-primary-900"><CarFront /></span></div><dl className="mt-4 grid grid-cols-2 gap-2 text-sm"><div className="rounded-xl bg-slate-50 p-3"><dt className="text-xs text-slate-500">المسافة</dt><dd className="mt-1 font-bold">{listing.vehicle.mileage.toLocaleString('ar-YE')} كم</dd></div><div className="rounded-xl bg-slate-50 p-3"><dt className="text-xs text-slate-500">السعر</dt><dd className="mt-1 font-bold">{Number(listing.price).toLocaleString('ar-YE')} ر.ي</dd></div></dl>{listing.description && <p className="mt-3 flex-1 text-sm leading-6 text-slate-600">{listing.description.slice(0, 150)}{listing.description.length > 150 ? '…' : ''}</p>}<Link href={`/market/${listing.id}?source=IN_APP_SEARCH`} className="mt-4 rounded-xl bg-primary-900 px-4 py-3 text-center font-bold text-white" aria-label={`عرض تفاصيل ${listing.vehicle.make} ${listing.vehicle.model}`}>عرض التفاصيل</Link></article>)}
      {listings.length === 0 && <div className="rounded-2xl border bg-white p-10 text-center text-slate-500 md:col-span-2 lg:col-span-3">لا توجد إعلانات مطابقة ومتاحة حاليًا.</div>}
    </div>}
  </div></main>;
}
