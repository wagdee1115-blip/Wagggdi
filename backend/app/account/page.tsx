'use client';
import { useEffect,useState } from 'react';
import { ArrowRight, Bell, CarFront, FileText, Headphones, LockKeyhole, ShieldCheck } from 'lucide-react';
export default function Account(){
 const [u,setU]=useState<any>(null);
 useEffect(()=>{fetch('/api/me').then(r=>r.json()).then(x=>{if(x.ok)setU(x.user)})},[]);
 if(!u)return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><a href="/" className="font-bold text-primary-900">← الرئيسية</a><div className="mx-auto mt-12 max-w-xl rounded-2xl bg-white p-8 text-center">يجب تسجيل الدخول لعرض الحساب.</div></main>;
 const items=[
  ['مركباتي','إدارة المركبات المملوكة لك',CarFront,'/vehicles'],
  ['المزادات والمزايدات','المزادات التي شاركت بها ونتائجها',FileText,'/auctions'],
  ['الإشعارات','طلبات النقل، الدفع، المزادات والتنبيهات',Bell,'/notifications'],
  ['الأمان وتسجيل الدخول','الهاتف، كلمة المرور والجلسات',LockKeyhole,'/account/security'],
  ['التحقق من الهوية','حالة التحقق والوثائق',ShieldCheck,'/account/verification'],
  ['الدعم الفني واتصل بنا','فتح تذكرة ومتابعة الردود',Headphones,'/support'],
 ];
 return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-3xl p-4 md:p-7">
  <a href="/" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>الرئيسية</a>
  <section className="rounded-3xl bg-white p-6 shadow-sm border"><div className="flex items-center gap-4"><div className="grid h-16 w-16 place-items-center rounded-full bg-emerald-50 text-primary-900 text-2xl font-black">{u.fullName?.slice(0,1)}</div><div><h1 className="text-2xl font-black">{u.fullName}</h1><p className="text-sm text-slate-500">{u.phone} {u.email&&`· ${u.email}`}</p></div></div>
   <div className="mt-5 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-slate-50 p-3">الهاتف: <b>{u.phoneStatus==='VERIFIED'?'موثق':'غير موثق'}</b></div><div className="rounded-xl bg-slate-50 p-3">الهوية: <b>{u.identityStatus}</b></div></div>
  </section>
  <section className="mt-5 space-y-2">{items.map(([title,desc,Icon,href]:any)=><a key={title} href={href} className="flex items-center gap-4 rounded-2xl border bg-white p-4 hover:shadow-sm"><span className="rounded-xl bg-slate-50 p-3 text-primary-900"><Icon size={21}/></span><span className="flex-1"><b className="block">{title}</b><small className="text-slate-500">{desc}</small></span><span>‹</span></a>)}</section>
 </div></main>
}
