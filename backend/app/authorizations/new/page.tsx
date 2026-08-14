'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ArrowRight, CircleAlert, ShieldCheck } from 'lucide-react';

type Vehicle = {
  id: string; plateNumber: string; make: string; model: string; year: number;
  status: string; isReserved: boolean; hasLegalBlock: boolean; governmentStatus: string;
};

type Me = { identityStatus: string; phoneStatus: string };

const ERROR_TEXT: Record<string, string> = {
  INVALID_INPUT: 'تحقق من جميع الحقول وتاريخ انتهاء التفويض.',
  AUTHORIZED_PARTY_NOT_ELIGIBLE: 'لا يمكن تفويض هذا الرقم. يجب أن يكون مرتبطًا بحساب نشط موثق الهوية والجوال.',
  SELF_AUTHORIZATION_NOT_ALLOWED: 'لا يمكنك تفويض نفسك.',
  AUTHORIZATION_EXPIRY_REQUIRED: 'اختر تاريخ انتهاء مستقبليًا.',
  AUTHORIZATION_VALIDITY_TOO_LONG: 'مدة التفويض لا يمكن أن تتجاوز سنة واحدة.',
  NOT_VEHICLE_OWNER: 'المركبة غير مرتبطة بملكية حسابك.',
  VEHICLE_NOT_AVAILABLE: 'المركبة غير متاحة للتفويض الآن.',
  VEHICLE_RESTRICTED: 'المركبة عليها قيد يمنع التفويض.',
  LIVE_AUTHORIZATION_EXISTS: 'يوجد تفويض معلق أو سارٍ لهذه المركبة ولهذا الطرف.',
  OWNER_PHONE_NOT_VERIFIED: 'يجب توثيق رقم جوالك أولًا.',
  OWNER_IDENTITY_NOT_VERIFIED: 'يجب توثيق هويتك وربط الرقم الوطني أولًا.',
  RATE_LIMITED: 'وصلت إلى الحد المؤقت لإنشاء التفويضات. حاول لاحقًا.',
};

