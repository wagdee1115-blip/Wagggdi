'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowRight, Gavel, ShieldCheck, Trophy } from 'lucide-react';

type AuctionDetail = {
  id: string;
  currentPrice: string;
  startingPrice: string;
  minimumIncrement: string;
  bidDepositAmount?: string | null;
  bidDepositCurrency?: string;
  startAt: string;
  endAt: string;
  status: string;
  phase: 'LIVE' | 'UPCOMING' | 'ENDED';
  vehicle: { make: string; model: string; year: number; city: string; mileage: number; transmission: string; fuelType: string; color: string };
};
type Bid = { id: string; amount: string; createdAt: string; bidderName: string };
type Participation = {
  isSeller: boolean;
  isWinner: boolean;
  saleId?: string | null;
  myBids: Array<{ id: string; amount: string; createdAt: string }>;
  autoBid?: { maxAmount: string; isActive: boolean } | null;
  deposit?: { status: string; amount: string; currency: string } | null;
};

function requestKey(prefix: string) {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? `${prefix}:${crypto.randomUUID()}` : `${prefix}:${Date.now()}`;
}

const messages: Record<string, string> = {
  UNAUTHORIZED: 'سجّل الدخول أولاً.',
  IDENTITY_NOT_VERIFIED: 'يجب توثيق الهوية قبل المشاركة.',
  PHONE_NOT_VERIFIED: 'يجب توثيق رقم الهاتف قبل المشاركة.',
  BID_DEPOSIT_REQUIRED: 'احجز العربون أولاً.',
  AUCTION_ENDED: 'المزاد ليس مباشرًا الآن.',
  SELLER_CANNOT_BID: 'لا يمكنك المزايدة على مركبتك.',
  AUCTION_CANNOT_BE_CANCELLED: 'لا يمكن إلغاء المزاد بعد بدايته أو بعد أول مزايدة.',
  'NOT_CONFIGURED:AUCTION_DEPOSIT_PROVIDER_REQUIRED': 'مزود العربون غير مفعّل حاليًا.',
};

