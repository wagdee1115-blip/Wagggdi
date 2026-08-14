'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BadgeCheck, CarFront, FilePenLine, ImagePlus, ShieldCheck, Store } from 'lucide-react';

type VehicleDetail = {
  id: string; plateNumber: string; vin: string; make: string; model: string; year: number;
  price: string | number; mileage: number; transmission: string; fuelType: string; color: string;
  city: string; description?: string | null; status: string; isReserved: boolean; hasLegalBlock: boolean;
  governmentStatus: string;
  listings: { id: string; status: string; listingType: string; price: string | number; currency: string }[];
  media: { id: string; mediaType: string; mimeType?: string; sizeBytes?: number; publicStatus: string; plateDetectionStatus: string; createdAt?: string }[];
};

const text: Record<string, string> = {
  AUTO: 'أوتوماتيك', MANUAL: 'يدوي', PETROL: 'بنزين', DIESEL: 'ديزل', HYBRID: 'هجين', ELECTRIC: 'كهربائي',
  DRAFT: 'مسودة', PENDING: 'قيد المراجعة', ACTIVE: 'نشطة', SOLD: 'مباعة', HIDDEN: 'مخفية', REJECTED: 'مرفوضة',
  UNKNOWN: 'غير متاحة', VERIFIED: 'متحققة', RESTRICTED: 'مقيدة', BLOCKED: 'محظورة',
};

