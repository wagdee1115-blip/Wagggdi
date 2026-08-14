'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, BadgeCheck, CircleAlert, FileClock, RefreshCw, ShieldCheck } from 'lucide-react';

type Vehicle = { id: string; make: string; model: string; year: number };
type Violation = {
  id: string;
  type: string;
  summary: string;
  amountYER: number;
  status: string;
  issuedAt: string;
  dueAt: string | null;
};
type RenewalRequest = {
  status: string;
  feesYER: number | null;
  newExpiryDate: string | null;
  submittedAt: string;
  updatedAt: string;
  replayed?: boolean;
  checkoutUrl?: string;
};
type RenewalOverview = {
  eligibility: { eligible: boolean; reasonCode?: string; feesYER: number; currentExpiryDate: string | null };
  request: RenewalRequest | null;
};

const violationTypes: Record<string, string> = {
  SPEEDING: 'تجاوز السرعة', PARKING: 'وقوف', SIGNAL: 'إشارة مرورية', LICENSE: 'ترخيص', OTHER: 'أخرى',
};
const violationStatuses: Record<string, string> = {
  PENDING: 'غير مسددة', PAID: 'أكد المزود سدادها', DISPUTED: 'قيد الاعتراض', CANCELLED: 'ملغاة لدى المزود',
};
const renewalStatuses: Record<string, string> = {
  PAYMENT_REQUIRED: 'بانتظار إكمال الدفع لدى المزود',
  PENDING_GOVERNMENT: 'قيد المعالجة لدى المزود', COMPLETED: 'أكد المزود اكتمال التجديد',
  REJECTED: 'رفض المزود الطلب', FAILED: 'تعذر إكمال الطلب',
};
const renewalReasons: Record<string, string> = {
  PENDING_VIOLATIONS: 'توجد مخالفات غير مسددة.', LEGAL_RESTRICTION: 'يوجد قيد يمنع التجديد.',
  INSPECTION_REQUIRED: 'يلزم فحص المركبة أولًا.', TOO_EARLY: 'لم تبدأ فترة التجديد بعد.',
  ALREADY_RENEWED: 'التسجيل مجدد لهذه الدورة.',
};

class ApiFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

function apiMessage(code: string) {
  if (code.startsWith('NOT_CONFIGURED:')) return 'خدمة المرور الحقيقية غير مربوطة حاليًا؛ لم نعرض بيانات تجريبية ولم نرسل طلبًا.';
  const messages: Record<string, string> = {
    UNAUTHORIZED: 'انتهت الجلسة. سجّل الدخول مجددًا.', RATE_LIMITED: 'تجاوزت عدد المحاولات المسموح؛ حاول لاحقًا.',
    VEHICLE_NOT_FOUND: 'المركبة غير موجودة أو لا تملك صلاحية الوصول إليها.', VIOLATION_NOT_FOUND: 'المخالفة غير موجودة لهذه المركبة.',
    VEHICLE_OWNERSHIP_NOT_VERIFIED: 'يجب التحقق من سجل المركبة لدى المزود قبل الاستعلام أو تنفيذ خدمة.',
    VEHICLE_IDENTITY_CHANGED_DURING_REQUEST: 'تغيرت هوية المركبة أثناء الاستعلام؛ لم نعتمد النتيجة.',
    VEHICLE_OPERATION_IN_PROGRESS: 'المركبة محجوزة ضمن عملية أخرى؛ أكملها أو ألغها أولًا.',
    VEHICLE_NOT_ACTIVE: 'المركبة ليست نشطة ولا يمكن تنفيذ هذه الخدمة الآن.', VEHICLE_RESTRICTED: 'يوجد قيد يمنع تجديد التسجيل.',
    VEHICLE_OWNERSHIP_CHANGED_DURING_REQUEST: 'تغير مالك المركبة أثناء الطلب؛ أوقفنا المتابعة وحولناها للمراجعة.',
    VEHICLE_OPERATION_CHANGED_DURING_REQUEST: 'بدأت عملية أخرى على المركبة أثناء الطلب؛ أوقفنا المتابعة وحولناها للمراجعة.',
    VIOLATION_NOT_PAYABLE: 'هذه المخالفة ليست في حالة تسمح بالسداد.', REGISTRATION_RENEWAL_NOT_ELIGIBLE: 'أكد المزود أن المركبة غير مؤهلة للتجديد الآن.',
    VIOLATION_PAYMENT_REVIEW_REQUIRED: 'عملية سداد سابقة تحتاج مراجعة؛ لن نعيد فتحها تلقائيًا.',
    VIOLATION_PAYMENT_RECONCILIATION_REQUIRED: 'تغيرت بيانات المخالفة أثناء السداد؛ أوقفنا التأكيد للمراجعة.',
    REGISTRATION_RENEWAL_REVIEW_REQUIRED: 'طلب التجديد يحتاج مراجعة؛ لن نعيد فتحه تلقائيًا.',
    REGISTRATION_RENEWAL_ALREADY_REQUESTED: 'يوجد طلب تجديد سابق لهذه الدورة؛ تواصل مع الدعم إذا انتقلت الملكية.',
    TRAFFIC_PROVIDER_UNAVAILABLE: 'مزود المرور غير متاح الآن، ولم نعتمد أي نتيجة.',
    TRAFFIC_PROVIDER_RESPONSE_INVALID: 'رفضنا ردًا غير صالح من المزود، ولم نعتمد أي نتيجة.',
    TRAFFIC_PROVIDER_SUBJECT_MISMATCH: 'رفضنا الرد لأنه لا يطابق هذه المركبة.',
    TRAFFIC_PROVIDER_AMOUNT_MISMATCH: 'رفضنا تأكيد السداد لاختلاف المبلغ.',
    TRAFFIC_PROVIDER_REFERENCE_REPLAY: 'أوقفنا العملية بسبب تعارض في مرجع المزود.',
  };
  return messages[code] || 'تعذر إكمال الطلب بأمان الآن.';
}

