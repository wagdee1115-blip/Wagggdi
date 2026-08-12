'use client';
import { useEffect,useState } from 'react';
import { ArrowRight, Bell, CheckCheck } from 'lucide-react';
export default function Notifications(){
 const [items,setItems]=useState<any[]>([]); const [loading,setLoading]=useState(true);
 async function load(){const r=await fetch('/api/notifications');const x=await r.json();if(x.ok)setItems(x.notifications||[]);setLoading(false)}
 useEffect(()=>{load();const t=setInterval(load,15000);return()=>clearInterval(t)},[]);
 async function read(id:string){await fetch('/api/notifications',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});load()}
 async function all(){await fetch('/api/notifications',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({all:true})});load()}
 return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-3xl p-4 md:p-7">
  <div className="mb-5 flex items-center justify-between"><a href="/account" className="flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight/>الحساب</a><button onClick={all} className="flex items-center gap-2 text-sm font-bold"><CheckCheck size={18}/>تحديد الكل كمقروء</button></div>
  <h1 className="text-2xl font-black">الإشعارات</h1><p className="mb-5 text-sm text-slate-500">تتحدث تلقائياً دون الحاجة لإعادة تحميل الصفحة.</p>
  {loading?<div className="rounded-2xl bg-white p-8 text-center">جاري التحميل...</div>:items.length===0?<div className="rounded-2xl bg-white p-8 text-center text-slate-500"><Bell className="mx-auto mb-2"/>لا توجد إشعارات.</div>:
   <div className="space-y-3">{items.map(n=><button key={n.id} onClick={()=>!n.isRead&&read(n.id)} className={`w-full rounded-2xl border bg-white p-4 text-right shadow-sm ${!n.isRead?'border-emerald-200 bg-emerald-50/40':''}`}><div className="flex gap-3"><Bell className="mt-1 text-primary-900"/><span className="flex-1"><b className="block">{n.title}</b><span className="mt-1 block text-sm text-slate-600">{n.message}</span><small className="mt-2 block text-slate-400">{new Date(n.createdAt).toLocaleString('ar-YE')}</small></span>{!n.isRead&&<span className="h-2 w-2 rounded-full bg-red-600"/>}</div></button>)}</div>}
 </div></main>
}
