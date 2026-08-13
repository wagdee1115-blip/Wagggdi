'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Gavel, Search, ShieldCheck } from 'lucide-react';

function operationKey(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

const errorText: Record<string, string> = {
  UNAUTHORIZED: 'يجب تسجيل الدخول قبل المزايدة.',
  PHONE_NOT_VERIFIED: 'يجب توثيق رقم الجوال قبل المزايدة.',
  IDEMPOTENCY_KEY_REQUIRED: 'تعذر إنشاء معرف آمن للمزايدة. أعد المحاولة.',
  BID_DEPOSIT_REQUIRED: 'يجب حجز عربون المزاد قبل إرسال المزايدة.',
  SELLER_CANNOT_BID: 'لا يمكن لمالك المزاد المزايدة على مركبته.',
  AUCTION_ENDED: 'انتهى المزاد.',
  VEHICLE_RESTRICTED: 'المركبة موقوفة أو مقيدة.',
  'NOT_CONFIGURED:AUCTION_DEPOSIT_PROVIDER_REQUIRED': 'بوابة حجز عربون المزاد غير مفعلة حالياً.',
  BID_DEPOSIT_PROVIDER_FAILED: 'تعذر الاتصال بمزود حجز العربون.',
  BID_DEPOSIT_NOT_HELD: 'لم يتم تأكيد حجز العربون.',
};

export default function Auctions() {
  const [items, setItems] = useState<any[]>([]);
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [bid, setBid] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [depositReady, setDepositReady] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<Record<string, string>>({});

  async function load() {
    const q = new URLSearchParams();
    if (make) q.set('make', make);
    if (model) q.set('model', model);
    if (year) q.set('year', year);
    const response = await fetch('/api/auctions?' + q);
    const result = await response.json();
    if (result.ok) setItems(result.auctions || []);
  }

  useEffect(() => { load(); }, [make, model, year]);

  async function holdDeposit(a: any) {
    setPending(p => ({ ...p, [a.id]: true }));
    setMessage(m => ({ ...m, [a.id]: '' }));
    try {
      const response = await fetch(`/api/auctions/${a.id}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: operationKey(`AUCTION_DEPOSIT:${a.id}`) }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'BID_DEPOSIT_FAILED');
      setDepositReady(d => ({ ...d, [a.id]: true }));
      setMessage(m => ({ ...m, [a.id]: 'تم تأكيد حجز العربون ويمكنك المزايدة الآن.' }));
    } catch (e) {
      const code = e instanceof Error ? e.message : 'BID_DEPOSIT_FAILED';
      setMessage(m => ({ ...m, [a.id]: errorText[code] || code }));
    } finally {
      setPending(p => ({ ...p, [a.id]: false }));
    }
  }

  async function place(a: any) {
    const amount = Number(bid[a.id]);
    if (!amount || pending[a.id]) return;
    setPending(p => ({ ...p, [a.id]: true }));
    setMessage(m => ({ ...m, [a.id]: '' }));
    try {
      const response = await fetch(`/api/auctions/${a.id}/bids`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': operationKey(`AUCTION_BID:${a.id}`),
        },
        body: JSON.stringify({ amount }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        if (result.error === 'MINIMUM_BID_NOT_MET') throw new Error(`الحد الأدنى للمزايدة: ${Number(result.minimum).toLocaleString('ar-YE')} ريال`);
        throw new Error(result.error || 'BID_FAILED');
      }
      setBid(current => ({ ...current, [a.id]: '' }));
      setMessage(m => ({ ...m, [a.id]: 'تم تسجيل المزايدة بنجاح.' }));
      await load();
    } catch (e) {
      const code = e instanceof Error ? e.message : 'BID_FAILED';
      setMessage(m => ({ ...m, [a.id]: errorText[code] || code }));
    } finally {
      setPending(p => ({ ...p, [a.id]: false }));
    }
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-5xl p-4 md:p-7">
    <div className="mb-6 flex items-center justify-between"><a href="/" className="flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight />الرئيسية</a><h1 className="text-2xl font-black">المزادات</h1></div>
    <div className="mb-5 grid gap-2 rounded-2xl border bg-white p-4 md:grid-cols-3"><input value={make} onChange={e => setMake(e.target.value)} placeholder="الماركة" className="rounded-xl border p-3" /><input value={model} onChange={e => setModel(e.target.value)} placeholder="الموديل" className="rounded-xl border p-3" /><input value={year} onChange={e => setYear(e.target.value)} placeholder="السنة" inputMode="numeric" className="rounded-xl border p-3" /></div>
    <p className="mb-4 flex items-center gap-2 text-sm text-slate-500"><Search size={17} /> الفلترة مرتبطة ببيانات المركبة: الماركة ← الموديل ← السنة، وليست بعنوان الإعلان.</p>
    <div className="grid gap-4 md:grid-cols-2">
      {items.map(a => <article key={a.id} className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="flex justify-between"><div><h2 className="text-xl font-black">{a.vehicle.make} {a.vehicle.model}</h2><p className="text-sm text-slate-500">{a.vehicle.year} · {a.vehicle.city}</p></div><Gavel className="text-primary-900" /></div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-slate-50 p-3">الحالي<br /><b>{Number(a.currentPrice).toLocaleString('ar-YE')} ريال</b></div><div className="rounded-xl bg-slate-50 p-3">ينتهي<br /><b>{new Date(a.endAt).toLocaleString('ar-YE')}</b></div></div>

        {Number(a.bidDepositAmount || 0) > 0 && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><div className="flex items-center gap-2 font-bold"><ShieldCheck size={18} />عربون مطلوب: {Number(a.bidDepositAmount).toLocaleString('ar-YE')} {a.bidDepositCurrency || 'YER'}</div>{!depositReady[a.id] && <button disabled={pending[a.id]} onClick={() => holdDeposit(a)} className="mt-3 rounded-lg border border-amber-300 bg-white px-4 py-2 font-bold disabled:opacity-50">حجز العربون</button>}</div>}

        <div className="mt-4 flex gap-2"><input value={bid[a.id] || ''} onChange={e => setBid({ ...bid, [a.id]: e.target.value })} placeholder={`أقل من ${Number(a.currentPrice) + Number(a.minimumIncrement)} غير مقبول`} inputMode="numeric" className="min-w-0 flex-1 rounded-xl border p-3" /><button disabled={pending[a.id]} onClick={() => place(a)} className="rounded-xl bg-primary-900 px-4 font-bold text-white disabled:opacity-50">{pending[a.id] ? '...' : 'زايد'}</button></div>
        {message[a.id] && <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">{message[a.id]}</div>}
      </article>)}
      {items.length === 0 && <div className="rounded-2xl border bg-white p-8 text-center text-slate-500 md:col-span-2">لا توجد مزادات مطابقة حالياً.</div>}
    </div>
    <div className="mt-5 rounded-2xl border bg-amber-50 p-4 text-sm leading-7">الحد الأدنى للمزاد 50,000 ريال يمني. عند وصول مزايدة خلال آخر دقيقتين تمتد نهاية المزاد دقيقتين تلقائياً لمنع الحسم المفاجئ.</div>
  </div></main>;
}
