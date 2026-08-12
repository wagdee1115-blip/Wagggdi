'use client';
import { useEffect,useState } from 'react';
import { ArrowRight, Headphones, Plus, Send } from 'lucide-react';
export default function Support(){
 const [tickets,setTickets]=useState<any[]>([]); const [open,setOpen]=useState(false); const [form,setForm]=useState({category:'دعم فني',subject:'',description:'',priority:'NORMAL'});
 async function load(){const r=await fetch('/api/support');const x=await r.json();if(x.ok)setTickets(x.tickets||[])}
 useEffect(()=>{load()},[]);
 async function create(e:any){e.preventDefault();const r=await fetch('/api/support',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)});const x=await r.json();if(x.ok){setOpen(false);setForm({category:'دعم فني',subject:'',description:'',priority:'NORMAL'});load()}else alert(x.error||'تعذر إنشاء التذكرة')}
 return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-3xl p-4 md:p-7">
  <div className="mb-6 flex items-center justify-between"><a href="/account" className="flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight/>الحساب</a><button onClick={()=>setOpen(!open)} className="flex items-center gap-2 rounded-xl bg-primary-900 px-4 py-2 text-white"><Plus size={18}/>رفع تذكرة</button></div>
  <section className="rounded-3xl bg-primary-900 p-6 text-white"><Headphones size={28}/><h1 className="mt-3 text-2xl font-black">الدعم الفني واتصل بنا</h1><p className="mt-2 text-sm text-slate-200">ارفع تذكرة، اشرح المشكلة، وتابع الردود من داخل حسابك.</p></section>
  {open&&<form onSubmit={create} className="mt-4 space-y-3 rounded-2xl border bg-white p-5"><select value={form.category} onChange={e=>setForm({...form,category:e.target.value})} className="w-full rounded-xl border p-3"><option>دعم فني</option><option>مزاد</option><option>نقل ملكية</option><option>دفع ووسيط</option><option>الحساب والأمان</option><option>شكوى</option></select><input required value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})} placeholder="عنوان المشكلة" className="w-full rounded-xl border p-3"/><textarea required minLength={10} value={form.description} onChange={e=>setForm({...form,description:e.target.value})} placeholder="اشرح المشكلة بالتفصيل..." rows={6} className="w-full rounded-xl border p-3"/><button className="rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">إرسال التذكرة</button></form>}
  <h2 className="mb-3 mt-7 text-xl font-black">تذاكري</h2>
  {tickets.length===0?<div className="rounded-2xl border bg-white p-7 text-center text-slate-500">لا توجد تذاكر حتى الآن.</div>:<div className="space-y-3">{tickets.map(t=><a href={`/support/${t.id}`} key={t.id} className="block rounded-2xl border bg-white p-4"><div className="flex justify-between gap-3"><b>{t.subject}</b><span className="text-xs text-primary-900">{t.ticketNumber}</span></div><div className="mt-2 text-sm text-slate-500">{t.category} · {t.status}</div><p className="mt-2 text-sm">{t.description}</p></a>)}</div>}
 </div></main>
}
