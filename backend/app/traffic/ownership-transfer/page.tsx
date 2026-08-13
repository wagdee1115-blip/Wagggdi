'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, Clock3, RefreshCw } from 'lucide-react';

const steps = ['اختيار المركبة', 'بيانات المشتري', 'الموافقة', 'التحقق', 'الدفع', 'نقل الملكية', 'التسليم', 'تحويل المبلغ', 'إتمام'];

type Vehicle = { id: string; ownerId?: string; plateNumber: string; make: string; model: string; year: number; price: string | number };
type Sale = {
  id: string;
  status: string;
  sellerId: string;
  sellerName: string;
  buyerId?: string | null;
  buyerName?: string | null;
  buyerPhone?: string | null;
  vehicleAmountYER: string | number;
  transferFeeUSD: number;
  platformFeeUSD: number;
  totalPaidYER: string | number;
  exchangeRate: string | number;
  expiresAt: string;
  vehicle: { id: string; plateNumber: string; make: string; model: string; year: number; city: string };
};

const errorText: Record<string, string> = {
  UNAUTHORIZED: 'يجب تسجيل الدخول أولاً.',
  INVALID_INPUT: 'تحقق من رقم المشتري وسعر المركبة.',
  BUYER_NOT_FOUND: 'لم يتم العثور على حساب نشط بهذا الرقم.',
  BUYER_NOT_ACTIVE: 'حساب المشتري غير نشط.',
  BUYER_NOT_PHONE_VERIFIED: 'رقم جوال المشتري غير موثق.',
  SELLER_NOT_PHONE_VERIFIED: 'يجب توثيق رقم جوال البائع أولاً.',
  PAYOUT_ACCOUNT_REQUIRED: 'يجب إضافة حساب استلام موثق قبل بدء البيع.',
  PAYOUT_REVIEW_REQUIRED: 'حساب الاستلام يحتاج مراجعة قبل بدء العملية.',
  VEHICLE_NOT_AVAILABLE: 'المركبة غير متاحة للبيع حالياً.',
  VEHICLE_ALREADY_LOCKED: 'المركبة مرتبطة بعملية أخرى حالياً.',
  VALID_AUTHORIZATION_REQUIRED: 'لا تملك صلاحية بيع هذه المركبة.',
  BUYER_APPROVAL_REQUIRED: 'موافقة المشتري يجب أن تتم من حساب المشتري نفسه.',
};

