'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type VehicleFormValues = {
  plateNumber: string;
  vin: string;
  make: string;
  model: string;
  year: string;
  price: string;
  mileage: string;
  transmission: 'AUTO' | 'MANUAL';
  fuelType: 'PETROL' | 'DIESEL' | 'HYBRID' | 'ELECTRIC';
  color: string;
  city: string;
  description: string;
};

const emptyValues: VehicleFormValues = {
  plateNumber: '', vin: '', make: '', model: '', year: '', price: '', mileage: '',
  transmission: 'AUTO', fuelType: 'PETROL', color: '', city: '', description: '',
};

const errorMessages: Record<string, string> = {
  INVALID_INPUT: 'تحقق من الحقول المطلوبة والقيم المدخلة.',
  VEHICLE_IDENTIFIER_EXISTS: 'رقم اللوحة أو رقم الهيكل مسجل مسبقًا.',
  VEHICLE_LOCKED: 'لا يمكن تعديل المركبة أثناء حجزها أو بعد بيعها.',
  UNAUTHORIZED: 'انتهت الجلسة. سجّل الدخول ثم أعد المحاولة.',
  FORBIDDEN: 'لا تملك صلاحية تعديل هذه المركبة.',
};

export default function VehicleForm({
  initialValues,
  vehicleId,
}: {
  initialValues?: Partial<VehicleFormValues>;
  vehicleId?: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<VehicleFormValues>({ ...emptyValues, ...initialValues });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  function update<K extends keyof VehicleFormValues>(key: K, value: VehicleFormValues[K]) {
    setValues(current => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch(vehicleId ? `/api/vehicles/${vehicleId}` : '/api/vehicles', {
        method: vehicleId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          vin: values.vin.trim().toUpperCase(),
          plateNumber: values.plateNumber.trim(),
          year: Number(values.year),
          price: Number(values.price),
          mileage: Number(values.mileage),
          description: values.description.trim() || null,
        }),
      });
      const result = await response.json().catch(() => ({ ok: false, error: 'INVALID_RESPONSE' }));
      if (!response.ok || !result.ok) throw new Error(result.error || 'VEHICLE_SAVE_FAILED');
      router.push(vehicleId ? `/vehicles/${result.vehicle.id}` : `/vehicles/${result.vehicle.id}?verify=1`);
      router.refresh();
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : 'VEHICLE_SAVE_FAILED';
      setError(errorMessages[code] || 'تعذر حفظ المركبة الآن. حاول مرة أخرى.');
    } finally {
      setPending(false);
    }
  }

  const inputClass = 'mt-1 w-full rounded-xl border border-slate-300 bg-white p-3 outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100';
  return (
    <form onSubmit={submit} className="space-y-5" aria-busy={pending}>
      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      <fieldset disabled={pending} className="grid gap-4 md:grid-cols-2 disabled:opacity-70">
        <label className="text-sm font-bold">رقم اللوحة
          <input required minLength={2} autoComplete="off" value={values.plateNumber} onChange={e => update('plateNumber', e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm font-bold">رقم الهيكل (VIN)
          <input required minLength={10} maxLength={40} dir="ltr" autoCapitalize="characters" autoComplete="off" value={values.vin} onChange={e => update('vin', e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm font-bold">الشركة المصنعة
          <input required value={values.make} onChange={e => update('make', e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm font-bold">الموديل
          <input required value={values.model} onChange={e => update('model', e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm font-bold">سنة الصنع
          <input required type="number" min="1980" max="2027" inputMode="numeric" value={values.year} onChange={e => update('year', e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm font-bold">القيمة التقديرية (ريال يمني)
          <input required type="number" min="1" step="1" inputMode="numeric" value={values.price} onChange={e => update('price', e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm font-bold">المسافة المقطوعة (كم)
          <input required type="number" min="0" step="1" inputMode="numeric" value={values.mileage} onChange={e => update('mileage', e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm font-bold">ناقل الحركة
          <select value={values.transmission} onChange={e => update('transmission', e.target.value as VehicleFormValues['transmission'])} className={inputClass}>
            <option value="AUTO">أوتوماتيك</option><option value="MANUAL">يدوي</option>
          </select>
        </label>
        <label className="text-sm font-bold">نوع الوقود
          <select value={values.fuelType} onChange={e => update('fuelType', e.target.value as VehicleFormValues['fuelType'])} className={inputClass}>
            <option value="PETROL">بنزين</option><option value="DIESEL">ديزل</option><option value="HYBRID">هجين</option><option value="ELECTRIC">كهربائي</option>
          </select>
        </label>
        <label className="text-sm font-bold">اللون
          <input required value={values.color} onChange={e => update('color', e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm font-bold md:col-span-2">المدينة
          <input required value={values.city} onChange={e => update('city', e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm font-bold md:col-span-2">وصف المركبة (اختياري)
          <textarea rows={5} maxLength={10_000} value={values.description} onChange={e => update('description', e.target.value)} className={inputClass} />
        </label>
      </fieldset>
      <button type="submit" disabled={pending} className="w-full rounded-xl bg-primary-900 px-5 py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60">
        {pending ? 'جارٍ الحفظ…' : vehicleId ? 'حفظ التعديلات' : 'إضافة المركبة'}
      </button>
    </form>
  );
}
