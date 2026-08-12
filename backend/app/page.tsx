'use client';

import { useEffect, useState } from 'react';
import { Bell, CarFront, Gavel, Headphones, Home, LogOut, Menu, UserCircle, X, ChevronLeft, ShieldCheck, FileText } from 'lucide-react';

type Vehicle={id:string;plateNumber:string;make:string;model:string;year:number;price:string|number;city:string;governmentStatus?:string};
type User={id:string;fullName:string;role:string;status:string;identityStatus:string;phoneStatus:string;email?:string;phone?:string};

export default function HomePage(){
  const [user,setUser]=useState<User|null>(null);
  const [vehicles,setVehicles]=useState<Vehicle[]>([]);
  const [query,setQuery]=useState('');
  const [menu,setMenu]=useState(false);
  const [unread,setUnread]=useState(0);

  async function load(){
    const [m,v,n]=await Promise.all([
      fetch('/api/me').then(r=>r.json()),
      fetch(`/api/vehicles?q=${encodeURIComponent(query)}`).then(r=>r.json()),
      fetch('/api/notifications?unread=1').then(r=>r.json()).catch(()=>({unreadCount:0}))
    ]);
    if(m.ok)setUser(m.user);
    if(v.ok)setVehicles(v.vehicles);
    setUnread(n.unreadCount||0);
  }
  useEffect(()=>{load()},[]);
  useEffect(()=>{const t=setTimeout(load,300);return()=>clearTimeout(t)},[query]);

  async function logout(){await fetch('/api/auth/logout',{method:'POST'});location.reload()}

  const menuItems=[
    ['/account','الملف الشخصي',UserCircle],
    ['/vehicles','مركباتي',CarFront],
    ['/notifications','الإشعارات',Bell],
    ['/auctions','المزادات',Gavel],
    ['/traffic/ownership-transfer','طلبات نقل الملكية',FileText],
    ['/support','الدعم الفني واتصل بنا',Headphones],
  ] as const;

  return <main className="min-h-screen bg-slate-50" dir="rtl">
    <header className="sticky top-0 z-40 border-b bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        <button onClick={()=>setMenu(true)} className="relative rounded-xl border p-2 hover:bg-slate-50" aria-label="القائمة">
          <Menu size={23}/>{unread>0&&<span className="absolute -left-1 -top-1 min-w-5 rounded-full bg-red-600 px-1 text-center text-[10px] text-white">{unread>99?'99+':unread}</span>}
        </button>
        <a href="/" className="text-2xl font-black text-primary-900">مركبات</a>
        <a href={user?'/account':'/auth/login'} className="rounded-full bg-primary-900 p-2 text-white"><UserCircle size={22}/></a>
      </div>
    </header>

    {menu&&<div className="fixed inset-0 z-50">
      <button className="absolute inset-0 bg-black/40" onClick={()=>setMenu(false)} aria-label="إغلاق"/>
      <aside className="absolute right-0 top-0 h-full w-[86%] max-w-sm overflow-y-auto bg-white p-5 shadow-2xl">
        <div className="mb-7 flex items-center justify-between"><div><div className="text-xl font-black text-primary-900">حسابي</div><div className="text-sm text-slate-500">{user?.fullName||'زائر'}</div></div><button onClick={()=>setMenu(false)} className="rounded-xl border p-2"><X/></button></div>
        <div className="space-y-2">
          {menuItems.map(([href,label,Icon])=><a key={href} href={href} className="flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-slate-50"><Icon size={20}/><span className="flex-1">{label}</span>{label==='الإشعارات'&&unread>0&&<span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">{unread}</span>}<ChevronLeft size={16}/></a>)}
          <div className="my-3 border-t"/>
          {user?<button onClick={logout} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-red-600 hover:bg-red-50"><LogOut size={20}/>تسجيل الخروج</button>:<a href="/auth/login" className="flex items-center gap-3 rounded-xl px-4 py-3 text-primary-900"><ShieldCheck size={20}/>تسجيل الدخول</a>}
        </div>
      </aside>
    </div>}

    <div className="mx-auto max-w-7xl px-4 py-7">
      <section className="rounded-3xl bg-gradient-to-l from-primary-900 to-slate-800 p-6 text-white shadow-lg md:p-9">
        <p className="mb-2 text-sm text-emerald-100">منصة المركبات والخدمات المرورية في اليمن</p>
        <h1 className="text-3xl font-black md:text-4xl">{user?`مرحباً ${user.fullName}`:'أهلاً بك في مركبات'}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-200">سوق مركبات، مزادات، نقل ملكية، متابعة العمليات، وإشعارات الحساب في مكان واحد.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a href="/auctions" className="rounded-xl bg-white px-4 py-2.5 font-bold text-primary-900">تصفح المزادات</a>
          <a href="/traffic/ownership-transfer" className="rounded-xl border border-white/30 px-4 py-2.5 font-bold">بدء نقل ملكية</a>
        </div>
      </section>

      <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-6">
        {[
          ['السوق','/vehicles',CarFront],['المزادات','/auctions',Gavel],['نقل الملكية','/traffic/ownership-transfer',FileText],
          ['الإشعارات','/notifications',Bell],['الدعم','/support',Headphones],['حسابي','/account',UserCircle]
        ].map(([label,href,Icon]:any)=><a href={href} key={label} className="rounded-2xl border bg-white p-4 text-center shadow-sm hover:-translate-y-0.5 hover:shadow"><Icon className="mx-auto mb-2 text-primary-900" size={24}/><span className="text-sm font-bold">{label}</span></a>)}
      </section>

      <section className="mt-8">
        <div className="mb-4 flex items-end justify-between gap-3"><div><h2 className="text-2xl font-black">المركبات المتاحة</h2><p className="text-sm text-slate-500">البحث يتم من بيانات المركبة الفعلية وليس من عنوان الإعلان.</p></div><a href="/vehicles" className="text-sm font-bold text-primary-900">عرض الكل</a></div>
        <div className="mb-4"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="ابحث بالماركة أو الموديل أو اللوحة..." className="w-full rounded-2xl border bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-emerald-200"/></div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {vehicles.map(v=><article key={v.id} className="rounded-2xl border bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between"><div><h3 className="text-lg font-black">{v.make} {v.model}</h3><p className="text-sm text-slate-500">{v.year} · {v.city}</p></div><CarFront className="text-primary-900"/></div>
            <div className="mt-4 flex justify-between border-t pt-3 text-sm"><span>لوحة: {v.plateNumber}</span><strong>{Number(v.price).toLocaleString('ar-YE')} ريال</strong></div>
          </article>)}
          {vehicles.length===0&&<div className="rounded-2xl border bg-white p-8 text-center text-slate-500 md:col-span-2 lg:col-span-3">لا توجد مركبات مطابقة حالياً.</div>}
        </div>
      </section>
    </div>
  </main>
}