export default function TransferPage() {
  const [userId, setUserId] = useState('');
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [vehicleId, setVehicleId] = useState('');
  const [buyerPhone, setBuyerPhone] = useState('');
  const [price, setPrice] = useState('');
  const [createdBuyer, setCreatedBuyer] = useState<{ fullName: string; phoneMasked: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  const selected = useMemo(() => vehicles.find(v => v.id === vehicleId), [vehicles, vehicleId]);

  async function load() {
    const [meResponse, vehiclesResponse, transfersResponse] = await Promise.all([
      fetch('/api/me'),
      fetch('/api/vehicles'),
      fetch('/api/transfers'),
    ]);
    const [me, vehicleData, transferData] = await Promise.all([
      meResponse.json(),
      vehiclesResponse.json(),
      transfersResponse.json(),
    ]);

    if (!me.ok) {
      setAuthenticated(false);
      setVehicles([]);
      setSales([]);
      return;
    }

    setAuthenticated(true);
    setUserId(me.user.id);
    if (vehicleData.ok) {
      const mine = (vehicleData.vehicles || []).filter((v: Vehicle) => !v.ownerId || v.ownerId === me.user.id);
      setVehicles(mine);
    }
    if (transferData.ok) setSales(transferData.sales || []);
  }

  useEffect(() => { load(); }, []);

  async function create() {
    setError('');
    setCreatedBuyer(null);
    setLoading(true);
    try {
      const response = await fetch('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId, buyerPhone: buyerPhone.trim(), salePrice: Number(price), listingType: 'MARKET' }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'TRANSFER_CREATE_FAILED');
      setCreatedBuyer(result.buyer);
      setVehicleId('');
      setBuyerPhone('');
      setPrice('');
      await load();
    } catch (e) {
      const code = e instanceof Error ? e.message : 'TRANSFER_CREATE_FAILED';
      setError(errorText[code] || code);
    } finally {
      setLoading(false);
    }
  }

  async function acceptAsBuyer(saleId: string) {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/transfers/${saleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'BUYER_ACCEPTED' }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'TRANSFER_UPDATE_FAILED');
      await load();
    } catch (e) {
      const code = e instanceof Error ? e.message : 'TRANSFER_UPDATE_FAILED';
      setError(errorText[code] || code);
    } finally {
      setLoading(false);
    }
  }

  if (authenticated === false) {
    return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div className="mx-auto max-w-xl"><a href="/" className="font-bold text-primary-900">← الرئيسية</a><div className="mt-10 rounded-2xl border bg-white p-8 text-center"><h1 className="text-2xl font-black">نقل الملكية</h1><p className="mt-3 text-slate-500">يجب تسجيل الدخول لبدء أو متابعة عملية نقل ملكية.</p><a href="/auth/login" className="mt-5 inline-block rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تسجيل الدخول</a></div></div></main>;
  }

  return (
    <main dir="rtl" className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl p-4 md:p-7">
        <a href="/" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18} />الرئيسية</a>
        <h1 className="text-2xl font-black">نقل ملكية مركبة</h1>
        <p className="mt-2 text-sm text-slate-500">مدة العملية ساعتان. لا يمكن للبائع تأكيد موافقة المشتري نيابة عنه.</p>

        <div className="mt-5 flex gap-2 overflow-x-auto pb-3">
          {steps.map((s, i) => <div key={s} className="whitespace-nowrap rounded-full bg-white px-4 py-2 text-xs font-bold shadow-sm">{i + 1}. {s}</div>)}
        </div>

        <section className="mt-4 rounded-2xl border bg-white p-5 shadow-sm md:p-6">
          <h2 className="text-lg font-black">إنشاء طلب جديد</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-sm font-bold">المركبة
              <select value={vehicleId} onChange={e => { setVehicleId(e.target.value); const v = vehicles.find(x => x.id === e.target.value); if (v) setPrice(String(v.price)); }} className="mt-2 w-full rounded-xl border p-3 font-normal">
                <option value="">اختر مركبة مملوكة لك</option>
                {vehicles.map(v => <option key={v.id} value={v.id}>{v.make} {v.model} — {v.plateNumber}</option>)}
              </select>
            </label>
            <label className="text-sm font-bold">رقم جوال المشتري
              <input value={buyerPhone} onChange={e => setBuyerPhone(e.target.value)} placeholder="رقم الجوال المسجل في مركبات" inputMode="tel" className="mt-2 w-full rounded-xl border p-3 font-normal" />
            </label>
            <label className="text-sm font-bold md:col-span-2">سعر المركبة بالريال اليمني
              <input type="number" min="1" value={price} onChange={e => setPrice(e.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal" />
            </label>
          </div>

          {selected && <div className="mt-4 rounded-xl bg-slate-50 p-4 text-sm">المركبة المختارة: <b>{selected.make} {selected.model} — {selected.plateNumber}</b></div>}

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-slate-50 p-3 text-sm">رسوم النقل<br/><b>80 USD</b></div>
            <div className="rounded-xl bg-slate-50 p-3 text-sm">رسوم المنصة<br/><b>20 USD</b></div>
            <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">إجمالي الرسوم الثابتة<br/><b>100 USD</b></div>
          </div>

          {createdBuyer && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"><CheckCircle2 className="mb-2" />تم إنشاء الطلب وإرساله إلى <b>{createdBuyer.fullName}</b> ({createdBuyer.phoneMasked}). يجب أن يوافق المشتري من حسابه.</div>}
          {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

          <button disabled={loading || !vehicleId || buyerPhone.trim().length < 7 || !price} onClick={create} className="mt-5 rounded-xl bg-primary-900 px-6 py-3 font-bold text-white disabled:opacity-50">{loading ? 'جارٍ التنفيذ...' : 'إنشاء وإرسال طلب النقل'}</button>
        </section>

        <section className="mt-6">
          <div className="mb-3 flex items-center justify-between"><div><h2 className="text-xl font-black">عملياتي</h2><p className="text-sm text-slate-500">الطلبات الواردة والصادرة المرتبطة بحسابك.</p></div><button onClick={load} className="rounded-xl border bg-white p-2" aria-label="تحديث"><RefreshCw size={18} /></button></div>
          <div className="space-y-3">
            {sales.map(sale => {
              const isBuyer = sale.buyerId === userId;
              return <article key={sale.id} className="rounded-2xl border bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-black">{sale.vehicle.make} {sale.vehicle.model} — {sale.vehicle.plateNumber}</h3><p className="mt-1 text-sm text-slate-500">{isBuyer ? `البائع: ${sale.sellerName}` : `المشتري: ${sale.buyerName || '—'}`}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold">{sale.status}</span></div>
                <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-3">قيمة المركبة<br/><b>{Number(sale.vehicleAmountYER).toLocaleString('ar-YE')} ريال</b></div><div className="rounded-xl bg-slate-50 p-3">الرسوم<br/><b>{sale.transferFeeUSD + sale.platformFeeUSD} USD</b></div><div className="rounded-xl bg-slate-50 p-3"><Clock3 size={16} className="mb-1"/>تنتهي<br/><b>{new Date(sale.expiresAt).toLocaleString('ar-YE')}</b></div></div>
                {isBuyer && sale.status === 'BUYER_PENDING' && <button disabled={loading} onClick={() => acceptAsBuyer(sale.id)} className="mt-4 rounded-xl bg-primary-900 px-5 py-2.5 font-bold text-white disabled:opacity-50">الموافقة على شراء المركبة</button>}
                {!isBuyer && sale.status === 'BUYER_PENDING' && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">بانتظار موافقة المشتري من حسابه.</p>}
              </article>;
            })}
            {sales.length === 0 && <div className="rounded-2xl border bg-white p-7 text-center text-slate-500">لا توجد عمليات نقل مرتبطة بحسابك حالياً.</div>}
          </div>
        </section>
      </div>
    </main>
  );
}
