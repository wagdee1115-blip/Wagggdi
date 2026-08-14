'use client';

import Link from 'next/link';
import { ArrowRight, CarFront, Heart, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type PublicListing = {
  id: string;
  listingType: string;
  publicationStatus: 'PUBLISHED';
  price: string;
  currency: string;
  description: string;
  publishedAt: string;
  updatedAt: string;
  vehicle: {
    make: string;
    model: string;
    year: number;
    mileage: number;
    transmission: string;
    fuelType: string;
    color: string;
    city: string;
  };
};

type FavoriteItem = {
  favoritedAt: string;
  listing: PublicListing;
};

const currencyText: Record<string, string> = {
  YER: 'ر.ي',
  USD: 'دولار أمريكي',
  SAR: 'ر.س',
};

export default function FavoritesPage() {
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [removingId, setRemovingId] = useState('');
  const [error, setError] = useState('');
  const requestSequence = useRef(0);

  const load = useCallback(async (cursor?: string, signal?: AbortSignal) => {
    const append = Boolean(cursor);
    const requestId = ++requestSequence.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError('');
    try {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const response = await fetch(`/api/favorites${query}`, { cache: 'no-store', signal });
      const result = await response.json().catch(() => ({ ok: false }));
      if (response.status === 401) {
        if (requestId === requestSequence.current) {
          setAuthRequired(true);
          setFavorites([]);
        }
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'FAVORITES_UNAVAILABLE');
      if (requestId !== requestSequence.current) return;
      const incoming = Array.isArray(result.favorites) ? result.favorites : [];
      setFavorites(current => append ? [
        ...current,
        ...incoming.filter((item: FavoriteItem) => !current.some(existing => existing.listing.id === item.listing.id)),
      ] : incoming);
      setNextCursor(typeof result.nextCursor === 'string' ? result.nextCursor : null);
      setAuthRequired(false);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      if (requestId === requestSequence.current) {
        setError('تعذر تحميل المفضلة الآن. تحقق من الاتصال ثم أعد المحاولة.');
      }
    } finally {
      if (requestId === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(undefined, controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  async function removeFavorite(listingId: string) {
    if (removingId) return;
    setRemovingId(listingId);
    setError('');
    try {
      const response = await fetch(`/api/favorites/${encodeURIComponent(listingId)}`, { method: 'DELETE' });
      const result = await response.json().catch(() => ({ ok: false }));
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'FAVORITE_REMOVE_FAILED');
      setFavorites(current => current.filter(item => item.listing.id !== listingId));
    } catch {
      setError('تعذر إزالة الإعلان من المفضلة. أعد المحاولة.');
    } finally {
      setRemovingId('');
    }
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-5xl p-4 md:p-7">
    <div className="flex items-center justify-between gap-3">
      <Link href="/account" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight aria-hidden="true" size={18} />الحساب</Link>
      <Link href="/market" className="text-sm font-bold text-primary-900">تصفح السوق</Link>
    </div>
    <section className="mt-5 rounded-3xl bg-gradient-to-l from-primary-900 to-slate-800 p-6 text-white md:p-8">
      <Heart aria-hidden="true" size={32} />
      <h1 className="mt-3 text-3xl font-black">المفضلة</h1>
      <p className="mt-2 text-sm leading-7 text-slate-200">الإعلانات المحفوظة التي لا تزال منشورة ومتاحـة بأمان في السوق.</p>
    </section>

    {loading && <div role="status" aria-live="polite" className="mt-5 rounded-2xl border bg-white p-10 text-center text-slate-500">جارٍ تحميل المفضلة…</div>}
    {!loading && authRequired && <section className="mt-5 rounded-2xl border bg-white p-8 text-center"><h2 className="text-xl font-black">سجّل الدخول لعرض المفضلة</h2><p className="mt-2 text-sm text-slate-500">تُحفظ مفضلتك في حسابك لتظهر على أجهزتك.</p><Link href="/auth/login?next=/favorites" className="mt-5 inline-block rounded-xl bg-primary-900 px-6 py-3 font-bold text-white">تسجيل الدخول</Link></section>}
    {!loading && !authRequired && error && <div role="alert" className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800">{error}<button type="button" onClick={() => void load()} className="me-3 font-bold underline">إعادة المحاولة</button></div>}

    {!loading && !authRequired && favorites.length === 0 && !error && <section className="mt-5 rounded-2xl border bg-white p-10 text-center"><Heart aria-hidden="true" className="mx-auto text-slate-300" size={42} /><h2 className="mt-4 text-xl font-black">لا توجد إعلانات محفوظة</h2><p className="mt-2 text-sm text-slate-500">احفظ الإعلانات التي تهمك من صفحة تفاصيل المركبة.</p><Link href="/market" className="mt-5 inline-block rounded-xl bg-primary-900 px-6 py-3 font-bold text-white">استعراض السوق</Link></section>}

    {!loading && !authRequired && favorites.length > 0 && <section aria-label="الإعلانات المفضلة" className="mt-5 grid gap-4 md:grid-cols-2">
      {favorites.map(item => <article key={item.listing.id} className="flex flex-col rounded-2xl border bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-xl font-black">{item.listing.vehicle.make} {item.listing.vehicle.model}</h2><p className="mt-1 text-sm text-slate-500">{item.listing.vehicle.year} · {item.listing.vehicle.city} · {item.listing.vehicle.color}</p></div><span className="rounded-xl bg-emerald-50 p-3 text-primary-900"><CarFront aria-hidden="true" /></span></div>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm"><div className="rounded-xl bg-slate-50 p-3"><dt className="text-xs text-slate-500">السعر</dt><dd className="mt-1 font-bold">{Number(item.listing.price).toLocaleString('ar-YE')} {currencyText[item.listing.currency] || item.listing.currency}</dd></div><div className="rounded-xl bg-slate-50 p-3"><dt className="text-xs text-slate-500">المسافة</dt><dd className="mt-1 font-bold">{item.listing.vehicle.mileage.toLocaleString('ar-YE')} كم</dd></div></dl>
        <p className="mt-3 text-xs text-slate-500">حُفظ في {new Date(item.favoritedAt).toLocaleDateString('ar-YE')}</p>
        <div className="mt-4 grid grid-cols-[1fr_auto] gap-2"><Link href={`/market/${item.listing.id}`} className="rounded-xl bg-primary-900 px-4 py-3 text-center font-bold text-white" aria-label={`عرض تفاصيل ${item.listing.vehicle.make} ${item.listing.vehicle.model}`}>عرض التفاصيل</Link><button type="button" disabled={Boolean(removingId)} onClick={() => void removeFavorite(item.listing.id)} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-red-200 px-4 font-bold text-red-700 disabled:opacity-50" aria-label={`إزالة ${item.listing.vehicle.make} ${item.listing.vehicle.model} من المفضلة`}><Trash2 aria-hidden="true" size={18} />{removingId === item.listing.id ? 'جارٍ…' : 'إزالة'}</button></div>
      </article>)}
    </section>}

    {!loading && !authRequired && nextCursor && <div className="mt-5 text-center"><button type="button" disabled={loadingMore} onClick={() => void load(nextCursor)} className="rounded-xl border bg-white px-6 py-3 font-bold text-primary-900 disabled:opacity-60">{loadingMore ? 'جارٍ تحميل المزيد…' : 'تحميل المزيد'}</button></div>}
  </div></main>;
}