async function responseJson(response: Response) {
  const result = await response.json().catch(() => ({ ok: false, error: 'INVALID_RESPONSE' }));
  if (!response.ok || !result.ok) throw new ApiFailure(String(result.error || 'REQUEST_FAILED'));
  return result;
}

function displayDate(value: string | null) {
  return value ? new Intl.DateTimeFormat('ar-YE', { dateStyle: 'medium' }).format(new Date(value)) : 'غير متاح';
}

function safeCheckoutUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function RenewalStatusCard({ request }: { request: RenewalRequest }) {
  const completed = request.status === 'COMPLETED';
  const checkoutUrl = safeCheckoutUrl(request.checkoutUrl);
  return <div className={`mt-4 rounded-2xl border p-4 ${completed ? 'border-emerald-200 bg-emerald-50' : 'border-blue-200 bg-blue-50'}`}>
    <p className="font-black">{renewalStatuses[request.status] || 'حالة غير معروفة'}</p>
    <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
      <div><dt className="text-slate-500">أُرسل في</dt><dd className="font-bold">{displayDate(request.submittedAt)}</dd></div>
      {request.newExpiryDate ? <div><dt className="text-slate-500">الانتهاء الجديد</dt><dd className="font-bold">{displayDate(request.newExpiryDate)}</dd></div> : null}
    </dl>
    {request.status === 'PAYMENT_REQUIRED' ? checkoutUrl ? <a href={checkoutUrl} target="_blank" rel="noreferrer" className="mt-4 inline-block rounded-xl bg-primary-900 px-4 py-2 font-bold text-white">فتح صفحة دفع التجديد لدى المزود</a> : <p role="alert" className="mt-3 text-sm text-red-700">طلب المزود الدفع، لكن الرابط لم يجتز فحص الأمان.</p> : null}
  </div>;
}

