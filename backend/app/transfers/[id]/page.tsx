'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, Clock3, CreditCard, FileText, RefreshCw, ShieldCheck, Truck } from 'lucide-react';

type Sale = {
  id: string; status: string; sellerName: string; buyerName: string | null; auctionId?: string | null;
  vehicleAmountYER: string; transferFeeUSD: number; platformFeeUSD: number; totalPaidYER: string;
  buyerOtpVerified: boolean; sellerOtpVerified: boolean;
  payoutProtectionUntil?: string | null; expiresAt: string; createdAt: string;
  refundReason?: string | null; refundFailureReason?: string | null;
  vehicle: { plateNumber: string; make: string; model: string; year: number; city: string };
  contract?: { id: string; contractNumber: string; status: string } | null;
  auditLogs: Array<{ id: string; action: string; oldStatus?: string | null; newStatus: string; createdAt: string }>;
};
type Detail = {
  sale: Sale;
  viewer: { party: 'BUYER' | 'SELLER' | 'PAYOUT_OWNER' | 'STAFF' };
  handover: { qrValue?: string | null; buyerConsent: boolean; sellerConsent: boolean };
  paymentRequest?: { status: string; checkoutUrl?: string | null } | null;
  disputes: Array<{ id: string; status: string; reason: string; createdAt: string }>;
};

const statusText: Record<string, string> = {
  SALE_CREATED: 'بانتظار موافقة البائع برمز OTP', BUYER_PENDING: 'بانتظار موافقة المشتري', BUYER_ACCEPTED: 'وافق المشتري', WAITING_PAYMENT: 'نتيجة المزاد بانتظار تأكيد البائع والدفع', PAYMENT_PROCESSING: 'طلب الدفع منشأ',
  PAYMENT_CONFIRMED: 'وصل الدفع ويجري تأمينه', ESCROW_HELD: 'الأموال مؤمنة في الضمان', TRANSFER_PENDING: 'طلب نقل الملكية لدى المرور',
  TRANSFER_IN_PROGRESS: 'نقل الملكية جارٍ', TRANSFER_BLOCKED: 'نقل الملكية متوقف', HANDOVER_PENDING: 'بانتظار إقرار التسليم', PAYOUT_PROTECTION: 'فترة حماية الصرف',
  PAYOUT_PENDING: 'بانتظار الصرف', PAYOUT_PROCESSING: 'الصرف جارٍ', PAYOUT_CONFIRMED: 'تم الصرف', COMPLETED: 'مكتملة', DISPUTED: 'نزاع مفتوح والصرف مجمّد',
  REFUND_PENDING: 'تم تسجيل التزام الاسترداد', REFUND_PROCESSING: 'الاسترداد جارٍ', REFUND_FAILED: 'تعذر الاسترداد وسيعاد', REFUNDED: 'تم رد المبلغ',
  CANCELLED: 'ملغاة', EXPIRED: 'انتهت المهلة', MANUAL_REVIEW: 'مراجعة يدوية', PAYOUT_REVIEW_REQUIRED: 'حساب الاستلام يحتاج مراجعة', FAILED: 'فشلت العملية',
};

