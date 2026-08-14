'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ArrowRight, Bell, CarFront, FileSignature, FileText, Headphones, Heart, Landmark, LockKeyhole, MessagesSquare, ShieldCheck, UserCog } from 'lucide-react';

type AccountUser = {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: string;
  status: string;
  identityStatus: string;
  phoneStatus: string;
};

type MenuItem = { title: string; description: string; icon: LucideIcon; href: string };

const identityLabels: Record<string, string> = {
  UNVERIFIED: 'غير موثقة', MOBILE_VERIFIED: 'الهاتف فقط', IDENTITY_VERIFIED: 'موثقة',
  IDENTITY_FACE_VERIFIED: 'موثقة مع تحقق إضافي', ADVANCED_VERIFIED: 'توثيق متقدم',
  PENDING: 'قيد المراجعة', VERIFIED: 'موثقة', REJECTED: 'مرفوضة',
};
const phoneLabels: Record<string, string> = { PENDING: 'قيد التحقق', VERIFIED: 'موثق', FAILED: 'فشل التحقق', EXPIRED: 'انتهت صلاحية التحقق' };
const accountLabels: Record<string, string> = { ACTIVE: 'نشط', PENDING: 'بانتظار التفعيل', SUSPENDED: 'موقوف' };
const roleLabels: Record<string, string> = {
  USER: 'مستخدم', SELLER: 'بائع', BUYER: 'مشتري', DEALER: 'معرض', SUPPORT: 'دعم', FINANCE: 'مالية',
  VERIFIER: 'مدقق', AUDITOR: 'مراجع', ADMIN: 'مدير', SUPER_ADMIN: 'مدير أعلى', OWNER: 'مالك المنصة', MODERATOR: 'مشرف',
};

const items: MenuItem[] = [
  { title: 'مركباتي', description: 'إدارة المركبات المملوكة لك', icon: CarFront, href: '/vehicles' },
  { title: 'المزادات والمزايدات', description: 'المزادات التي شاركت بها ونتائجها', icon: FileText, href: '/auctions' },
  { title: 'المحادثات', description: 'مراسلة البائعين ومتابعة محادثات الإعلانات', icon: MessagesSquare, href: '/conversations' },
  { title: 'المفضلة', description: 'الإعلانات التي حفظتها للرجوع إليها لاحقًا', icon: Heart, href: '/favorites' },
  { title: 'التفويضات', description: 'إنشاء ومتابعة تفويضات المركبات الآمنة', icon: FileSignature, href: '/authorizations' },
  { title: 'حسابات الاستلام', description: 'إضافة حساب بنكي أو محفظة موثقة للصرف', icon: Landmark, href: '/account/payout' },
  { title: 'الإشعارات', description: 'طلبات النقل والدفع والمزادات والتنبيهات', icon: Bell, href: '/notifications' },
  { title: 'الأمان وتسجيل الدخول', description: 'حالة الهاتف وتغيير كلمة المرور والجلسات', icon: LockKeyhole, href: '/account/security' },
  { title: 'التحقق من الهوية', description: 'رقم الهوية وتاريخ الميلاد وحالة المزود', icon: ShieldCheck, href: '/account/verification' },
  { title: 'الدعم الفني واتصل بنا', description: 'فتح تذكرة ومتابعة الردود', icon: Headphones, href: '/support' },
];
const staffItem: MenuItem = { title: 'إدارة الدعم', description: 'الرد على التذاكر وإدارة حالتها وأولويتها', icon: UserCog, href: '/admin/support' };
const supportStaffRoles = new Set(['OWNER', 'SUPER_ADMIN', 'ADMIN', 'SUPPORT']);

export default function AccountPage() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/me', { signal, cache: 'no-store' });
      const result = await response.json();
      if (response.status === 401) {
        setAuthRequired(true);
        setUser(null);
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'ACCOUNT_LOAD_FAILED');
      setUser(result.user);
      setAuthRequired(false);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setError('تعذر تحميل بيانات الحساب. تحقق من الاتصال وحاول مجددًا.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-3xl p-4 md:p-7">
    <Link href="/" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>الرئيسية</Link>
    {loading && <div role="status" className="rounded-2xl border bg-white p-8 text-center">جارٍ تحميل الحساب…</div>}
    {!loading && authRequired && <section className="rounded-2xl border bg-white p-8 text-center"><h1 className="text-xl font-black">سجّل الدخول لعرض حسابك</h1><Link href="/auth/login?next=/account" className="mt-5 inline-block rounded-xl bg-primary-900 px-6 py-3 font-bold text-white">تسجيل الدخول</Link></section>}
    {!loading && error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-red-800">{error}<button onClick={() => void load()} className="mt-4 block w-full rounded-xl border border-red-300 bg-white p-3 font-bold">إعادة المحاولة</button></div>}
    {!loading && user && <>
      <section className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-4"><div className="grid h-16 w-16 place-items-center rounded-full bg-emerald-50 text-2xl font-black text-primary-900">{user.fullName.slice(0, 1)}</div><div className="min-w-0"><h1 className="truncate text-2xl font-black">{user.fullName}</h1><p className="mt-1 break-all text-sm text-slate-500" dir="ltr">{user.phone}{user.email ? ` · ${user.email}` : ''}</p></div></div>
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">حالة الحساب</dt><dd className="mt-1 font-bold">{accountLabels[user.status] || user.status}</dd></div>
          <div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">نوع الحساب</dt><dd className="mt-1 font-bold">{roleLabels[user.role] || user.role}</dd></div>
          <div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">الهاتف</dt><dd className="mt-1 font-bold">{phoneLabels[user.phoneStatus] || user.phoneStatus}</dd></div>
          <div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">الهوية</dt><dd className="mt-1 font-bold">{identityLabels[user.identityStatus] || user.identityStatus}</dd></div>
        </dl>
      </section>
      <section className="mt-5 space-y-2">{(supportStaffRoles.has(user.role) ? [...items, staffItem] : items).map(item => { const Icon = item.icon; return <Link key={item.href} href={item.href} className="flex items-center gap-4 rounded-2xl border bg-white p-4 transition-shadow hover:shadow-sm"><span className="rounded-xl bg-slate-50 p-3 text-primary-900"><Icon size={21}/></span><span className="flex-1"><b className="block">{item.title}</b><small className="text-slate-500">{item.description}</small></span><span aria-hidden>‹</span></Link>; })}</section>
    </>}
  </div></main>;
}
