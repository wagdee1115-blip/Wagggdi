'use client';

import Link from 'next/link';
import { Heart, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type ViewState = 'checking' | 'ready' | 'signed-out' | 'failed';
type MessageKind = 'success' | 'error' | null;

export default function FavoriteButton({ listingId }: { listingId: string }) {
  const [viewState, setViewState] = useState<ViewState>('checking');
  const [favorited, setFavorited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState<MessageKind>(null);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    setMessage('');
    setMessageKind(null);
    try {
      const response = await fetch(`/api/favorites/${encodeURIComponent(listingId)}`, {
        cache: 'no-store',
        signal,
      });
      const result = await response.json().catch(() => ({ ok: false }));
      if (response.status === 401) {
        setViewState('signed-out');
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'FAVORITE_STATUS_UNAVAILABLE');
      setFavorited(Boolean(result.favorited));
      setViewState('ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setViewState('failed');
      setMessage('تعذر التحقق من حالة المفضلة.');
      setMessageKind('error');
    }
  }, [listingId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadStatus(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadStatus]);

  async function toggleFavorite() {
    if (saving || viewState !== 'ready') return;
    setSaving(true);
    setMessage('');
    setMessageKind(null);
    const nextFavorited = !favorited;
    try {
      const response = await fetch(
        nextFavorited ? '/api/favorites' : `/api/favorites/${encodeURIComponent(listingId)}`,
        nextFavorited ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ listingId }),
        } : { method: 'DELETE' },
      );
      const result = await response.json().catch(() => ({ ok: false }));
      if (response.status === 401) {
        setViewState('signed-out');
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'FAVORITE_UPDATE_FAILED');
      setFavorited(nextFavorited);
      setMessage(nextFavorited ? 'أضيف الإعلان إلى المفضلة.' : 'أزيل الإعلان من المفضلة.');
      setMessageKind('success');
    } catch {
      setMessage('تعذر تحديث المفضلة الآن. أعد المحاولة.');
      setMessageKind('error');
    } finally {
      setSaving(false);
    }
  }

  if (viewState === 'checking') {
    return <div role="status" className="mt-4 inline-flex min-h-11 items-center rounded-xl border border-white/30 px-4 text-sm text-slate-100">جارٍ التحقق من المفضلة…</div>;
  }

  if (viewState === 'signed-out') {
    return <Link href={`/auth/login?next=${encodeURIComponent(`/market/${listingId}`)}`} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/40 bg-white/10 px-4 py-2 text-sm font-bold text-white hover:bg-white/20"><Heart aria-hidden="true" size={19} />سجّل الدخول لحفظ الإعلان</Link>;
  }

  if (viewState === 'failed') {
    return <div className="mt-4"><button type="button" onClick={() => { setViewState('checking'); void loadStatus(); }} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/40 bg-white/10 px-4 py-2 text-sm font-bold text-white"><RefreshCw aria-hidden="true" size={18} />إعادة التحقق</button><p role="alert" className="mt-2 text-sm text-amber-100">{message}</p></div>;
  }

  return <div className="mt-4">
    <button
      type="button"
      aria-pressed={favorited}
      disabled={saving}
      onClick={toggleFavorite}
      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/40 bg-white/10 px-4 py-2 text-sm font-bold text-white hover:bg-white/20 disabled:cursor-wait disabled:opacity-60"
    >
      <Heart aria-hidden="true" size={19} fill={favorited ? 'currentColor' : 'none'} />
      {saving ? 'جارٍ الحفظ…' : favorited ? 'محفوظ في المفضلة' : 'حفظ في المفضلة'}
    </button>
    <p role={messageKind === 'error' ? 'alert' : undefined} aria-live={messageKind === 'success' ? 'polite' : undefined} className={`mt-2 min-h-5 text-sm ${messageKind === 'error' ? 'text-amber-100' : 'text-emerald-100'}`}>{message}</p>
  </div>;
}