const errorText: Record<string, string> = {
  UNAUTHORIZED: 'سجّل الدخول أولاً.', FORBIDDEN: 'لا تملك صلاحية لهذه العملية.', SALE_EXPIRED: 'انتهت مهلة العملية.', SELLER_OTP_REQUIRED: 'يلزم OTP البائع أولاً.',
  BUYER_OTP_REQUIRED: 'يلزم OTP المشتري أولاً.', OTP_RESEND_TOO_SOON: 'انتظر قبل إعادة إرسال الرمز.', OTP_EXPIRED: 'انتهت صلاحية الرمز؛ اطلب رمزًا جديدًا.',
  OTP_INVALID: 'الرمز غير صحيح.', OTP_MAX_ATTEMPTS: 'تجاوزت محاولات الرمز؛ اطلب رمزًا جديدًا.', OTP_PARTY_MISMATCH: 'الرمز لا يخص هذا الطرف.',
  BUYER_APPROVAL_REQUIRED: 'الموافقة يجب أن تتم من حساب المشتري.', BUYER_PAYMENT_REQUIRED: 'بدء الدفع متاح للمشتري فقط.', FUNDS_NOT_SECURED: 'لم يؤكد مزود الضمان حجز الأموال بعد.',
  PAYMENT_INTEGRITY_FAILED: 'تعذر مطابقة سجل الدفع.', ESCROW_INTEGRITY_FAILED: 'تعذر مطابقة سجل الضمان.', PARTY_OTP_REQUIRED: 'يجب إكمال OTP للطرفين.',
  AUTHORIZATION_NO_LONGER_VALID: 'التفويض ألغي أو انتهت صلاحيته؛ أوقفت العملية للمراجعة.', BUYER_HANDOVER_CONSENT_REQUIRED: 'يلزم إقرار المشتري بالتسليم.',
  SELLER_HANDOVER_CONSENT_REQUIRED: 'يلزم إقرار البائع بالتسليم.', DISPUTE_ALREADY_OPEN: 'يوجد نزاع مفتوح بالفعل.', DISPUTE_WINDOW_CLOSED: 'انتهت نافذة النزاع بعد الصرف.',
  'NOT_CONFIGURED:SMS_PROVIDER_REQUIRED': 'مزود الرسائل النصية غير مربوط بعد.', 'NOT_CONFIGURED:PAYMENT_PROVIDER_REQUIRED': 'بوابة الدفع غير مربوطة بعد.',
  'NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED': 'تكامل المرور الرسمي غير مربوط بعد.', 'NOT_CONFIGURED:ESCROW_PROVIDER_REQUIRED': 'مزود الضمان غير مربوط بعد.',
};

const steps = ['OTP البائع', 'موافقة المشتري', 'OTP المشتري', 'الدفع والضمان', 'المرور', 'التسليم', 'حماية الصرف', 'الإتمام'];

function progress(status: string) {
  if (['SALE_CREATED'].includes(status)) return 0;
  if (['BUYER_PENDING'].includes(status)) return 1;
  if (['BUYER_ACCEPTED'].includes(status)) return 2;
  if (['WAITING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_CONFIRMED'].includes(status)) return 3;
  if (['ESCROW_HELD', 'TRANSFER_PENDING', 'TRANSFER_IN_PROGRESS', 'TRANSFER_BLOCKED'].includes(status)) return 4;
  if (['HANDOVER_PENDING'].includes(status)) return 5;
  if (['PAYOUT_PROTECTION', 'PAYOUT_PENDING', 'PAYOUT_PROCESSING', 'PAYOUT_REVIEW_REQUIRED'].includes(status)) return 6;
  if (['PAYOUT_CONFIRMED', 'COMPLETED'].includes(status)) return 7;
  return -1;
}