export default function AuctionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [auction, setAuction] = useState<AuctionDetail | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [participation, setParticipation] = useState<Participation | null>(null);
  const [amount, setAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (signal?: AbortSignal, background = false) => {
    if (!background) setLoading(true);
    try {
      const response = await fetch(`/api/auctions/${id}`, { signal });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'AUCTION_UNAVAILABLE');
      setAuction(result.auction);
      setBids(result.bids || []);
      setParticipation(result.participation || null);
      setError('');
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setError('تعذر تحميل المزاد أو أنه غير موجود.');
    } finally {
      if (!background && !signal?.aborted) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    let pollInFlight = false;
    const poll = window.setInterval(async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try { await load(controller.signal, true); }
      finally { pollInFlight = false; }
    }, 8_000);
    return () => { window.clearTimeout(timer); window.clearInterval(poll); controller.abort(); };
  }, [load]);

  async function mutate(path: string, body: unknown, headers?: Record<string, string>) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        if (result.error === 'MINIMUM_BID_NOT_MET') throw new Error(`الحد الأدنى الحالي ${Number(result.minimum).toLocaleString('ar-YE')} ريال.`);
        if (result.error === 'MIN_AUTO_BID') throw new Error(`ارفع الحد الأقصى للمزايدة الآلية.`);
        throw new Error(result.error || 'ACTION_FAILED');
      }
      setNotice('تم تنفيذ الطلب بنجاح.');
      await load();
      return true;
    } catch (mutationError) {
      const code = mutationError instanceof Error ? mutationError.message : 'ACTION_FAILED';
      setError(messages[code] || code);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function bid(event: FormEvent) {
    event.preventDefault();
    if (await mutate(`/api/auctions/${id}/bids`, { amount: Number(amount) }, { 'Idempotency-Key': requestKey(`AUCTION_BID:${id}`) })) setAmount('');
  }

  async function autoBid(event: FormEvent) {
    event.preventDefault();
    if (await mutate(`/api/auctions/${id}/auto-bid`, { maxAmount: Number(maxAmount) })) setMaxAmount('');
  }

  async function cancelAuction() {
    if (!window.confirm('هل تريد إلغاء المزاد قبل بدايته؟')) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/auctions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'CANCEL' }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'CANCEL_FAILED');
      setNotice('تم إلغاء المزاد وفك حجز المركبة.');
      await load();
    } catch (cancelError) {
      const code = cancelError instanceof Error ? cancelError.message : 'CANCEL_FAILED';
      setError(messages[code] || code);
    } finally {
      setPending(false);
    }
  }

  if (loading) return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div role="status" className="mx-auto max-w-3xl rounded-2xl border bg-white p-8 text-center">جارٍ تحميل المزاد…</div></main>;
  if (!auction) return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div role="alert" className="mx-auto max-w-3xl rounded-2xl border border-red-200 bg-red-50 p-8 text-center">{error || 'المزاد غير موجود.'}<div><Link href="/auctions" className="mt-4 inline-block font-bold text-primary-900">العودة للمزادات</Link></div></div></main>;

  const live = auction.phase === 'LIVE';
  const upcoming = auction.phase === 'UPCOMING';
  const minimum = Number(auction.currentPrice) + Number(auction.minimumIncrement);

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-4xl p-4 md:p-7">
    <Link href="/auctions" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>المزادات</Link>
    <section className="rounded-3xl border bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-bold text-emerald-700">{live ? 'مزاد مباشر' : upcoming ? 'مزاد قادم' : 'مزاد منتهي'}</p><h1 className="mt-1 text-3xl font-black">{auction.vehicle.make} {auction.vehicle.model}</h1><p className="mt-2 text-slate-500">{auction.vehicle.year} · {auction.vehicle.city} · {Number(auction.vehicle.mileage).toLocaleString('ar-YE')} كم</p></div><Gavel className="text-primary-900" size={34}/></div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-2xl bg-slate-50 p-4">السعر الحالي<br/><b className="text-lg">{Number(auction.currentPrice).toLocaleString('ar-YE')} ريال</b></div><div className="rounded-2xl bg-slate-50 p-4">الزيادة الدنيا<br/><b>{Number(auction.minimumIncrement).toLocaleString('ar-YE')} ريال</b></div><div className="rounded-2xl bg-slate-50 p-4">{upcoming ? 'يبدأ' : 'ينتهي'}<br/><b>{new Date(upcoming ? auction.startAt : auction.endAt).toLocaleString('ar-YE')}</b></div></div>
      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm md:grid-cols-4"><div><dt className="text-slate-500">ناقل الحركة</dt><dd className="font-bold">{auction.vehicle.transmission}</dd></div><div><dt className="text-slate-500">الوقود</dt><dd className="font-bold">{auction.vehicle.fuelType}</dd></div><div><dt className="text-slate-500">اللون</dt><dd className="font-bold">{auction.vehicle.color}</dd></div><div><dt className="text-slate-500">سعر البداية</dt><dd className="font-bold">{Number(auction.startingPrice).toLocaleString('ar-YE')}</dd></div></dl>
    </section>

    {participation?.isWinner && <section className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-5"><div className="flex items-center gap-2 font-black text-emerald-900"><Trophy/>أنت الفائز بهذا المزاد</div>{participation.saleId && <Link href={`/transfers/${participation.saleId}`} className="mt-3 inline-block rounded-xl bg-primary-900 px-4 py-2 font-bold text-white">متابعة الدفع ونقل الملكية</Link>}</section>}
    {participation?.isSeller && upcoming && <button disabled={pending} onClick={cancelAuction} className="mt-5 rounded-xl border border-red-300 bg-white px-4 py-2 font-bold text-red-700 disabled:opacity-50">إلغاء المزاد قبل بدايته</button>}

    {live && !participation && <section className="mt-5 rounded-2xl border bg-white p-5 text-center"><p className="text-sm text-slate-600">سجّل الدخول لحجز العربون والمزايدة.</p><Link href={`/auth/login?next=/auctions/${id}`} className="mt-3 inline-block rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تسجيل الدخول للمشاركة</Link></section>}
    {live && participation && !participation.isSeller && <section className="mt-5 grid gap-4 md:grid-cols-2">
      <div className="rounded-2xl border bg-white p-5"><h2 className="font-black">المشاركة</h2>{Number(auction.bidDepositAmount || 0) > 0 && <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm"><div className="flex items-center gap-2 font-bold"><ShieldCheck size={18}/>العربون {Number(auction.bidDepositAmount).toLocaleString('ar-YE')} {auction.bidDepositCurrency}</div><p className="mt-1">الحالة: {participation?.deposit?.status || 'غير محجوز'}</p>{participation?.deposit?.status !== 'HOLD' && <button disabled={pending} onClick={() => mutate(`/api/auctions/${id}/deposit`, { idempotencyKey: requestKey(`AUCTION_DEPOSIT:${id}`) })} className="mt-3 rounded-lg border bg-white px-3 py-2 font-bold">حجز العربون</button>}</div>}
        <form onSubmit={bid} className="mt-4"><label className="text-sm font-bold">قيمة المزايدة<input required min={minimum} type="number" value={amount} onChange={event => setAmount(event.target.value)} placeholder={minimum.toLocaleString('ar-YE')} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label><button disabled={pending} className="mt-3 w-full rounded-xl bg-primary-900 p-3 font-bold text-white disabled:opacity-50">إرسال المزايدة</button></form>
      </div>
      <form onSubmit={autoBid} className="rounded-2xl border bg-white p-5"><h2 className="font-black">المزايدة الآلية</h2><p className="mt-2 text-sm leading-6 text-slate-500">حدد الحد الأقصى، وسيزايد النظام بأقل زيادة لازمة دون كشف حدك للآخرين.</p><label className="mt-4 block text-sm font-bold">الحد الأقصى<input required min={minimum} type="number" value={maxAmount} onChange={event => setMaxAmount(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label><button disabled={pending} className="mt-3 w-full rounded-xl border p-3 font-bold disabled:opacity-50">حفظ المزايدة الآلية</button>{participation?.autoBid?.isActive && <p className="mt-3 text-sm text-emerald-800">الحد الحالي: {Number(participation.autoBid.maxAmount).toLocaleString('ar-YE')} ريال</p>}</form>
    </section>}

    {(notice || error) && <div role={error ? 'alert' : 'status'} aria-live="polite" className={`mt-5 rounded-xl border p-4 ${error ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{error || notice}</div>}

    <section className="mt-5 rounded-2xl border bg-white p-5"><h2 className="text-xl font-black">سجل المزايدات</h2><p className="mt-1 text-sm text-slate-500">الأسماء مخفية لحماية المشاركين.</p><div className="mt-4 space-y-2">{bids.map((entry, index) => <div key={entry.id} className="flex items-center justify-between rounded-xl bg-slate-50 p-3 text-sm"><span>{index === 0 ? 'أعلى مزايدة' : entry.bidderName}</span><span><b>{Number(entry.amount).toLocaleString('ar-YE')} ريال</b><small className="mr-2 text-slate-500">{new Date(entry.createdAt).toLocaleString('ar-YE')}</small></span></div>)}{bids.length === 0 && <p className="rounded-xl bg-slate-50 p-5 text-center text-slate-500">لا توجد مزايدات بعد.</p>}</div></section>
  </div></main>;
}
