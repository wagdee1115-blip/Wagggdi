'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, FileCheck2, FilePlus2, RefreshCw, ShieldCheck } from 'lucide-react';

type AuthorizationSummary = {
  id: string;
  authorizationNumber: string;
  viewerRole: 'OWNER' | 'AUTHORIZED';
  type: 'SELL_ONLY' | 'SELL_AND_RECEIVE';
  status: string;
  minPrice: string | null;
  validUntil: string;
  createdAt: string;
  owner: { fullName: string; phoneMasked: string };
  authorizedParty: { fullName: string; phoneMasked: string };
  vehicle: { plateNumber: string; make: string; model: string; year: number };
  consent: { ownerVerified: boolean; authorizedVerified: boolean };
};

const STATUS_TEXT: Record<string, string> = {
  PENDING: 'بانتظار الموافقات', ACTIVE: 'ساري', REJECTED: 'مرفوض', REVOKED: 'ملغى', EXPIRED: 'منتهي',
};

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-800', ACTIVE: 'bg-emerald-50 text-emerald-800',
  REJECTED: 'bg-red-50 text-red-800', REVOKED: 'bg-slate-100 text-slate-700', EXPIRED: 'bg-slate-100 text-slate-700',
};

export default function AuthorizationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<AuthorizationSummary[]>([]);
  const [tab, setTab] = useState<'ALL' | 'OWNER' | 'AUTHORIZED'>('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/authorizations', { cache: 'no-store', signal });
      const result = await response.json().catch(() => ({ ok: false }));
      if (response.status === 401) { router.replace('/auth/login?next=/authorizations'); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'AUTHORIZATIONS_UNAVAILABLE');
      setItems(result.authorizations || []);
      setError('');
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError('تعذر تحميل التفويضات الآن. حاول مرة أخرى.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  const filtered = useMemo(() => tab === 'ALL' ? items : items.filter(item => item.viewerRole === tab), [items, tab]);

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-5xl p-4 md:p-7">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <Link href="/account" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>الحساب</Link>
      <Link href="/authorizations/new" className="inline-flex items-center gap-2 rounded-xl bg-primary-900 px-4 py-2.5 font-bold text-white"><FilePlus2 size={18}/>تفويض جديد</Link>
    </div>
    <header className="rounded-3xl border bg-white p-6 shadow-sm">
      <div className="flex items-center gap-3"><span className="rounded-2xl bg-emerald-50 p-3 text-emerald-800"><ShieldCheck/></span><div><h1 className="text-2xl font-black">التفويضات</h1><p className="mt-1 text-sm leading-6 text-slate-500">إدارة تفويضات بيع مركباتك والطلبات التي طُلب منك قبولها. لا يصبح التفويض ساريًا إلا بعد OTP مستقل للطرفين.</p></div></div>
    </header>

    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex rounded-xl border bg-white p-1" role="tablist" aria-label="تصفية التفويضات">
        {([['ALL', 'الكل'], ['OWNER', 'صادرة مني'], ['AUTHORIZED', 'مطلوبة مني']] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`rounded-lg px-3 py-2 text-sm font-bold ${tab === value ? 'bg-primary-900 text-white' : 'text-slate-600'}`}>{label}</button>)}
      </div>
      <button onClick={() => { setLoading(true); void load(); }} disabled={loading} className="rounded-xl border bg-white p-2.5 disabled:opacity-50" aria-label="تحديث التفويضات"><RefreshCw size={18}/></button>
    </div>

    {error && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
    {loading ? <div role="status" className="mt-4 rounded-2xl border bg-white p-10 text-center">جارٍ تحميل التفويضات…</div> :
      <section className="mt-4 grid gap-4 md:grid-cols-2">{filtered.map(item => <Link href={`/authorizations/${item.id}`} key={item.id} className="rounded-2xl border bg-white p-5 shadow-sm transition hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-700">
        <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-slate-400">{item.authorizationNumber}</p><h2 className="mt-1 font-black">{item.vehicle.make} {item.vehicle.model} {item.vehicle.year}</h2><p className="text-sm text-slate-500">لوحة {item.vehicle.plateNumber}</p></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${STATUS_STYLE[item.status] || 'bg-slate-100'}`}>{STATUS_TEXT[item.status] || item.status}</span></div>
        <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm"><span className="text-slate-500">{item.viewerRole === 'OWNER' ? 'الطرف المفوض' : 'المالك'}</span><br/><b>{item.viewerRole === 'OWNER' ? item.authorizedParty.fullName : item.owner.fullName}</b> — {item.viewerRole === 'OWNER' ? item.authorizedParty.phoneMasked : item.owner.phoneMasked}</div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><div className="rounded-lg border p-2">موافقة المالك<br/><b>{item.consent.ownerVerified ? 'مؤكدة' : 'معلقة'}</b></div><div className="rounded-lg border p-2">موافقة المفوض<br/><b>{item.consent.authorizedVerified ? 'مؤكدة' : 'معلقة'}</b></div></div>
        <p className="mt-3 text-xs text-slate-500">ينتهي: {new Date(item.validUntil).toLocaleString('ar-YE')}</p>
      </Link>)}
      {filtered.length === 0 && <div className="rounded-2xl border bg-white p-10 text-center text-slate-500 md:col-span-2"><FileCheck2 className="mx-auto mb-3"/><p>لا توجد تفويضات في هذا القسم.</p>{tab !== 'AUTHORIZED' && <Link href="/authorizations/new" className="mt-4 inline-block font-bold text-primary-900 underline">إنشاء تفويض</Link>}</div>}
      </section>}
  </div></main>;
}
