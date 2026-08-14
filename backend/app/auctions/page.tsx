'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Gavel, Plus, Search, ShieldCheck } from 'lucide-react';

type Auction = {
  id: string;
  currentPrice: string;
  minimumIncrement: string;
  bidDepositAmount?: string | null;
  bidDepositCurrency?: string;
  startAt: string;
  endAt: string;
  status: string;
  vehicle: { make: string; model: string; year: number; city: string };
};
type OwnerVehicle = { id: string; make: string; model: string; year: number; status: string; isReserved: boolean };
type Tab = 'live' | 'upcoming' | 'ended';

function operationKey(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

const errorText: Record<string, string> = {
  UNAUTHORIZED: 'يجب تسجيل الدخول قبل تنفيذ هذه الخطوة.',
  PHONE_NOT_VERIFIED: 'يجب توثيق رقم الجوال أولاً.',
  IDENTITY_NOT_VERIFIED: 'يجب توثيق الهوية وربط الرقم الوطني أولاً.',
  PAYOUT_ACCOUNT_REQUIRED: 'أضف حساب استلام موثقًا ومطابقًا لاسمك قبل إنشاء المزاد.',
  IDEMPOTENCY_KEY_REQUIRED: 'تعذر إنشاء معرف آمن للمزايدة. أعد المحاولة.',
  IDEMPOTENCY_KEY_REUSED: 'استُخدم معرّف الطلب لعملية مختلفة. أعد المحاولة.',
  BID_DEPOSIT_REQUIRED: 'يجب حجز عربون المزاد قبل إرسال المزايدة.',
  SELLER_CANNOT_BID: 'لا يمكن لمالك المزاد المزايدة على مركبته.',
  AUCTION_ENDED: 'المزاد غير مباشر الآن أو انتهى.',
  VEHICLE_RESTRICTED: 'المركبة موقوفة أو مقيدة.',
  VEHICLE_ALREADY_RESERVED: 'المركبة محجوزة في عملية أخرى.',
  VEHICLE_ALREADY_IN_AUCTION: 'للمركبة مزاد نشط بالفعل.',
  BID_DEPOSIT_EXCEEDS_STARTING_PRICE: 'لا يمكن أن يتجاوز العربون سعر البداية.',
  'NOT_CONFIGURED:AUCTION_DEPOSIT_PROVIDER_REQUIRED': 'بوابة حجز عربون المزاد غير مفعلة حالياً.',
  BID_DEPOSIT_PROVIDER_FAILED: 'تعذر الاتصال بمزود حجز العربون.',
  BID_DEPOSIT_NOT_HELD: 'لم يتم تأكيد حجز العربون.',
};

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'live', label: 'مباشر' },
  { id: 'upcoming', label: 'قادم' },
  { id: 'ended', label: 'منتهي' },
];

