'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Bell, CarFront, ChevronLeft, FileText, Gavel, Headphones, LogOut, Menu, Search, ShieldCheck, UserCircle, X } from 'lucide-react';

type Listing = {
  id: string;
  price: string;
  currency: string;
  vehicle: { make: string; model: string; year: number; city: string; mileage: number };
};
type User = { id: string; fullName: string };

const menuItems = [
  ['/account', 'الملف الشخصي', UserCircle],
  ['/market', 'السوق', CarFront],
  ['/vehicles', 'مركباتي', CarFront],
  ['/notifications', 'الإشعارات', Bell],
  ['/auctions', 'المزادات', Gavel],
  ['/traffic/ownership-transfer', 'طلبات نقل الملكية', FileText],
  ['/support', 'الدعم الفني واتصل بنا', Headphones],
] as const;

export default function HomePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch('/api/me', { signal: controller.signal }).then(response => response.json()),
      fetch('/api/notifications?unread=1', { signal: controller.signal }).then(response => response.json()).catch(() => ({ unreadCount: 0 })),
    ]).then(([me, notifications]) => {
      if (me.ok) setUser(me.user);
      setUnread(notifications.unreadCount || 0);
    }).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setLoadError('تعذر تحميل بيانات الحساب حالياً.');
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setLoadError('');
      try {
        const response = await fetch(`/api/listings?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'LISTINGS_UNAVAILABLE');
        setListings(result.listings || []);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setListings([]);
        setLoadError('تعذر تحميل السوق. تحقق من الاتصال ثم حاول مجددًا.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query ? 300 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => {
    if (!menu) return;
    const previousOverflow = document.body.style.overflow;
    const returnFocus = menuButton.current;
    document.body.style.overflow = 'hidden';
    const panel = drawer.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') || []);
    focusable()[0]?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenu(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      returnFocus?.focus();
    };
  }, [menu]);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/auth/login');
  }

  return <main className="min-h-screen bg-slate-50" dir="rtl">
    <header className="sticky top-0 z-40 border-b bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        <button ref={menuButton} onClick={() => setMenu(true)} className="relative rounded-xl border p-2 hover:bg-slate-50" aria-label="فتح القائمة" aria-expanded={menu} aria-controls="main-drawer">
          <Menu size={23}/>{unread > 0 && <span aria-label={`${unread} إشعار غير مقروء`} className="absolute -left-1 -top-1 min-w-5 rounded-full bg-red-600 px-1 text-center text-[10px] text-white">{unread > 99 ? '99+' : unread}</span>}
        </button>
        <Link href="/" className="text-2xl font-black text-primary-900">مركبات</Link>
        <Link href={user ? '/account' : '/auth/login'} aria-label={user ? 'فتح حسابي' : 'تسجيل الدخول'} className="rounded-full bg-primary-900 p-2 text-white"><UserCircle size={22}/></Link>
      </div>
    </header>

    {menu && <div className="fixed inset-0 z-50">
      <button tabIndex={-1} className="absolute inset-0 bg-black/40" onClick={() => setMenu(false)} aria-label="إغلاق القائمة"/>
      <aside ref={drawer} id="main-drawer" role="dialog" aria-modal="true" aria-label="القائمة الرئيسية" className="absolute right-0 top-0 h-full w-[86%] max-w-sm overflow-y-auto bg-white p-5 shadow-2xl">
        <div className="mb-7 flex items-center justify-between"><div><div className="text-xl font-black text-primary-900">حسابي</div><div className="text-sm text-slate-500">{user?.fullName || 'زائر'}</div></div><button onClick={() => setMenu(false)} aria-label="إغلاق القائمة" className="rounded-xl border p-2"><X/></button></div>
        <nav aria-label="روابط الحساب" className="space-y-2">
          {menuItems.map(([href, label, Icon]) => <Link key={href} href={href} onClick={() => setMenu(false)} className="flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-slate-50"><Icon size={20}/><span className="flex-1">{label}</span>{label === 'الإشعارات' && unread > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">{unread}</span>}<ChevronLeft aria-hidden="true" size={16}/></Link>)}
          <div className="my-3 border-t"/>
          {user ? <button onClick={logout} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-red-600 hover:bg-red-50"><LogOut size={20}/>تسجيل الخروج</button> : <Link href="/auth/login" className="flex items-center gap-3 rounded-xl px-4 py-3 text-primary-900"><ShieldCheck size={20}/>تسجيل الدخول</Link>}
        </nav>
      </aside>
    </div>}

    <div className="mx-auto max-w-7xl px-4 py-7">
      <section className="rounded-3xl bg-gradient-to-l from-primary-900 to-slate-800 p-6 text-white shadow-lg md:p-9">
        <p className="mb-2 text-sm text-emerald-100">منصة المركبات والخدمات المرورية في اليمن</p>
        <h1 className="text-3xl font-black md:text-4xl">{user ? `مرحباً ${user.fullName}` : 'أهلاً بك في مركبات'}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-200">سوق مركبات، مزادات، نقل ملكية، متابعة العمليات، وإشعارات الحساب في مكان واحد.</p>
        <div className="mt-6 flex flex-wrap gap-3"><Link href="/market" className="rounded-xl bg-white px-4 py-2.5 font-bold text-primary-900">تصفح السوق</Link><Link href="/auctions" className="rounded-xl border border-white/30 px-4 py-2.5 font-bold">المزادات</Link><Link href="/traffic/ownership-transfer" className="rounded-xl border border-white/30 px-4 py-2.5 font-bold">نقل الملكية</Link></div>
      </section>

      <section aria-label="الخدمات" className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-6">
        {[
          ['السوق', '/market', CarFront], ['المزادات', '/auctions', Gavel], ['نقل الملكية', '/traffic/ownership-transfer', FileText],
          ['الإشعارات', '/notifications', Bell], ['الدعم', '/support', Headphones], ['حسابي', '/account', UserCircle],
        ].map(([label, href, Icon]) => <Link href={String(href)} key={String(label)} className="rounded-2xl border bg-white p-4 text-center shadow-sm hover:-translate-y-0.5 hover:shadow"><Icon className="mx-auto mb-2 text-primary-900" size={24}/><span className="text-sm font-bold">{String(label)}</span></Link>)}
      </section>

      <section className="mt-8" aria-labelledby="market-heading">
        <div className="mb-4 flex items-end justify-between gap-3"><div><h2 id="market-heading" className="text-2xl font-black">المركبات المعروضة</h2><p className="text-sm text-slate-500">نعرض الإعلانات المنشورة والمتاحة فقط، دون بيانات الملكية الحساسة.</p></div><Link href="/market" className="text-sm font-bold text-primary-900">عرض الكل</Link></div>
        <label className="mb-4 block"><span className="sr-only">البحث في السوق</span><span className="relative block"><Search aria-hidden="true" className="absolute right-4 top-3.5 text-slate-400" size={20}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="ابحث بالماركة أو الموديل أو المدينة" className="w-full rounded-2xl border bg-white py-3 pl-4 pr-11 outline-none focus:ring-2 focus:ring-emerald-200"/></span></label>
        {loadError && <div role="alert" className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800">{loadError}</div>}
        {loading ? <div role="status" className="rounded-2xl border bg-white p-8 text-center text-slate-500">جارٍ تحميل السوق…</div> : <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {listings.map(listing => <Link href={`/market/${listing.id}`} key={listing.id} className="rounded-2xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
            <div className="flex items-start justify-between"><div><h3 className="text-lg font-black">{listing.vehicle.make} {listing.vehicle.model}</h3><p className="text-sm text-slate-500">{listing.vehicle.year} · {listing.vehicle.city}</p></div><CarFront className="text-primary-900"/></div>
            <div className="mt-4 flex justify-between border-t pt-3 text-sm"><span>{Number(listing.vehicle.mileage).toLocaleString('ar-YE')} كم</span><strong>{Number(listing.price).toLocaleString('ar-YE')} {listing.currency === 'YER' ? 'ريال' : listing.currency}</strong></div>
          </Link>)}
          {listings.length === 0 && <div className="rounded-2xl border bg-white p-8 text-center text-slate-500 md:col-span-2 lg:col-span-3">لا توجد إعلانات مطابقة حالياً.</div>}
        </div>}
      </section>
    </div>
  </main>;
}
