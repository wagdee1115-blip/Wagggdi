'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, Clock3, RefreshCw, ShieldCheck } from 'lucide-react';

type Vehicle = { id: string; plateNumber: string; make: string; model: string; year: number; price: string | number; status: string; isReserved: boolean; hasLegalBlock: boolean; governmentStatus: string };
type Sale = {
  id: string; status: string; party: 'BUYER' | 'SELLER' | 'PAYOUT_OWNER' | 'STAFF'; sellerName: string; buyerName?: string | null;
  vehicleAmountYER: string | number; transferFeeUSD: number; platformFeeUSD: number; totalPaidYER: string | number;
  sellerOtpVerified: boolean; buyerOtpVerified: boolean; expiresAt: string; createdAt: string;
  vehicle: { id: string; plateNumber: string; make: string; model: string; year: number; city: string };
};

const statusText: Record<string, string> = {
  SALE_CREATED: 'بانتظار OTP البائع', BUYER_PENDING: 'بانتظار المشتري', BUYER_ACCEPTED: 'موافقة المشتري', PAYMENT_PROCESSING: 'بدء الدفع', PAYMENT_CONFIRMED: 'تم تأكيد الدفع',
  ESCROW_HELD: 'الأموال مؤمنة', TRANSFER_PENDING: 'طلب المرور قيد التنفيذ', TRANSFER_IN_PROGRESS: 'نقل الملكية جارٍ', TRANSFER_BLOCKED: 'النقل متوقف',
  HANDOVER_PENDING: 'بانتظار التسليم', PAYOUT_PROTECTION: 'حماية الصرف', PAYOUT_PENDING: 'بانتظار الصرف', PAYOUT_PROCESSING: 'الصرف جارٍ', PAYOUT_CONFIRMED: 'تم الصرف',
  DISPUTED: 'نزاع مفتوح', REFUND_PENDING: 'استرداد مطلوب', REFUND_PROCESSING: 'الاسترداد جارٍ', REFUND_FAILED: 'تعذر الاسترداد', REFUNDED: 'تم الاسترداد',
  EXPIRED: 'منتهية', CANCELLED: 'ملغاة', MANUAL_REVIEW: 'مراجعة يدوية', COMPLETED: 'مكتملة',
};

const errorText: Record<string, string> = {
  UNAUTHORIZED: 'يجب تسجيل الدخول أولاً.', INVALID_INPUT: 'تحقق من رقم المشتري وسعر المركبة.', BUYER_NOT_FOUND: 'لم يتم العثور على حساب بهذا الرقم.',
  BUYER_NOT_ACTIVE: 'حساب المشتري غير نشط.', BUYER_NOT_PHONE_VERIFIED: 'رقم جوال المشتري غير موثق.', BUYER_IDENTITY_NOT_VERIFIED: 'هوية المشتري غير موثقة.',
  SELLER_NOT_PHONE_VERIFIED: 'يجب توثيق رقم جوال البائع أولاً.', SELLER_IDENTITY_NOT_VERIFIED: 'يجب توثيق هوية البائع والرقم الوطني أولاً.',
  PAYOUT_USER_IDENTITY_NOT_VERIFIED: 'يجب توثيق هوية صاحب حساب الاستلام.', PAYOUT_ACCOUNT_REQUIRED: 'يجب إضافة حساب استلام موثق قبل بدء البيع.',
  PAYOUT_REVIEW_REQUIRED: 'حساب الاستلام يحتاج مراجعة قبل بدء العملية.', VEHICLE_NOT_AVAILABLE: 'المركبة غير متاحة للبيع حالياً.',
  VEHICLE_ALREADY_LOCKED: 'المركبة مرتبطة بعملية أخرى حالياً.', VALID_AUTHORIZATION_REQUIRED: 'لا تملك صلاحية بيع هذه المركبة.',
};