export default function AuctionsPage() {
  const [items, setItems] = useState<Auction[]>([]);
  const [vehicles, setVehicles] = useState<OwnerVehicle[]>([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [tab, setTab] = useState<Tab>('live');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [bid, setBid] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [depositReady, setDepositReady] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createMessage, setCreateMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [create, setCreate] = useState({ vehicleId: '', startingPrice: '', minimumIncrement: '1000', bidDepositAmount: '', startAt: '', endAt: '' });

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch('/api/me', { signal: controller.signal }).then(response => response.json()),
      fetch('/api/vehicles', { signal: controller.signal }).then(response => response.json()).catch(() => ({ ok: false })),
    ]).then(([me, owned]) => {
      setAuthenticated(Boolean(me.ok));
      if (owned.ok) setVehicles(owned.vehicles || []);
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const loadAuctions = async (showLoading: boolean) => {
      if (inFlight) return;
      inFlight = true;
      const query = new URLSearchParams({ tab });
      if (make.trim()) query.set('make', make.trim());
      if (model.trim()) query.set('model', model.trim());
      if (year.trim()) query.set('year', year.trim());
      if (showLoading) setLoading(true);
      try {
        const response = await fetch(`/api/auctions?${query}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'AUCTIONS_UNAVAILABLE');
        setItems(result.auctions || []);
        setLoadError('');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (showLoading) setItems([]);
        setLoadError('تعذر تحميل المزادات. تحقق من الاتصال وحاول مرة أخرى.');
      } finally {
        inFlight = false;
        if (showLoading && !controller.signal.aborted) setLoading(false);
      }
    };
    const timer = window.setTimeout(() => void loadAuctions(true), make || model || year ? 300 : 0);
    const poll = tab === 'live' ? window.setInterval(() => void loadAuctions(false), 10_000) : undefined;
    return () => { window.clearTimeout(timer); if (poll) window.clearInterval(poll); controller.abort(); };
  }, [make, model, year, tab, refreshVersion]);

  const availableVehicles = useMemo(() => vehicles.filter(vehicle => vehicle.status === 'ACTIVE' && !vehicle.isReserved), [vehicles]);

  async function holdDeposit(auction: Auction) {
    setPending(current => ({ ...current, [auction.id]: true }));
    setMessage(current => ({ ...current, [auction.id]: '' }));
    try {
      const response = await fetch(`/api/auctions/${auction.id}/deposit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: operationKey(`AUCTION_DEPOSIT:${auction.id}`) }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'BID_DEPOSIT_FAILED');
      setDepositReady(current => ({ ...current, [auction.id]: true }));
      setMessage(current => ({ ...current, [auction.id]: 'تم تأكيد حجز العربون ويمكنك المزايدة الآن.' }));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'BID_DEPOSIT_FAILED';
      setMessage(current => ({ ...current, [auction.id]: errorText[code] || code }));
    } finally {
      setPending(current => ({ ...current, [auction.id]: false }));
    }
  }

  async function placeBid(auction: Auction) {
    const amount = Number(bid[auction.id]);
    if (!amount || pending[auction.id]) return;
    setPending(current => ({ ...current, [auction.id]: true }));
    setMessage(current => ({ ...current, [auction.id]: '' }));
    try {
      const response = await fetch(`/api/auctions/${auction.id}/bids`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationKey(`AUCTION_BID:${auction.id}`) }, body: JSON.stringify({ amount }) });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        if (result.error === 'MINIMUM_BID_NOT_MET') throw new Error(`الحد الأدنى للمزايدة: ${Number(result.minimum).toLocaleString('ar-YE')} ريال`);
        throw new Error(result.error || 'BID_FAILED');
      }
      setBid(current => ({ ...current, [auction.id]: '' }));
      setMessage(current => ({ ...current, [auction.id]: 'تم تسجيل المزايدة بنجاح.' }));
      setRefreshVersion(current => current + 1);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'BID_FAILED';
      setMessage(current => ({ ...current, [auction.id]: errorText[code] || code }));
    } finally {
      setPending(current => ({ ...current, [auction.id]: false }));
    }
  }

  async function createAuction(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setCreateMessage('');
    try {
      const payload = {
        vehicleId: create.vehicleId,
        startingPrice: Number(create.startingPrice),
        minimumIncrement: Number(create.minimumIncrement),
        ...(create.bidDepositAmount ? { bidDepositAmount: Number(create.bidDepositAmount) } : {}),
        ...(create.startAt ? { startAt: new Date(create.startAt).toISOString() } : {}),
        endAt: new Date(create.endAt).toISOString(),
      };
      const response = await fetch('/api/auctions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        const issue = result.details?.fieldErrors?.bidDepositAmount?.[0];
        throw new Error(issue || result.error || 'AUCTION_CREATE_FAILED');
      }
      setCreateMessage('تم إنشاء المزاد وحجز المركبة له بنجاح.');
      setCreate({ vehicleId: '', startingPrice: '', minimumIncrement: '1000', bidDepositAmount: '', startAt: '', endAt: '' });
      setTab(new Date(result.auction.startAt) > new Date() ? 'upcoming' : 'live');
      setRefreshVersion(current => current + 1);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'AUCTION_CREATE_FAILED';
      setCreateMessage(errorText[code] || code);
    } finally {
      setCreating(false);
    }
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-5xl p-4 md:p-7">
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><Link href="/" className="flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight/>الرئيسية</Link><h1 className="text-2xl font-black">المزادات</h1>{authenticated ? <button onClick={() => setShowCreate(value => !value)} aria-expanded={showCreate} className="flex items-center gap-2 rounded-xl bg-primary-900 px-4 py-2 font-bold text-white"><Plus size={18}/>{showCreate ? 'إغلاق النموذج' : 'إنشاء مزاد'}</button> : <Link href="/auth/login" className="rounded-xl border px-4 py-2 font-bold">سجّل للدخول</Link>}</div>

    {showCreate && <form onSubmit={createAuction} className="mb-6 rounded-2xl border bg-white p-5 shadow-sm">
      <h2 className="text-xl font-black">إنشاء مزاد لمركبتي</h2><p className="mt-1 text-sm text-slate-500">يشترط توثيق الهاتف والهوية وحساب الاستلام، وأن تكون المركبة متاحة بلا قيود.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="text-sm font-bold">المركبة<select required value={create.vehicleId} onChange={event => setCreate({ ...create, vehicleId: event.target.value })} className="mt-2 w-full rounded-xl border p-3 font-normal"><option value="">اختر مركبة متاحة</option>{availableVehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.make} {vehicle.model} — {vehicle.year}</option>)}</select></label>
        <label className="text-sm font-bold">سعر البداية بالريال<input required min={50000} type="number" value={create.startingPrice} onChange={event => setCreate({ ...create, startingPrice: event.target.value })} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
        <label className="text-sm font-bold">الحد الأدنى للزيادة<input required min={1} type="number" value={create.minimumIncrement} onChange={event => setCreate({ ...create, minimumIncrement: event.target.value })} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
        <label className="text-sm font-bold">العربون (اختياري)<input min={0} type="number" value={create.bidDepositAmount} onChange={event => setCreate({ ...create, bidDepositAmount: event.target.value })} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
        <label className="text-sm font-bold">وقت البداية (اختياري)<input type="datetime-local" value={create.startAt} onChange={event => setCreate({ ...create, startAt: event.target.value })} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
        <label className="text-sm font-bold">وقت النهاية<input required type="datetime-local" value={create.endAt} onChange={event => setCreate({ ...create, endAt: event.target.value })} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
      </div>
      <button disabled={creating || availableVehicles.length === 0} className="mt-4 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50">{creating ? 'جارٍ الإنشاء…' : 'إنشاء المزاد'}</button>
      {availableVehicles.length === 0 && <p className="mt-3 text-sm text-amber-800">لا توجد مركبة نشطة وغير محجوزة. أضف مركبة أو أكمل تفعيلها أولاً.</p>}
      {createMessage && <p role="alert" className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">{createMessage}</p>}
    </form>}

    <div className="mb-4 flex gap-2" role="tablist" aria-label="حالة المزاد">{tabs.map((item, index) => <button key={item.id} id={`auction-tab-${item.id}`} role="tab" aria-controls="auction-results" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const offset = event.key === 'ArrowLeft' ? 1 : -1; const next = tabs[(index + offset + tabs.length) % tabs.length]; setTab(next.id); window.requestAnimationFrame(() => document.getElementById(`auction-tab-${next.id}`)?.focus()); }} className={`rounded-xl px-4 py-2 text-sm font-bold ${tab === item.id ? 'bg-primary-900 text-white' : 'border bg-white'}`}>{item.label}</button>)}</div>
    <div className="mb-5 grid gap-3 rounded-2xl border bg-white p-4 md:grid-cols-3">
      <label className="text-sm font-bold">الماركة<input value={make} onChange={event => setMake(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
      <label className="text-sm font-bold">الموديل<input value={model} onChange={event => setModel(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
      <label className="text-sm font-bold">السنة<input value={year} onChange={event => setYear(event.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" className="mt-2 w-full rounded-xl border p-3 font-normal"/></label>
    </div>
    <p className="mb-4 flex items-center gap-2 text-sm text-slate-500"><Search size={17}/> الفلاتر تطابق بيانات المركبة الفعلية.</p>
    {loadError && <div role="alert" className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800">{loadError}</div>}
    {loading ? <div role="status" className="rounded-2xl border bg-white p-8 text-center text-slate-500">جارٍ تحميل المزادات…</div> : <div id="auction-results" role="tabpanel" aria-labelledby={`auction-tab-${tab}`} className="grid gap-4 md:grid-cols-2">
      {items.map(auction => <article key={auction.id} className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="flex justify-between"><div><h2 className="text-xl font-black">{auction.vehicle.make} {auction.vehicle.model}</h2><p className="text-sm text-slate-500">{auction.vehicle.year} · {auction.vehicle.city}</p></div><Gavel className="text-primary-900"/></div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-slate-50 p-3">الحالي<br/><b>{Number(auction.currentPrice).toLocaleString('ar-YE')} ريال</b></div><div className="rounded-xl bg-slate-50 p-3">{tab === 'upcoming' ? 'يبدأ' : 'ينتهي'}<br/><b>{new Date(tab === 'upcoming' ? auction.startAt : auction.endAt).toLocaleString('ar-YE')}</b></div></div>
        {tab === 'live' && authenticated && Number(auction.bidDepositAmount || 0) > 0 && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><div className="flex items-center gap-2 font-bold"><ShieldCheck size={18}/>عربون مطلوب: {Number(auction.bidDepositAmount).toLocaleString('ar-YE')} {auction.bidDepositCurrency || 'YER'}</div>{!depositReady[auction.id] && <button disabled={pending[auction.id]} onClick={() => holdDeposit(auction)} className="mt-3 rounded-lg border border-amber-300 bg-white px-4 py-2 font-bold disabled:opacity-50">حجز العربون</button>}</div>}
        {tab === 'live' && authenticated && <div className="mt-4 flex gap-2"><label className="min-w-0 flex-1"><span className="sr-only">قيمة المزايدة</span><input value={bid[auction.id] || ''} onChange={event => setBid({ ...bid, [auction.id]: event.target.value.replace(/\D/g, '') })} placeholder={`الحد الأدنى ${(Number(auction.currentPrice) + Number(auction.minimumIncrement)).toLocaleString('ar-YE')}`} inputMode="numeric" className="w-full rounded-xl border p-3"/></label><button disabled={pending[auction.id]} onClick={() => placeBid(auction)} className="rounded-xl bg-primary-900 px-4 font-bold text-white disabled:opacity-50">{pending[auction.id] ? '…' : 'زايد'}</button></div>}
        {tab === 'live' && !authenticated && <Link href={`/auth/login?next=/auctions/${auction.id}`} className="mt-4 block rounded-xl bg-primary-900 px-4 py-3 text-center font-bold text-white">سجّل الدخول للمزايدة</Link>}
        {message[auction.id] && <div role="status" aria-live="polite" className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">{message[auction.id]}</div>}
        <Link href={`/auctions/${auction.id}`} className="mt-4 block rounded-xl border px-4 py-2 text-center font-bold text-primary-900">التفاصيل وسجل المزايدات</Link>
      </article>)}
      {items.length === 0 && <div className="rounded-2xl border bg-white p-8 text-center text-slate-500 md:col-span-2">لا توجد مزادات مطابقة في هذه الحالة.</div>}
    </div>}
    <div className="mt-5 rounded-2xl border bg-amber-50 p-4 text-sm leading-7">الحد الأدنى للمزاد 50,000 ريال يمني. عند وصول مزايدة خلال آخر دقيقتين تمتد النهاية دقيقتين تلقائياً، وتبقى أسماء المزايدين مخفية.</div>
  </div></main>;
}