function localDateTime(daysFromNow: number) {
  const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export default function NewAuthorizationPage() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [form, setForm] = useState(() => ({ vehicleId: '', authorizedPhone: '', type: 'SELL_ONLY', minPrice: '', validUntil: localDateTime(30) }));
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [meResponse, vehicleResponse] = await Promise.all([
          fetch('/api/me', { cache: 'no-store', signal: controller.signal }),
          fetch('/api/vehicles', { cache: 'no-store', signal: controller.signal }),
        ]);
        if (meResponse.status === 401) { router.replace('/auth/login?next=/authorizations/new'); return; }
        const [meResult, vehicleResult] = await Promise.all([meResponse.json(), vehicleResponse.json()]);
        if (!meResponse.ok || !meResult.ok) throw new Error('ACCOUNT_UNAVAILABLE');
        setMe(meResult.user);
        if (vehicleResponse.ok && vehicleResult.ok) setVehicles(vehicleResult.vehicles || []);
        else throw new Error('VEHICLES_UNAVAILABLE');
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError('تعذر تحميل بيانات إنشاء التفويض.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [router]);

  const availableVehicles = useMemo(() => vehicles.filter(vehicle => vehicle.status === 'ACTIVE' && !vehicle.isReserved && !vehicle.hasLegalBlock && !['BLOCKED', 'RESTRICTED'].includes(vehicle.governmentStatus)), [vehicles]);
  const identityReady = me ? ['VERIFIED', 'IDENTITY_VERIFIED', 'IDENTITY_FACE_VERIFIED', 'ADVANCED_VERIFIED'].includes(me.identityStatus) : false;
  const accountReady = Boolean(identityReady && me?.phoneStatus === 'VERIFIED');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const expiry = new Date(form.validUntil);
      if (Number.isNaN(expiry.getTime())) throw new Error('INVALID_INPUT');
      const response = await fetch('/api/authorizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId: form.vehicleId,
          authorizedPhone: form.authorizedPhone.trim(),
          type: form.type,
          minPrice: form.minPrice ? Number(form.minPrice) : undefined,
          validUntil: expiry.toISOString(),
        }),
      });
      const result = await response.json().catch(() => ({ ok: false, error: 'AUTHORIZATION_CREATE_FAILED' }));
      if (response.status === 401) { router.replace('/auth/login?next=/authorizations/new'); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'AUTHORIZATION_CREATE_FAILED');
      router.push(`/authorizations/${result.authorization.id}`);
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : 'AUTHORIZATION_CREATE_FAILED';
      setError(ERROR_TEXT[code] || 'تعذر إنشاء التفويض. حاول مرة أخرى.');
    } finally {
      setSubmitting(false);
    }
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-3xl p-4 md:p-7">
    <Link href="/authorizations" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>التفويضات</Link>
    <header><h1 className="text-2xl font-black">إنشاء تفويض بيع</h1><p className="mt-2 text-sm leading-7 text-slate-500">أدخل رقم الجوال المسجل للطرف الذي تريد تفويضه. بعد الإنشاء تؤكد أنت أولًا برمز OTP، ثم يراجع الطرف الشروط ويؤكد قبوله برمز مستقل.</p></header>

    <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-950"><CircleAlert className="mb-2"/><strong>ليس تكاملًا حكوميًا:</strong> هذا التفويض داخل منصة مركبات ولا يُعرض كمستند صادر عن المرور. تحقّق من متطلبات الجهة المختصة قبل الاعتماد عليه خارج المنصة.</div>

    {!loading && !accountReady && <section className="mt-5 rounded-2xl border bg-white p-5"><h2 className="font-black">أكمل توثيق الحساب</h2><p className="mt-2 text-sm text-slate-500">إنشاء التفويضات يتطلب جوالًا موثقًا وهوية موثقة مرتبطة برقم وطني.</p><Link href="/account/verification" className="mt-4 inline-block rounded-xl bg-primary-900 px-4 py-2.5 font-bold text-white">الانتقال إلى التوثيق</Link></section>}

    <form onSubmit={submit} className="mt-5 space-y-5 rounded-2xl border bg-white p-5 shadow-sm md:p-7">
      <label className="block text-sm font-bold">المركبة
        <select required disabled={loading || !accountReady} value={form.vehicleId} onChange={event => setForm(current => ({ ...current, vehicleId: event.target.value }))} className="mt-2 w-full rounded-xl border p-3 font-normal disabled:bg-slate-100"><option value="">اختر مركبة نشطة ومتاحة</option>{availableVehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.make} {vehicle.model} {vehicle.year} — {vehicle.plateNumber}</option>)}</select>
      </label>
      <label className="block text-sm font-bold">رقم جوال الطرف المفوض
        <input required minLength={7} maxLength={30} inputMode="tel" autoComplete="tel" disabled={!accountReady} value={form.authorizedPhone} onChange={event => setForm(current => ({ ...current, authorizedPhone: event.target.value }))} placeholder="الرقم المسجل في مركبات" className="mt-2 w-full rounded-xl border p-3 font-normal disabled:bg-slate-100"/>
      </label>
      <fieldset><legend className="text-sm font-bold">نطاق التفويض</legend><div className="mt-2 grid gap-3 sm:grid-cols-2">
        <label className={`cursor-pointer rounded-xl border p-4 ${form.type === 'SELL_ONLY' ? 'border-emerald-600 bg-emerald-50' : ''}`}><input type="radio" name="type" value="SELL_ONLY" checked={form.type === 'SELL_ONLY'} onChange={event => setForm(current => ({ ...current, type: event.target.value }))} className="ml-2"/><b>البيع فقط</b><span className="mt-1 block text-xs leading-5 text-slate-500">الطرف يبيع، وتذهب الحصيلة إلى حساب استلام المالك الموثق.</span></label>
        <label className={`cursor-pointer rounded-xl border p-4 ${form.type === 'SELL_AND_RECEIVE' ? 'border-emerald-600 bg-emerald-50' : ''}`}><input type="radio" name="type" value="SELL_AND_RECEIVE" checked={form.type === 'SELL_AND_RECEIVE'} onChange={event => setForm(current => ({ ...current, type: event.target.value }))} className="ml-2"/><b>البيع واستلام الحصيلة</b><span className="mt-1 block text-xs leading-5 text-slate-500">يتطلب عند البيع حساب استلام موثقًا باسم الطرف المفوض.</span></label>
      </div></fieldset>
      <label className="block text-sm font-bold">الحد الأدنى للبيع بالريال اليمني (اختياري)
        <input type="number" min="1" max="10000000000000" inputMode="numeric" value={form.minPrice} onChange={event => setForm(current => ({ ...current, minPrice: event.target.value }))} className="mt-2 w-full rounded-xl border p-3 font-normal"/>
      </label>
      <label className="block text-sm font-bold">تاريخ انتهاء التفويض
        <input required type="datetime-local" min={localDateTime(0)} max={localDateTime(366)} value={form.validUntil} onChange={event => setForm(current => ({ ...current, validUntil: event.target.value }))} className="mt-2 w-full rounded-xl border p-3 font-normal"/>
      </label>
      {availableVehicles.length === 0 && !loading && <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">لا توجد مركبة نشطة متاحة. راجع <Link href="/vehicles" className="font-bold underline">مركباتي</Link>.</p>}
      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      <button disabled={loading || submitting || !accountReady || availableVehicles.length === 0} className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50"><ShieldCheck size={19}/>{submitting ? 'جارٍ إنشاء التفويض…' : 'إنشاء التفويض ومتابعة OTP'}</button>
    </form>
  </div></main>;
}