export default function TransferPage() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [form, setForm] = useState({ vehicleId: '', buyerPhone: '', price: '' });
  const [created, setCreated] = useState<{ saleId: string; buyerName: string; phoneMasked: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  const availableVehicles = useMemo(() => vehicles.filter(vehicle => vehicle.status === 'ACTIVE' && !vehicle.isReserved && !vehicle.hasLegalBlock && !['BLOCKED', 'RESTRICTED'].includes(vehicle.governmentStatus)), [vehicles]);
  const selected = useMemo(() => availableVehicles.find(vehicle => vehicle.id === form.vehicleId), [availableVehicles, form.vehicleId]);

  async function load(signal?: AbortSignal) {
    try {
      const [meResponse, vehiclesResponse, transfersResponse] = await Promise.all([fetch('/api/me', { signal }), fetch('/api/vehicles', { signal }), fetch('/api/transfers', { signal })]);
      const [me, vehicleData, transferData] = await Promise.all([meResponse.json(), vehiclesResponse.json(), transfersResponse.json()]);
      if (!me.ok) { setAuthenticated(false); setVehicles([]); setSales([]); return; }
      setAuthenticated(true);
      if (vehicleData.ok) setVehicles(vehicleData.vehicles || []);
      if (transferData.ok) setSales(transferData.sales || []);
      setError('');
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setError('تعذر تحميل عمليات نقل الملكية.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, []);

  async function createTransfer(event: FormEvent) {
    event.preventDefault();
    setError('');
    setCreated(null);
    setSubmitting(true);
    try {
      const response = await fetch('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vehicleId: form.vehicleId, buyerPhone: form.buyerPhone.trim(), salePrice: Number(form.price), listingType: 'MARKET' }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'TRANSFER_CREATE_FAILED');
      setCreated({ saleId: result.sale.id, buyerName: result.buyer.fullName, phoneMasked: result.buyer.phoneMasked });
      setForm({ vehicleId: '', buyerPhone: '', price: '' });
      await load();
    } catch (createError) {
      const code = createError instanceof Error ? createError.message : 'TRANSFER_CREATE_FAILED';
      setError(errorText[code] || code);
    } finally {
      setSubmitting(false);
    }
  }

  if (authenticated === false) return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div className="mx-auto max-w-xl"><Link href="/" className="font-bold text-primary-900">الرئيسية</Link><div className="mt-10 rounded-2xl border bg-white p-8 text-center"><h1 className="text-2xl font-black">نقل الملكية</h1><p className="mt-3 text-slate-500">يجب تسجيل الدخول لبدء أو متابعة عملية نقل ملكية.</p><Link href="/auth/login?next=/traffic/ownership-transfer" className="mt-5 inline-block rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تسجيل الدخول</Link></div></div></main>;

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-5xl p-4 md:p-7">
    <Link href="/" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>الرئيسية</Link>
    <h1 className="text-2xl font-black">نقل ملكية مركبة</h1><p className="mt-2 text-sm leading-7 text-slate-500">يؤكد البائع الطلب برمز هاتفه أولاً؛ عندها فقط يصل للمشتري وتبدأ مهلة الساعتين. لا يبدأ نقل المرور قبل تأكيد الدفع وحجز الضمان.</p>

    <section className="mt-5 rounded-2xl border bg-white p-5 shadow-sm md:p-6">
      <div className="flex items-center gap-2"><ShieldCheck className="text-emerald-700"/><h2 className="text-lg font-black">إنشاء طلب جديد</h2></div>
      <form onSubmit={createTransfer} className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="text-sm font-bold">المركبة<select required value={form.vehicleId} onChange={event => { const vehicle = availableVehicles.find(item => item.id === event.target.value); setForm({ ...form, vehicleId: event.target.value, price: vehicle ? String(vehicle.price) : form.price }); }} className="mt-2 w-full rounded-xl border p-3 font-normal"><option value="">اختر مركبة متاحة</option>{availableVehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.make} {vehicle.model} — {vehicle.plateNumber}</option>)}</select></label>
        <label className="text-sm font-bold">رقم جوال المشتري<input required minLength={7} value={form.buyerPhone} onChange={event => setForm({ ...form, buyerPhone: event.target.value })} placeholder="رقم الجوال المسجل" inputMode="tel" className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
        <label className="text-sm font-bold md:col-span-2">سعر المركبة بالريال اليمني<input required type="number" min="1" value={form.price} onChange={event => setForm({ ...form, price: event.target.value })} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
        {selected && <div className="rounded-xl bg-slate-50 p-4 text-sm md:col-span-2">المركبة المختارة: <b>{selected.make} {selected.model} — {selected.plateNumber}</b></div>}
        <div className="grid gap-3 sm:grid-cols-2 md:col-span-2"><div className="rounded-xl bg-slate-50 p-3 text-sm">خدمة النقل الكاملة<br/><b>80 USD شاملة</b></div><div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">رسوم منصة إضافية<br/><b>0 USD</b></div></div>
        <button disabled={submitting || availableVehicles.length === 0} className="rounded-xl bg-primary-900 px-6 py-3 font-bold text-white disabled:opacity-50 md:col-span-2">{submitting ? 'جارٍ الإنشاء…' : 'إنشاء الطلب ثم تأكيد OTP البائع'}</button>
      </form>
      {availableVehicles.length === 0 && !loading && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">لا توجد مركبة نشطة ومتاحة. راجع <Link href="/vehicles" className="font-bold underline">مركباتي</Link>.</p>}
      {created && <div role="status" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"><CheckCircle2 className="mb-2"/>تم إنشاء المسودة للمشتري <b>{created.buyerName}</b> ({created.phoneMasked}). لم تُرسل له بعد؛ أكّد OTP البائع الآن.<div><button onClick={() => router.push(`/transfers/${created.saleId}`)} className="mt-3 rounded-lg bg-primary-900 px-4 py-2 font-bold text-white">متابعة التأكيد</button></div></div>}
      {error && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}<div className="mt-2 flex flex-wrap gap-3">{error.includes('الهوية') && <Link href="/account/verification" className="font-bold underline">توثيق الهوية</Link>}{error.includes('استلام') && <Link href="/account/payout" className="font-bold underline">إضافة حساب استلام</Link>}</div></div>}
    </section>

    <section className="mt-6"><div className="mb-3 flex items-center justify-between"><div><h2 className="text-xl font-black">عملياتي</h2><p className="text-sm text-slate-500">اختر العملية لإكمال OTP والدفع والمرور والتسليم والنزاع.</p></div><button disabled={loading} onClick={() => { setLoading(true); void load(); }} className="rounded-xl border bg-white p-2 disabled:opacity-50" aria-label="تحديث"><RefreshCw size={18}/></button></div>
      {loading ? <div role="status" className="rounded-2xl border bg-white p-8 text-center">جارٍ تحميل العمليات…</div> : <div className="space-y-3">{sales.map(sale => {
        const isBuyer = sale.party === 'BUYER';
        return <Link href={`/transfers/${sale.id}`} key={sale.id} className="block rounded-2xl border bg-white p-5 shadow-sm transition hover:shadow-md"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-black">{sale.vehicle.make} {sale.vehicle.model} — {sale.vehicle.plateNumber}</h3><p className="mt-1 text-sm text-slate-500">{isBuyer ? `البائع: ${sale.sellerName}` : `المشتري: ${sale.buyerName || '—'}`}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold">{statusText[sale.status] || sale.status}</span></div><div className="mt-4 grid gap-2 text-sm sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-3">قيمة المركبة<br/><b>{Number(sale.vehicleAmountYER).toLocaleString('ar-YE')} ريال</b></div><div className="rounded-xl bg-slate-50 p-3">رسوم النقل<br/><b>{sale.transferFeeUSD + sale.platformFeeUSD} USD</b></div><div className="rounded-xl bg-slate-50 p-3"><Clock3 size={16} className="mb-1"/>المهلة<br/><b>{new Date(sale.expiresAt).toLocaleString('ar-YE')}</b></div></div></Link>;
      })}{sales.length === 0 && <div className="rounded-2xl border bg-white p-7 text-center text-slate-500">لا توجد عمليات مرتبطة بحسابك.</div>}</div>}
    </section>
  </div></main>;
}
