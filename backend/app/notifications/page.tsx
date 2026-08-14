'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Bell, CheckCheck, ChevronLeft } from 'lucide-react';

type Notification = {
  id: string;
  type: string;
  title: string;
  message: string;
  priority: string;
  operationId?: string | null;
  data?: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
};

function notificationLink(notification: Notification) {
  const data = notification.data || {};
  const auctionId = typeof data.auctionId === 'string' ? data.auctionId : null;
  const ticketId = typeof data.ticketId === 'string' ? data.ticketId : null;
  const authorizationId = typeof data.authorizationId === 'string' ? data.authorizationId : null;
  if (notification.type.startsWith('AUCTION_') && auctionId) return `/auctions/${auctionId}`;
  if (notification.type === 'SUPPORT_TICKET' && (ticketId || notification.operationId)) return `/support/${ticketId || notification.operationId}`;
  if (notification.type === 'AUTHORIZATION' && authorizationId) return `/authorizations/${authorizationId}`;
  if (['TRANSFER_REQUEST', 'BUYER_APPROVAL', 'PAYMENT_CONFIRMED', 'ESCROW_HELD', 'SELLER_OTP', 'OWNERSHIP_TRANSFERRED', 'PAYOUT_PROTECTION', 'PAYOUT_CONFIRMED', 'REFUND', 'DISPUTE'].includes(notification.type) && notification.operationId) return `/transfers/${notification.operationId}`;
  if (['SECURITY_ALERT', 'NEW_LOGIN'].includes(notification.type)) return '/account/security';
  if (notification.type === 'ADVERTISEMENT') return '/market';
  return null;
}

export default function NotificationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++loadSequence.current;
    try {
      const response = await fetch('/api/notifications', { signal });
      const result = await response.json();
      if (response.status === 401) {
        router.replace('/auth/login?next=/notifications');
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'NOTIFICATIONS_FAILED');
      if (sequence !== loadSequence.current || signal?.aborted) return;
      setItems(result.notifications || []);
      setError('');
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      if (sequence !== loadSequence.current) return;
      setError('تعذر تحميل الإشعارات.');
    } finally {
      if (sequence === loadSequence.current && !signal?.aborted) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();
    const first = window.setTimeout(() => void load(controller.signal), 0);
    const poll = window.setInterval(() => void load(controller.signal), 15_000);
    return () => { window.clearTimeout(first); window.clearInterval(poll); controller.abort(); };
  }, [load]);

  function markRead(notification: Notification) {
    const link = notificationLink(notification);
    if (!notification.isRead) {
      setItems(current => current.map(item => item.id === notification.id ? { ...item, isRead: true } : item));
      void fetch('/api/notifications', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: notification.id }) })
        .then(response => { if (!response.ok) throw new Error('NOTIFICATION_UPDATE_FAILED'); })
        .catch(() => {
          setItems(current => current.map(item => item.id === notification.id ? { ...item, isRead: false } : item));
          setError('تم فتح الوجهة، لكن تعذر تحديث حالة قراءة الإشعار.');
        });
    }
    if (link) router.push(link);
  }

  async function markAllRead() {
    setPending(true);
    try {
      const response = await fetch('/api/notifications', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
      if (!response.ok) throw new Error('FAILED');
      setItems(current => current.map(item => ({ ...item, isRead: true })));
    } catch {
      setError('تعذر تحديث الإشعارات.');
    } finally {
      setPending(false);
    }
  }

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-3xl p-4 md:p-7">
    <div className="mb-5 flex items-center justify-between gap-3"><Link href="/account" className="flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight/>الحساب</Link><button disabled={pending || items.every(item => item.isRead)} onClick={markAllRead} className="flex items-center gap-2 text-sm font-bold disabled:opacity-40"><CheckCheck size={18}/>تحديد الكل كمقروء</button></div>
    <h1 className="text-2xl font-black">الإشعارات</h1><p className="mb-5 text-sm text-slate-500">اختر الإشعار للانتقال مباشرة إلى العملية المرتبطة به.</p>
    {error && <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-red-800">{error}</div>}
    {loading ? <div role="status" className="rounded-2xl bg-white p-8 text-center">جارٍ التحميل…</div> : items.length === 0 ? <div className="rounded-2xl bg-white p-8 text-center text-slate-500"><Bell className="mx-auto mb-2"/>لا توجد إشعارات.</div> :
      <div className="space-y-3">{items.map(notification => {
        const link = notificationLink(notification);
        return <button key={notification.id} onClick={() => markRead(notification)} className={`w-full rounded-2xl border bg-white p-4 text-right shadow-sm ${!notification.isRead ? 'border-emerald-200 bg-emerald-50/40' : ''}`}><div className="flex gap-3"><Bell aria-hidden="true" className="mt-1 text-primary-900"/><span className="min-w-0 flex-1"><b className="block">{notification.title}</b><span className="mt-1 block text-sm text-slate-600">{notification.message}</span><small className="mt-2 block text-slate-400">{new Date(notification.createdAt).toLocaleString('ar-YE')}</small></span>{!notification.isRead && <span className="self-start"><span className="sr-only">غير مقروء. </span><span aria-hidden="true" className="block h-2 w-2 rounded-full bg-red-600"/></span>}{link && <ChevronLeft aria-hidden="true" className="self-center text-slate-400" size={18}/>}</div></button>;
      })}</div>}
  </div></main>;
}