function safeCheckoutUrl(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

export default function TransferDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [otpId, setOtpId] = useState('');
  const [otp, setOtp] = useState('');
  const [otpParty, setOtpParty] = useState<'BUYER' | 'SELLER' | ''>('');
  const [otpPurpose, setOtpPurpose] = useState<'SALE_CONSENT' | 'HANDOVER' | ''>('');
  const [checkoutUrl, setCheckoutUrl] = useState('');
  const [mileage, setMileage] = useState('');
  const [handoverNotes, setHandoverNotes] = useState('');
  const [showDispute, setShowDispute] = useState(false);
  const [dispute, setDispute] = useState({ reason: '', description: '' });
  const loadSequence = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++loadSequence.current;
    try {
      const response = await fetch(`/api/transfers/${id}`, { signal });
      const result = await response.json();
      if (response.status === 401) { router.replace(`/auth/login?next=/transfers/${id}`); return; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'TRANSFER_LOAD_FAILED');
      if (sequence !== loadSequence.current || signal?.aborted) return;
      setDetail(result);
      const storedCheckout = result.paymentRequest?.checkoutUrl;
      setCheckoutUrl(safeCheckoutUrl(storedCheckout));
      setError('');
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      if (sequence !== loadSequence.current) return;
      const code = loadError instanceof Error ? loadError.message : 'TRANSFER_LOAD_FAILED';
      setError(errorText[code] || 'تعذر تحميل العملية.');
    } finally {
      if (sequence === loadSequence.current && !signal?.aborted) setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    const controller = new AbortController();
    const first = window.setTimeout(() => void load(controller.signal), 0);
    const poll = window.setInterval(() => void load(controller.signal), 12_000);
    return () => { window.clearTimeout(first); window.clearInterval(poll); controller.abort(); };
  }, [load]);

  const sale = detail?.sale;
  const currentStep = sale ? progress(sale.status) : -1;
  const canDispute = useMemo(() => Boolean(sale && !['PAYOUT_CONFIRMED', 'COMPLETED', 'REFUNDED', 'REFUND_PROCESSING'].includes(sale.status)), [sale]);

  async function action(path: string, body?: unknown, method = 'POST') {
    setPending(true); setError(''); setNotice('');
    try {
      const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'ACTION_FAILED');
      await load();
      return result;
    } catch (actionError) {
      const code = actionError instanceof Error ? actionError.message : 'ACTION_FAILED';
      setError(errorText[code] || code);
      return null;
    } finally { setPending(false); }
  }

  async function requestOtp() {
    const result = await action(`/api/transfers/${id}/otp/request`);
    if (!result) return;
    setOtpId(result.otpId); setOtpParty(result.party); setOtpPurpose(result.purpose); setOtp('');
    setNotice(`أرسل رمز ${result.party === 'SELLER' ? 'البائع' : 'المشتري'} إلى الهاتف المسجل.`);
  }

  async function verifyOtp(event: FormEvent) {
    event.preventDefault();
    const path = otpPurpose === 'HANDOVER' ? `/api/transfers/${id}/handover/consent` : `/api/transfers/${id}/otp/${otpParty.toLowerCase()}`;
    const result = await action(path, { otpId, otp });
    if (!result) return;
    setOtpId(''); setOtp(''); setOtpParty(''); setOtpPurpose('');
    setNotice(otpPurpose === 'HANDOVER' ? 'سُجل إقرار التسليم لهذا الطرف.' : 'تم توثيق الموافقة بنجاح.');
  }

  async function startPayment() {
    const result = await action(`/api/transfers/${id}/payment/request`);
    if (!result) return;
    if (result.payment?.checkoutUrl) setCheckoutUrl(safeCheckoutUrl(result.payment.checkoutUrl));
    setNotice(result.payment?.inProgress ? 'طلب الدفع قيد الإنشاء؛ ستتحدث الصفحة تلقائيًا.' : 'تم إنشاء طلب الدفع لدى المزود.');
  }

  async function requestTrafficTransfer() {
    const result = await action(`/api/transfers/${id}/ownership-transfer/request`);
    if (result) setNotice('تم إرسال الطلب إلى مزود المرور. ستتحدث الحالة بعد callback الموقّع.');
  }

  async function confirmHandover(event: FormEvent) {
    event.preventDefault();
    if (!detail?.handover.qrValue) return;
    const result = await action(`/api/transfers/${id}/handover`, { qrValue: detail.handover.qrValue, mileage: Number(mileage), notes: handoverNotes.trim() || undefined });
    if (result) { setMileage(''); setHandoverNotes(''); setNotice('تم تأكيد التسليم وبدأت فترة حماية الصرف.'); }
  }

  async function openDispute(event: FormEvent) {
    event.preventDefault();
    const result = await action(`/api/transfers/${id}/dispute`, dispute);
    if (result) { setDispute({ reason: '', description: '' }); setShowDispute(false); setNotice('تم فتح النزاع وتجميد الصرف للمراجعة.'); }
  }

  if (loading) return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div role="status" className="mx-auto max-w-4xl rounded-2xl border bg-white p-8 text-center">جارٍ تحميل العملية…</div></main>;
  if (!detail || !sale) return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div role="alert" className="mx-auto max-w-3xl rounded-2xl border border-red-200 bg-red-50 p-8 text-center">{error || 'العملية غير موجودة.'}<div><Link href="/traffic/ownership-transfer" className="mt-4 inline-block font-bold underline">العودة إلى العمليات</Link></div></div></main>;

  const isBuyer = detail.viewer.party === 'BUYER';
  const isSeller = detail.viewer.party === 'SELLER';
  const isPayoutOwner = detail.viewer.party === 'PAYOUT_OWNER';

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-5xl p-4 md:p-7">
    <div className="mb-5 flex items-center justify-between gap-3"><Link href="/traffic/ownership-transfer" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18}/>عمليات نقل الملكية</Link><button disabled={pending} onClick={() => void load()} aria-label="تحديث الحالة" className="rounded-xl border bg-white p-2 disabled:opacity-50"><RefreshCw size={18}/></button></div>
    <section className="rounded-3xl border bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs text-slate-500">رقم العملية {sale.id}</p><h1 className="mt-1 text-2xl font-black">{sale.vehicle.make} {sale.vehicle.model} — {sale.vehicle.plateNumber}</h1><p className="mt-2 text-sm text-slate-500">{sale.vehicle.year} · {sale.vehicle.city} · أنت {isBuyer ? 'المشتري' : isSeller ? 'البائع المفوّض' : isPayoutOwner ? 'مالك المركبة وصاحب الاستلام' : 'فريق التشغيل'}</p></div><span className="rounded-full bg-emerald-50 px-4 py-2 text-sm font-black text-emerald-900">{statusText[sale.status] || sale.status}</span></div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-3 text-sm">قيمة المركبة<br/><b>{Number(sale.vehicleAmountYER).toLocaleString('ar-YE')} ريال</b></div><div className="rounded-xl bg-slate-50 p-3 text-sm">رسوم النقل الشاملة<br/><b>{sale.transferFeeUSD + sale.platformFeeUSD} USD</b></div><div className="rounded-xl bg-slate-50 p-3 text-sm">إجمالي المشتري<br/><b>{Number(sale.totalPaidYER).toLocaleString('ar-YE')} ريال</b></div></div>
      <div className="mt-4 flex items-center gap-2 text-sm text-slate-600"><Clock3 size={17}/>المهلة المسجلة: {new Date(sale.expiresAt).toLocaleString('ar-YE')}</div>
    </section>

    <ol className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8" aria-label="تقدم العملية">{steps.map((step, index) => <li key={step} className={`rounded-xl border p-3 text-center text-xs font-bold ${currentStep >= index ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'bg-white text-slate-500'}`}>{currentStep > index ? <Check className="mx-auto mb-1" size={16}/> : <span className="mb-1 block">{index + 1}</span>}{step}</li>)}</ol>

    {(error || notice) && <div role={error ? 'alert' : 'status'} aria-live="polite" className={`mt-5 rounded-xl border p-4 ${error ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{error || notice}</div>}

    <section className="mt-5 rounded-2xl border bg-white p-5"><h2 className="text-xl font-black">الخطوة المطلوبة الآن</h2>
      {sale.status === 'SALE_CREATED' && isSeller && <div className="mt-4"><p className="text-sm leading-7">أكّد رقم هاتف البائع أولاً. لن يتلقى المشتري الطلب ولن تبدأ مهلة الساعتين قبل نجاح الرمز.</p><button disabled={pending} onClick={requestOtp} className="mt-3 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50">إرسال OTP البائع</button></div>}
      {sale.status === 'SALE_CREATED' && !isSeller && <p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm">لم يثبت البائع موافقته بعد.</p>}
      {sale.status === 'BUYER_PENDING' && isBuyer && <button disabled={pending} onClick={() => action(`/api/transfers/${id}`, { status: 'BUYER_ACCEPTED' }, 'PATCH')} className="mt-4 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50">الموافقة على شراء المركبة</button>}
      {sale.status === 'BUYER_PENDING' && !isBuyer && <p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm">بانتظار قرار المشتري من حسابه.</p>}
      {sale.status === 'BUYER_ACCEPTED' && isBuyer && !sale.buyerOtpVerified && <div className="mt-4"><p className="text-sm">ثبّت موافقتك برمز الهاتف قبل إنشاء الدفع.</p><button disabled={pending} onClick={requestOtp} className="mt-3 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">إرسال OTP المشتري</button></div>}
      {sale.status === 'WAITING_PAYMENT' && sale.auctionId && isSeller && !sale.sellerOtpVerified && <div className="mt-4"><p className="text-sm leading-7">أكّد نتيجة المزاد برمز هاتف البائع قبل تمكين الفائز من الدفع.</p><button disabled={pending} onClick={requestOtp} className="mt-3 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">إرسال OTP البائع لنتيجة المزاد</button></div>}
      {sale.status === 'WAITING_PAYMENT' && sale.auctionId && isBuyer && !sale.sellerOtpVerified && <p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm">بانتظار تأكيد البائع لنتيجة المزاد برمز الهاتف.</p>}
      {['BUYER_ACCEPTED', 'WAITING_PAYMENT', 'PAYMENT_PROCESSING'].includes(sale.status) && isBuyer && (sale.auctionId ? sale.sellerOtpVerified : sale.buyerOtpVerified) && <div className="mt-4"><p className="text-sm leading-7">المبلغ يُستمد من العملية على الخادم ولا يمكن للواجهة تغييره.</p><button disabled={pending} onClick={startPayment} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white"><CreditCard size={19}/>إنشاء/متابعة الدفع</button>{checkoutUrl && <a href={checkoutUrl} target="_blank" rel="noopener noreferrer" className="mr-3 mt-3 inline-block rounded-xl border px-5 py-3 font-bold">فتح بوابة الدفع الخارجية ({new URL(checkoutUrl).hostname})</a>}</div>}
      {sale.status === 'PAYMENT_CONFIRMED' && <p className="mt-4 rounded-xl bg-blue-50 p-4 text-sm text-blue-900">وصل إشعار الدفع، لكننا ننتظر تأكيد مزود الضمان. لا يمكن طلب المرور الآن.</p>}
      {sale.status === 'ESCROW_HELD' && <div className="mt-4"><p className="flex items-center gap-2 text-sm text-emerald-900"><ShieldCheck/>تطابقت سجلات الدفع والضمان. يمكن الآن إرسال طلب المرور.</p><button disabled={pending} onClick={requestTrafficTransfer} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white"><Truck size={19}/>إرسال طلب نقل الملكية</button></div>}
      {['TRANSFER_PENDING', 'TRANSFER_IN_PROGRESS'].includes(sale.status) && <p className="mt-4 rounded-xl bg-blue-50 p-4 text-sm">طلب المرور قيد المعالجة وبانتظار callback موقّع من المزود.</p>}
      {sale.status === 'HANDOVER_PENDING' && <div className="mt-4"><div className="grid gap-3 sm:grid-cols-2"><div className={`rounded-xl p-4 ${detail.handover.sellerConsent ? 'bg-emerald-50' : 'bg-amber-50'}`}>إقرار البائع: <b>{detail.handover.sellerConsent ? 'تم' : 'مطلوب'}</b></div><div className={`rounded-xl p-4 ${detail.handover.buyerConsent ? 'bg-emerald-50' : 'bg-amber-50'}`}>إقرار المشتري: <b>{detail.handover.buyerConsent ? 'تم' : 'مطلوب'}</b></div></div>{((isSeller && !detail.handover.sellerConsent) || (isBuyer && !detail.handover.buyerConsent)) && <button disabled={pending} onClick={requestOtp} className="mt-3 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">إرسال OTP إقرار التسليم لي</button>}{isBuyer && detail.handover.buyerConsent && detail.handover.sellerConsent && <form onSubmit={confirmHandover} className="mt-5 grid gap-3"><label className="text-sm font-bold">قراءة العداد عند التسليم<input required min={0} type="number" value={mileage} onChange={event => setMileage(event.target.value)} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label><label className="text-sm font-bold">ملاحظات المشتري (اختياري)<textarea value={handoverNotes} onChange={event => setHandoverNotes(event.target.value)} maxLength={2000} className="mt-2 min-h-24 w-full rounded-xl border p-3 font-normal"/></label><button disabled={pending} className="rounded-xl bg-primary-900 px-5 py-3 font-bold text-white">تأكيد استلام المركبة</button></form>}</div>}
      {sale.status === 'PAYOUT_PROTECTION' && <p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm leading-7">تم التسليم. الصرف محمي حتى {sale.payoutProtectionUntil ? new Date(sale.payoutProtectionUntil).toLocaleString('ar-YE') : 'اكتمال المدة'} ويمكن فتح نزاع قبل الصرف.</p>}
      {['PAYOUT_PENDING', 'PAYOUT_PROCESSING'].includes(sale.status) && <p className="mt-4 rounded-xl bg-blue-50 p-4 text-sm">يجري صرف قيمة المركبة إلى حساب الاستلام الموثق.</p>}
      {['PAYOUT_CONFIRMED', 'COMPLETED'].includes(sale.status) && <p className="mt-4 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900">اكتملت العملية وتم تأكيد الصرف.</p>}
      {['REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_FAILED', 'REFUNDED'].includes(sale.status) && <p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm">{statusText[sale.status]}{sale.refundReason ? ` — السبب: ${sale.refundReason}` : ''}{sale.refundFailureReason ? ` — آخر خطأ: ${sale.refundFailureReason}` : ''}</p>}
      {otpId && <form onSubmit={verifyOtp} className="mt-5 rounded-xl border bg-slate-50 p-4"><p className="mb-3 text-sm font-bold">رمز {otpParty === 'SELLER' ? 'البائع' : 'المشتري'} — {otpPurpose === 'HANDOVER' ? 'إقرار التسليم' : 'الموافقة على البيع'}</p><label className="block"><span className="sr-only">رمز OTP</span><input required value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, '').slice(0, 4))} pattern="[0-9]{4}" inputMode="numeric" maxLength={4} className="w-full rounded-xl border p-3 text-center text-2xl tracking-[0.4em]"/></label><button disabled={pending || otp.length !== 4} className="mt-3 w-full rounded-xl bg-primary-900 p-3 font-bold text-white disabled:opacity-50">تحقق وسجّل الموافقة</button></form>}
    </section>

    <section className="mt-5 grid gap-4 md:grid-cols-2"><div className="rounded-2xl border bg-white p-5"><h2 className="font-black">الأطراف</h2><dl className="mt-3 space-y-3 text-sm"><div><dt className="text-slate-500">البائع</dt><dd className="font-bold">{sale.sellerName}</dd></div><div><dt className="text-slate-500">المشتري</dt><dd className="font-bold">{sale.buyerName || '—'}</dd></div><div><dt className="text-slate-500">الهاتف والهوية</dt><dd className="font-bold">موثقان عند إنشاء العملية ويعاد فحصهما قبل المرور</dd></div></dl></div><div className="rounded-2xl border bg-white p-5"><h2 className="font-black">السجل الإلكتروني</h2><p className="mt-2 text-sm text-slate-500">{sale.auditLogs.length} حدثًا مسجلاً بترتيب زمني.</p>{sale.contract ? <Link href={`/api/transfers/${sale.id}/contract`} target="_blank" className="mt-4 inline-flex items-center gap-2 rounded-xl border px-4 py-2 font-bold"><FileText size={18}/>فتح العقد للطباعة</Link> : <p className="mt-4 text-sm text-slate-500">يُصدر سجل العقد بعد اكتمال نقل الملكية.</p>}</div></section>

    {detail.disputes.length > 0 && <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-black">النزاعات</h2>{detail.disputes.map(item => <p key={item.id} className="mt-2 text-sm">{item.reason} — {item.status} — {new Date(item.createdAt).toLocaleString('ar-YE')}</p>)}</section>}
    {canDispute && <section className="mt-5 rounded-2xl border bg-white p-5"><button onClick={() => setShowDispute(value => !value)} className="inline-flex items-center gap-2 font-bold text-red-700"><AlertTriangle size={19}/>{showDispute ? 'إغلاق نموذج النزاع' : 'فتح نزاع وتجميد الصرف'}</button>{showDispute && <form onSubmit={openDispute} className="mt-4 grid gap-3"><label className="text-sm font-bold">سبب مختصر<input required minLength={3} maxLength={120} value={dispute.reason} onChange={event => setDispute({ ...dispute, reason: event.target.value })} className="mt-2 w-full rounded-xl border p-3 font-normal"/></label><label className="text-sm font-bold">التفاصيل<textarea required minLength={10} maxLength={5000} value={dispute.description} onChange={event => setDispute({ ...dispute, description: event.target.value })} className="mt-2 min-h-28 w-full rounded-xl border p-3 font-normal"/></label><button disabled={pending} className="rounded-xl bg-red-700 px-5 py-3 font-bold text-white">فتح النزاع</button></form>}</section>}
  </div></main>;
}