function OwnershipVerificationCard({ vehicle, onVerified }: { vehicle: VehicleDetail; onVerified: () => void }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  if (vehicle.governmentStatus === 'VERIFIED') return null;

  async function verify() {
    if (pending) return;
    setPending(true); setMessage(''); setError('');
    try {
      const response = await fetch(`/api/vehicles/${vehicle.id}/verify-ownership`, { method: 'POST' });
      const result = await response.json().catch(() => ({ ok: false, error: 'INVALID_RESPONSE' }));
      if (!response.ok || !result.ok) {
        const messages: Record<string, string> = {
          IDENTITY_NOT_VERIFIED: 'وثّق هويتك الوطنية أولًا من صفحة الحساب ثم أعد المحاولة.',
          PHONE_NOT_VERIFIED: 'وثّق رقم هاتفك أولًا من صفحة الحساب ثم أعد المحاولة.',
          VEHICLE_LOCKED: 'لا يمكن التحقق من المركبة أثناء حجزها أو بعد بيعها.',
          VEHICLE_RESTRICTED: 'هذه المركبة مقيدة ولا يمكن تفعيلها من هذه الرحلة.',
          RATE_LIMITED: 'تجاوزت عدد محاولات التحقق المسموح. حاول لاحقًا.',
          'NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED': 'مزود التحقق الحكومي غير مربوط بعد؛ بقيت المركبة مسودة خاصة.',
        };
        throw new Error(messages[result.error] || 'تعذر توثيق الملكية. بقيت المركبة مسودة خاصة.');
      }
      if (result.verification.decision === 'VERIFIED') {
        onVerified();
        setMessage('تم توثيق الملكية وتفعيل المركبة بنجاح.');
      } else if (result.verification.decision === 'REJECTED') {
        setError('لم يؤكد المزود الحكومي ملكية المركبة. راجع اللوحة ورقم الهيكل أو تواصل مع الدعم.');
      } else {
        setMessage('طلب التوثيق قيد المعالجة. أعد المحاولة بعد قليل.');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر توثيق الملكية.');
    } finally {
      setPending(false);
    }
  }

  return <section className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 p-5" aria-busy={pending}><div className="flex items-center gap-2"><BadgeCheck className="text-blue-800" aria-hidden="true"/><h2 className="font-black text-blue-950">توثيق ملكية المركبة</h2></div><p className="mt-2 text-sm leading-7 text-blue-950">تبقى المركبة مسودة خاصة حتى يطابق المزود الحكومي رقم اللوحة والهيكل مع هويتك الوطنية الموثقة. لا نعرض مرجع المزود أو بيانات هويتك هنا.</p><button type="button" disabled={pending} onClick={verify} className="mt-4 rounded-xl bg-blue-900 px-5 py-3 font-bold text-white disabled:opacity-60">{pending ? 'جارٍ التحقق…' : 'تحقق من الملكية وتفعيل المركبة'}</button>{message && <p role="status" aria-live="polite" className="mt-3 rounded-xl bg-white p-3 text-sm text-blue-900">{message}</p>}{error && <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}</section>;
}

function PublishListing({ vehicle, onPublished }: { vehicle: VehicleDetail; onPublished: (id: string) => void }) {
  const [price, setPrice] = useState(String(vehicle.price));
  const [listingType, setListingType] = useState<'DIRECT' | 'MARKET' | 'EXHIBITION'>('MARKET');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const eligible = vehicle.status === 'ACTIVE' && !vehicle.isReserved && !vehicle.hasLegalBlock && vehicle.governmentStatus === 'VERIFIED';

  async function publish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      const response = await fetch('/api/listings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId: vehicle.id, listingType, price: Number(price), source: 'OWNER_PORTAL' }),
      });
      const result = await response.json().catch(() => ({ ok: false }));
      if (!response.ok || !result.ok) {
        const messages: Record<string, string> = {
          ACTIVE_LISTING_EXISTS: 'للمركبة إعلان نشط بالفعل.', VEHICLE_NOT_AVAILABLE: 'المركبة غير متاحة للنشر الآن.',
          VEHICLE_RESTRICTED: 'لا يمكن نشر مركبة عليها قيد.', INVALID_INPUT: 'أدخل سعرًا صحيحًا.',
        };
        throw new Error(messages[result.error] || 'تعذر نشر الإعلان الآن.');
      }
      setMessage('تم نشر الإعلان في السوق بنجاح.');
      onPublished(result.listing.id);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'تعذر نشر الإعلان الآن.');
    } finally {
      setPending(false);
    }
  }

  if (!eligible) return <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-900">النشر غير متاح حتى تُوثق الملكية حكوميًا وتصبح المركبة نشطة وغير محجوزة وخالية من القيود.</div>;
  return <form onSubmit={publish} className="rounded-2xl border bg-white p-5" aria-busy={pending}><div className="flex items-center gap-2"><Store className="text-primary-900" /><h2 className="font-black">نشر المركبة في السوق</h2></div><div className="mt-4 grid gap-3 md:grid-cols-2"><label className="text-sm font-bold">نوع الإعلان<select value={listingType} onChange={e => setListingType(e.target.value as typeof listingType)} className="mt-1 w-full rounded-xl border p-3"><option value="MARKET">السوق</option><option value="DIRECT">بيع مباشر</option><option value="EXHIBITION">معرض</option></select></label><label className="text-sm font-bold">السعر (ريال يمني)<input required type="number" min="1" step="1" value={price} onChange={e => setPrice(e.target.value)} className="mt-1 w-full rounded-xl border p-3" /></label></div><button disabled={pending} className="mt-4 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-60">{pending ? 'جارٍ النشر…' : 'نشر الإعلان'}</button>{message && <p aria-live="polite" className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">{message}</p>}</form>;
}

