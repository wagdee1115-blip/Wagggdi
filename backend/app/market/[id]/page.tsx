'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CarFront, ShieldCheck } from 'lucide-react';
import FavoriteButton from '@/app/components/favorite-button';

type Listing = {
  id: string; listingType: string; price: string; currency: string; description?: string | null; publishedAt: string;
  vehicle: { make: string; model: string; year: number; mileage: number; transmission: string; fuelType: string; color: string; city: string };
};

const valueText: Record<string, string> = { AUTO: 'أوتوماتيك', MANUAL: 'يدوي', PETROL: 'بنزين', DIESEL: 'ديزل', HYBRID: 'هجين', ELECTRIC: 'كهربائي' };

export default function MarketListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/listings/${id}?source=IN_APP_SEARCH`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const result = await response.json().catch(() => ({ ok: false }));
      if (response.status === 404) throw new Error('NOT_FOUND');
      if (!response.ok || !result.ok) throw new Error('UNAVAILABLE');
      setListing(result.listing);
    }).catch(caught => {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught instanceof Error && caught.message === 'NOT_FOUND' ? 'الإعلان غير موجود أو لم تعد المركبة متاحة.' : 'تعذر تحميل الإعلان الآن.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id]);

  if (loading) return <main dir="rtl" className="min-h-screen bg-slate-50 p-6"><div role="status" className="mx-auto max-w-3xl rounded-2xl border bg-white p-10 text-center text-slate-500">جارٍ تحميل الإعلان…</div></main>;
  if (error || !listing) return <main dir="rtl" className="min-h-screen bg-slate-50 p-6"><div role="alert" className="mx-auto max-w-3xl rounded-2xl border bg-white p-10 text-center"><p>{error || 'الإعلان غير متاح.'}</p><Link href="/market" className="mt-4 inline-block font-bold text-primary-900">العودة إلى السوق</Link></div></main>;

  const details = [
    ['السنة', String(listing.vehicle.year)], ['المدينة', listing.vehicle.city], ['اللون', listing.vehicle.color],
    ['المسافة', `${listing.vehicle.mileage.toLocaleString('ar-YE')} كم`], ['ناقل الحركة', valueText[listing.vehicle.transmission] || listing.vehicle.transmission],
    ['الوقود', valueText[listing.vehicle.fuelType] || listing.vehicle.fuelType],
  ];
  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-4xl p-4 md:p-7">
    <Link href="/market" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18} />السوق</Link>
    <section className="mt-5 rounded-3xl bg-gradient-to-l from-primary-900 to-slate-800 p-6 text-white md:p-8"><CarFront aria-hidden="true" size={34} /><h1 className="mt-4 text-3xl font-black">{listing.vehicle.make} {listing.vehicle.model}</h1><p className="mt-2 text-xl font-bold text-emerald-100">{Number(listing.price).toLocaleString('ar-YE')} ريال يمني</p><FavoriteButton listingId={listing.id} /></section>
    <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-7 text-emerald-900"><ShieldCheck className="mt-1 shrink-0" size={19} /><p>حُجبت بيانات المالك ورقم اللوحة ورقم الهيكل. إذا أصبحت المركبة محجوزة أو مقيدة فلن يبقى هذا الإعلان ظاهرًا.</p></div>
    <section className="mt-5 rounded-2xl border bg-white p-5"><h2 className="text-lg font-black">مواصفات المركبة</h2><dl className="mt-4 grid gap-3 md:grid-cols-2">{details.map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 font-bold">{value}</dd></div>)}</dl>{listing.description ? <div className="mt-5 border-t pt-5"><h2 className="font-black">الوصف</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-600">{listing.description}</p></div> : null}</section>
    <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-950"><h2 className="font-black">قبل إتمام البيع</h2><p>لا تحول أي مبلغ خارج مسار الدفع والحجز داخل المنصة. ابدأ بمحادثة خاصة مرتبطة بهذا الإعلان، ثم يبدأ مالك المركبة طلب النقل الرسمي ويكمل المشتري الموافقات والتحقق داخل حسابه.</p><div className="mt-3 flex flex-wrap gap-3"><Link href={`/conversations/new?listingId=${listing.id}`} className="rounded-xl bg-primary-900 px-5 py-2.5 font-bold text-white">مراسلة البائع بأمان</Link><Link href="/auth/login?next=/conversations" className="rounded-xl border border-amber-300 bg-white px-5 py-2.5 font-bold text-primary-900">تسجيل الدخول</Link></div></section>
  </div></main>;
}