export default function VehicleCompliancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const violationSequence = useRef(0);
  const renewalSequence = useRef(0);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [vehicleError, setVehicleError] = useState('');
  const [violations, setViolations] = useState<Violation[]>([]);
  const [violationsLoading, setViolationsLoading] = useState(true);
  const [violationsError, setViolationsError] = useState('');
  const [renewal, setRenewal] = useState<RenewalOverview | null>(null);
  const [renewalLoading, setRenewalLoading] = useState(true);
  const [renewalError, setRenewalError] = useState('');
  const [payingId, setPayingId] = useState<string | null>(null);
  const [paymentNotice, setPaymentNotice] = useState<Record<string, string>>({});
  const [checkoutLinks, setCheckoutLinks] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  const [submittingRenewal, setSubmittingRenewal] = useState(false);

  const loadViolations = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++violationSequence.current;
    setViolationsLoading(true); setViolationsError(''); setViolations([]); setCheckoutLinks({}); setPaymentNotice({});
    try {
      const result = await responseJson(await fetch(`/api/vehicles/${id}/violations`, { cache: 'no-store', signal }));
      if (sequence === violationSequence.current) setViolations(result.violations);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (sequence === violationSequence.current) setViolationsError(apiMessage(error instanceof ApiFailure ? error.code : 'REQUEST_FAILED'));
    } finally {
      if (sequence === violationSequence.current) setViolationsLoading(false);
    }
  }, [id]);

  const loadRenewal = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++renewalSequence.current;
    setRenewalLoading(true); setRenewalError(''); setRenewal(null);
    try {
      const result = await responseJson(await fetch(`/api/vehicles/${id}/registration-renewal`, { cache: 'no-store', signal }));
      if (sequence === renewalSequence.current) setRenewal(result.renewal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (sequence === renewalSequence.current) setRenewalError(apiMessage(error instanceof ApiFailure ? error.code : 'REQUEST_FAILED'));
    } finally {
      if (sequence === renewalSequence.current) setRenewalLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/vehicles/${id}`, { cache: 'no-store', signal: controller.signal })
      .then(responseJson)
      .then(result => setVehicle({ id: result.vehicle.id, make: result.vehicle.make, model: result.vehicle.model, year: result.vehicle.year }))
      .catch(error => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setVehicleError(apiMessage(error instanceof ApiFailure ? error.code : 'REQUEST_FAILED'));
      });
    void Promise.allSettled([loadViolations(controller.signal), loadRenewal(controller.signal)]);
    return () => controller.abort();
  }, [id, loadRenewal, loadViolations]);

  async function payViolation(violation: Violation) {
    if (payingId) return;
    const sequence = ++violationSequence.current;
    setPayingId(violation.id);
    setPaymentNotice(current => ({ ...current, [violation.id]: '' }));
    setCheckoutLinks(current => {
      const next = { ...current };
      delete next[violation.id];
      return next;
    });
    try {
      const result = await responseJson(await fetch(`/api/vehicles/${id}/violations/${violation.id}/payment`, { method: 'POST' }));
      if (sequence !== violationSequence.current) return;
      const payment = result.payment as { status: string; checkoutUrl?: string };
      const checkoutUrl = safeCheckoutUrl(payment.checkoutUrl);
      setCheckoutLinks(current => {
        const next = { ...current };
        delete next[violation.id];
        if (checkoutUrl && payment.status === 'PAYMENT_REQUIRED') next[violation.id] = checkoutUrl;
        return next;
      });
      if (payment.status === 'PAID') {
        setViolations(current => current.map(item => item.id === violation.id ? { ...item, status: 'PAID' } : item));
        setPaymentNotice(current => ({ ...current, [violation.id]: 'أكد المزود سداد المخالفة.' }));
      } else if (payment.status === 'PAYMENT_REQUIRED') {
        setPaymentNotice(current => ({ ...current, [violation.id]: checkoutUrl ? 'أنشأ المزود خطوة دفع. افتحها لإكمال السداد لديه.' : 'طلب المزود متابعة الدفع، لكن رابط الدفع لم يجتز فحص الأمان.' }));
      } else if (payment.status === 'PENDING') {
        setPaymentNotice(current => ({ ...current, [violation.id]: 'استلم المزود الطلب وما زال تأكيد السداد معلقًا.' }));
      } else {
        setPaymentNotice(current => ({ ...current, [violation.id]: 'أفاد المزود بتعذر بدء السداد.' }));
      }
    } catch (error) {
      if (sequence === violationSequence.current) {
        setPaymentNotice(current => ({ ...current, [violation.id]: apiMessage(error instanceof ApiFailure ? error.code : 'REQUEST_FAILED') }));
      }
    } finally {
      setPayingId(null);
    }
  }

  async function submitRenewal() {
    if (!agreed || submittingRenewal) return;
    const sequence = ++renewalSequence.current;
    const previousRenewal = renewal;
    setSubmittingRenewal(true); setRenewalError('');
    try {
      const result = await responseJson(await fetch(`/api/vehicles/${id}/registration-renewal`, { method: 'POST' }));
      if (sequence === renewalSequence.current) {
        setRenewal(previousRenewal ? { ...previousRenewal, request: result.request } : null);
        setAgreed(false);
      }
    } catch (error) {
      if (sequence === renewalSequence.current) {
        setRenewal(null);
        setRenewalError(apiMessage(error instanceof ApiFailure ? error.code : 'REQUEST_FAILED'));
      }
    } finally {
      setSubmittingRenewal(false);
    }
  }

  if (vehicleError) return <main dir="rtl" className="min-h-screen bg-slate-50 p-5"><div role="alert" className="mx-auto max-w-3xl rounded-2xl border bg-white p-8 text-center"><p>{vehicleError}</p><Link href="/vehicles" className="mt-4 inline-block font-bold text-primary-900 underline">العودة إلى مركباتي</Link></div></main>;

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-5xl p-4 md:p-7">
    <Link href={`/vehicles/${id}`} className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18} aria-hidden="true" />تفاصيل المركبة</Link>
    <header className="mt-5 rounded-3xl bg-primary-900 p-6 text-white">
      <ShieldCheck size={32} aria-hidden="true" /><h1 className="mt-3 text-2xl font-black">المخالفات وتجديد التسجيل</h1>
      <p className="mt-2 text-sm leading-7 text-emerald-100">{vehicle ? `${vehicle.make} ${vehicle.model} ${vehicle.year}` : 'جارٍ تحميل بيانات المركبة…'}</p>
    </header>
    <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-950"><b>تنبيه:</b> مركبات ليست جهة حكومية. لا تظهر النتائج ولا تتغير الحالات إلا بعد رد صالح ومطابق من مزود المرور المهيأ.</div>

    <section aria-labelledby="violations-heading" className="mt-5 rounded-3xl border bg-white p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="violations-heading" className="text-xl font-black">مخالفات المركبة</h2><p className="mt-1 text-sm text-slate-500">استعلام مباشر؛ لا نعرض بيانات تجريبية عند غياب المزود.</p></div><button type="button" onClick={() => void loadViolations()} disabled={violationsLoading || payingId !== null} className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50"><RefreshCw size={16} aria-hidden="true" />تحديث</button></div>
      {violationsLoading ? <p role="status" className="mt-5 rounded-xl bg-slate-50 p-4 text-slate-600">جارٍ الاستعلام من المزود…</p> : null}
      {violationsError ? <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800"><p>{violationsError}</p><button type="button" onClick={() => void loadViolations()} className="mt-3 font-bold underline">إعادة المحاولة</button></div> : null}
      {!violationsLoading && !violationsError && violations.length === 0 ? <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900"><BadgeCheck className="inline" size={18} aria-hidden="true" /> <span>أكد المزود في هذا الاستعلام عدم وجود مخالفات مدرجة.</span></div> : null}
      {!violationsError && violations.length > 0 ? <ul className="mt-5 grid gap-3">{violations.map(violation => <li key={violation.id} className="rounded-2xl border bg-slate-50 p-4"><article aria-labelledby={`violation-${violation.id}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 id={`violation-${violation.id}`} className="font-black">{violationTypes[violation.type] || 'مخالفة مرورية'}</h3><p className="mt-1 text-sm leading-7 text-slate-600">{violation.summary}</p></div><p className="font-black text-red-700">{Number(violation.amountYER).toLocaleString('ar-YE')} ر.ي</p></div><dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3"><div><dt className="text-slate-500">الحالة</dt><dd className="font-bold">{violationStatuses[violation.status] || violation.status}</dd></div><div><dt className="text-slate-500">التاريخ</dt><dd>{displayDate(violation.issuedAt)}</dd></div><div><dt className="text-slate-500">الاستحقاق</dt><dd>{displayDate(violation.dueAt)}</dd></div></dl>{violation.status === 'PENDING' ? <div className="mt-4 flex flex-wrap items-center gap-3"><button type="button" onClick={() => void payViolation(violation)} disabled={payingId !== null} aria-describedby={`payment-note-${violation.id}`} className="rounded-xl bg-primary-900 px-4 py-2 font-bold text-white disabled:opacity-50">{payingId === violation.id ? 'جارٍ التواصل مع المزود…' : 'بدء السداد عبر المزود'}</button>{checkoutLinks[violation.id] ? <a href={checkoutLinks[violation.id]} target="_blank" rel="noreferrer" className="rounded-xl border border-emerald-300 bg-white px-4 py-2 font-bold text-emerald-800">فتح صفحة الدفع لدى المزود</a> : null}</div> : null}{paymentNotice[violation.id] ? <p id={`payment-note-${violation.id}`} role="status" aria-live="polite" className="mt-3 rounded-xl bg-white p-3 text-sm">{paymentNotice[violation.id]}</p> : <span id={`payment-note-${violation.id}`} className="sr-only">لن نسجل السداد قبل تأكيد المزود.</span>}</article></li>)}</ul> : null}
    </section>

    <section aria-labelledby="renewal-heading" className="mt-5 rounded-3xl border bg-white p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="renewal-heading" className="text-xl font-black">تجديد تسجيل المركبة</h2><p className="mt-1 text-sm text-slate-500">الأهلية والرسوم تأتيان من المزود المهيأ لحظة الاستعلام.</p></div><button type="button" onClick={() => void loadRenewal()} disabled={renewalLoading || submittingRenewal} className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50"><RefreshCw size={16} aria-hidden="true" />تحديث الحالة</button></div>
      {renewalLoading ? <p role="status" className="mt-5 rounded-xl bg-slate-50 p-4 text-slate-600">جارٍ التحقق من الأهلية والحالة…</p> : null}
      {renewalError ? <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800"><CircleAlert className="ml-2 inline" size={18} aria-hidden="true" />{renewalError}</div> : null}
      {renewal && !renewalLoading ? <div className="mt-5"><dl className="grid gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-3"><div><dt className="text-sm text-slate-500">الأهلية</dt><dd className="mt-1 font-black">{renewal.eligibility.eligible ? 'مؤهلة حسب رد المزود' : 'غير مؤهلة حاليًا'}</dd></div><div><dt className="text-sm text-slate-500">الرسوم المعروضة</dt><dd className="mt-1 font-black">{renewal.eligibility.feesYER.toLocaleString('ar-YE')} ر.ي</dd></div><div><dt className="text-sm text-slate-500">انتهاء التسجيل الحالي</dt><dd className="mt-1 font-black">{displayDate(renewal.eligibility.currentExpiryDate)}</dd></div></dl>{!renewal.eligibility.eligible && renewal.eligibility.reasonCode ? <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{renewalReasons[renewal.eligibility.reasonCode] || 'ذكر المزود سببًا لا يمكن عرضه تلقائيًا؛ راجع المرور أو الدعم.'}</p> : null}{renewal.request ? <RenewalStatusCard request={renewal.request} /> : null}{renewal.eligibility.eligible && renewal.request?.status !== 'COMPLETED' ? <fieldset className="mt-5 rounded-2xl border p-4"><legend className="px-2 font-black">إرسال طلب التجديد</legend><label className="flex items-start gap-3 text-sm leading-7"><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} className="mt-1 h-5 w-5"/><span>أقر بأن الرسوم والأهلية المعروضة واردة من المزود، وأن الإرسال لا يعني اكتمال التجديد حتى يؤكده المزود.</span></label><button type="button" onClick={() => void submitRenewal()} disabled={!agreed || submittingRenewal} aria-describedby="renewal-submit-note" className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:opacity-50"><FileClock size={18} aria-hidden="true" />{submittingRenewal ? 'جارٍ إرسال الطلب…' : 'إرسال طلب التجديد'}</button><p id="renewal-submit-note" className="mt-2 text-xs leading-6 text-slate-500">يستخدم الخادم مفتاحًا ثابتًا لمنع تكرار الطلب للدورة نفسها.</p></fieldset> : null}</div> : null}
    </section>
  </div></main>;
}