function ActiveListingCard({
  listing,
  onPriceUpdated,
  onUnpublished,
}: {
  listing: VehicleDetail['listings'][number];
  onPriceUpdated: (price: string) => void;
  onUnpublished: () => void;
}) {
  const [price, setPrice] = useState(String(listing.price));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  async function updatePrice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      const response = await fetch(`/api/listings/${listing.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ price: Number(price) }),
      });
      const result = await response.json().catch(() => ({ ok: false }));
      if (!response.ok || !result.ok) throw new Error(result.error || 'LISTING_UPDATE_FAILED');
      const nextPrice = String(result.listing.price);
      setPrice(nextPrice);
      onPriceUpdated(nextPrice);
      setMessage('تم تحديث سعر الإعلان.');
    } catch {
      setMessage('تعذر تحديث السعر الآن.');
    } finally {
      setPending(false);
    }
  }

  async function unpublish() {
    if (pending || !window.confirm('هل تريد إلغاء نشر هذا الإعلان من السوق؟')) return;
    setPending(true);
    setMessage('');
    try {
      const response = await fetch(`/api/listings/${listing.id}`, { method: 'DELETE' });
      const result = await response.json().catch(() => ({ ok: false }));
      if (!response.ok || !result.ok) throw new Error('LISTING_UNPUBLISH_FAILED');
      onUnpublished();
    } catch {
      setMessage('تعذر إلغاء نشر الإعلان الآن.');
    } finally {
      setPending(false);
    }
  }

  return <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><p className="font-bold text-emerald-900">الإعلان منشور وآمن</p><div className="mt-3 flex flex-wrap gap-3"><Link href={`/market/${listing.id}`} className="rounded-xl border border-emerald-300 bg-white px-4 py-2 text-sm font-bold text-primary-900">عرض الإعلان العام</Link><button type="button" onClick={unpublish} disabled={pending} className="rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-bold text-red-700 disabled:opacity-60">إلغاء النشر</button></div><form onSubmit={updatePrice} className="mt-4 flex items-end gap-2"><label className="flex-1 text-sm font-bold text-slate-800">سعر الإعلان<input required type="number" min="1" step="1" value={price} onChange={event => setPrice(event.target.value)} className="mt-1 w-full rounded-xl border bg-white p-3" /></label><button disabled={pending} className="mb-0.5 rounded-xl bg-primary-900 px-4 py-3 font-bold text-white disabled:opacity-60">تحديث</button></form>{message && <p aria-live="polite" className="mt-3 text-sm text-slate-700">{message}</p>}</div>;
}

function MediaManager({ vehicleId, media, onChanged }: { vehicleId: string; media: VehicleDetail['media']; onChanged: (media: VehicleDetail['media']) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mediaType, setMediaType] = useState('PRIMARY');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || pending) return;
    setPending(true); setMessage('');
    try {
      const body = new FormData(); body.set('file', file); body.set('mediaType', mediaType);
      const response = await fetch(`/api/vehicles/${vehicleId}/media`, { method: 'POST', body });
      const result = await response.json().catch(() => ({ ok: false }));
      if (!response.ok || !result.ok) {
        const errors: Record<string, string> = {
          'NOT_CONFIGURED:STORAGE_PROVIDER_REQUIRED': 'خدمة التخزين غير مربوطة بعد.',
          'NOT_CONFIGURED:MALWARE_SCANNER_REQUIRED': 'فاحص الملفات غير مربوط بعد.',
          MEDIA_SIZE_LIMIT: 'حجم الصورة يجب ألا يتجاوز 10 ميجابايت.',
          UNSUPPORTED_MEDIA_TYPE: 'يُسمح بصور JPG وPNG وWebP فقط.',
          MEDIA_MAGIC_BYTES_INVALID: 'محتوى الملف لا يطابق نوع الصورة.',
          MALWARE_DETECTED: 'رفض فاحص الأمان هذا الملف.',
        };
        throw new Error(errors[result.error] || 'تعذر رفع الصورة.');
      }
      const next = media.filter(item => item.id !== result.media.id);
      onChanged([result.media, ...next]); setFile(null);
      setMessage(result.replayed ? 'الصورة موجودة مسبقًا ولم تُكرر.' : 'رُفعت الصورة بصورة خاصة بعد فحصها.');
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'تعذر رفع الصورة.'); }
    finally { setPending(false); }
  }

  async function preparePublic(mediaId: string) {
    setPending(true); setMessage('');
    try {
      const response = await fetch(`/api/vehicles/${vehicleId}/media/${mediaId}/publish`, { method: 'POST' });
      const result = await response.json().catch(() => ({ ok: false }));
      if (!response.ok || !result.ok) throw new Error(result.error === 'NOT_CONFIGURED:PLATE_REDACTION_PROVIDER_REQUIRED' ? 'مزود إخفاء اللوحات غير مربوط بعد؛ بقيت الصورة خاصة.' : 'تعذر تجهيز الصورة للنشر.');
      onChanged(media.map(item => item.id === mediaId ? { ...item, ...result.media } : item));
      setMessage('عولجت اللوحة وأصبحت الصورة جاهزة للاستخدام العام.');
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'تعذر تجهيز الصورة للنشر.'); }
    finally { setPending(false); }
  }

  return <section className="mt-5 rounded-2xl border bg-white p-5"><div className="flex items-center gap-2"><ImagePlus className="text-primary-900"/><h2 className="text-lg font-black">صور المركبة</h2></div><p className="mt-1 text-xs leading-6 text-slate-500">تبقى الصورة خاصة حتى ينجح فحص الملف وإخفاء اللوحة عبر المزود المهيأ.</p><form onSubmit={upload} className="mt-4 grid gap-3 md:grid-cols-[1fr_180px_auto]"><label className="text-sm font-bold">الصورة<input required type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setFile(event.target.files?.[0] || null)} className="mt-2 block w-full text-sm"/></label><label className="text-sm font-bold">نوع الصورة<select value={mediaType} onChange={event => setMediaType(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"><option value="PRIMARY">رئيسية</option><option value="FRONT">أمامية</option><option value="REAR">خلفية</option><option value="SIDE">جانبية</option><option value="INTERIOR">داخلية</option><option value="ADDITIONAL">إضافية</option></select></label><button disabled={!file || pending} className="self-end rounded-xl bg-primary-900 px-4 py-3 font-bold text-white disabled:opacity-50">{pending ? 'جارٍ المعالجة…' : 'رفع خاص'}</button></form>{message && <p role="status" aria-live="polite" className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">{message}</p>}<ul className="mt-4 grid gap-2 sm:grid-cols-2">{media.map(item => <li key={item.id} className="rounded-xl border bg-slate-50 p-3 text-sm"><b>{item.mediaType}</b><p className="mt-1 text-slate-500">{item.publicStatus === 'PUBLIC' ? 'جاهزة للعامة' : 'خاصة'} · فحص اللوحة: {item.plateDetectionStatus}</p>{item.publicStatus !== 'PUBLIC' && <button type="button" disabled={pending} onClick={() => preparePublic(item.id)} className="mt-2 font-bold text-primary-900 underline disabled:opacity-50">إخفاء اللوحة وتجهيز للنشر</button>}</li>)}{media.length === 0 && <li className="rounded-xl bg-slate-50 p-4 text-center text-slate-500 sm:col-span-2">لم تُرفع صور بعد.</li>}</ul></section>;
}

export default function VehicleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [vehicle, setVehicle] = useState<VehicleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/vehicles/${id}`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const result = await response.json().catch(() => ({ ok: false }));
      if (!response.ok || !result.ok) throw new Error(result.error || 'VEHICLE_UNAVAILABLE');
      setVehicle(result.vehicle);
    }).catch(caught => {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught instanceof Error && caught.message === 'UNAUTHORIZED' ? 'سجّل الدخول لعرض هذه المركبة.' : 'تعذر العثور على المركبة أو لا تملك صلاحية عرضها.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id]);

  function onPublished(listingId: string) {
    setVehicle(current => current ? { ...current, listings: [{ id: listingId, status: 'ACTIVE', listingType: 'MARKET', price: current.price, currency: 'YER' }] } : current);
  }

  function onListingPriceUpdated(price: string) {
    setVehicle(current => current ? { ...current, listings: current.listings.map(listing => listing.status === 'ACTIVE' ? { ...listing, price } : listing) } : current);
  }

  function onListingUnpublished() {
    setVehicle(current => current ? { ...current, listings: current.listings.map(listing => listing.status === 'ACTIVE' ? { ...listing, status: 'UNPUBLISHED' } : listing) } : current);
  }

  if (loading) return <main dir="rtl" className="min-h-screen bg-slate-50 p-6"><div role="status" className="mx-auto max-w-3xl rounded-2xl border bg-white p-8 text-center text-slate-500">جارٍ تحميل بيانات المركبة…</div></main>;
  if (error || !vehicle) return <main dir="rtl" className="min-h-screen bg-slate-50 p-6"><div role="alert" className="mx-auto max-w-3xl rounded-2xl border bg-white p-8 text-center"><p>{error || 'المركبة غير موجودة.'}</p><Link href="/vehicles" className="mt-4 inline-block font-bold text-primary-900">العودة إلى مركباتي</Link></div></main>;

  const activeListing = vehicle.listings.find(listing => listing.status === 'ACTIVE');
  const rows = [
    ['رقم اللوحة', vehicle.plateNumber], ['رقم الهيكل', vehicle.vin], ['سنة الصنع', String(vehicle.year)],
    ['المسافة', `${vehicle.mileage.toLocaleString('ar-YE')} كم`], ['ناقل الحركة', text[vehicle.transmission] || vehicle.transmission],
    ['الوقود', text[vehicle.fuelType] || vehicle.fuelType], ['اللون', vehicle.color], ['المدينة', vehicle.city],
    ['حالة المركبة', text[vehicle.status] || vehicle.status], ['حالة القيد في النظام', text[vehicle.governmentStatus] || vehicle.governmentStatus],
  ];
  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-4xl p-4 md:p-7">
    <div className="flex flex-wrap items-center justify-between gap-3"><Link href="/vehicles" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18} aria-hidden="true" />مركباتي</Link><div className="flex flex-wrap gap-2">{vehicle.governmentStatus === 'VERIFIED' ? <Link href={`/vehicles/${vehicle.id}/compliance`} className="inline-flex items-center gap-2 rounded-xl border bg-white px-4 py-2 text-sm font-bold text-primary-900"><ShieldCheck size={17} aria-hidden="true" />المخالفات والتجديد</Link> : null}{!vehicle.isReserved && vehicle.status !== 'SOLD' ? <Link href={`/vehicles/${vehicle.id}/edit`} className="inline-flex items-center gap-2 rounded-xl border bg-white px-4 py-2 text-sm font-bold"><FilePenLine size={17} aria-hidden="true" />تعديل</Link> : null}</div></div>
    <section className="mt-5 rounded-3xl bg-primary-900 p-6 text-white"><CarFront size={30} /><h1 className="mt-3 text-2xl font-black">{vehicle.make} {vehicle.model}</h1><p className="mt-1 text-emerald-100">{Number(vehicle.price).toLocaleString('ar-YE')} ريال يمني</p></section>
    {(vehicle.isReserved || vehicle.hasLegalBlock) && <div role="status" className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{vehicle.hasLegalBlock ? 'المركبة عليها قيد ولا يمكن عرضها في السوق.' : 'المركبة محجوزة حاليًا ضمن عملية، لذلك أخفينا إعلانها من السوق.'}</div>}
    <OwnershipVerificationCard vehicle={vehicle} onVerified={() => setVehicle(current => current ? { ...current, status: 'ACTIVE', governmentStatus: 'VERIFIED' } : current)} />
    <section className="mt-5 rounded-2xl border bg-white p-5"><h2 className="text-lg font-black">البيانات الخاصة</h2><p className="mt-1 text-xs text-slate-500">لا تظهر اللوحة أو رقم الهيكل للزوار في السوق.</p><dl className="mt-4 grid gap-3 md:grid-cols-2">{rows.map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 break-words font-bold">{value}</dd></div>)}</dl>{vehicle.description && <div className="mt-4 border-t pt-4"><h3 className="font-bold">الوصف</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-600">{vehicle.description}</p></div>}</section>
    <MediaManager vehicleId={vehicle.id} media={vehicle.media} onChanged={media => setVehicle(current => current ? { ...current, media } : current)} />
    <section className="mt-5">{activeListing ? <ActiveListingCard listing={activeListing} onPriceUpdated={onListingPriceUpdated} onUnpublished={onListingUnpublished} /> : <PublishListing vehicle={vehicle} onPublished={onPublished} />}</section>
  </div></main>;
}
