'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import VehicleForm, { type VehicleFormValues } from '@/app/components/vehicle-form';

export default function EditVehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [values, setValues] = useState<VehicleFormValues | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/vehicles/${id}`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const result = await response.json().catch(() => ({ ok: false }));
      if (!response.ok || !result.ok) throw new Error(result.error || 'VEHICLE_UNAVAILABLE');
      const vehicle = result.vehicle;
      setValues({
        plateNumber: vehicle.plateNumber, vin: vehicle.vin, make: vehicle.make, model: vehicle.model,
        year: String(vehicle.year), price: String(vehicle.price), mileage: String(vehicle.mileage),
        transmission: vehicle.transmission, fuelType: vehicle.fuelType, color: vehicle.color,
        city: vehicle.city, description: vehicle.description || '',
      });
    }).catch(caught => {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught instanceof Error && caught.message === 'VEHICLE_LOCKED' ? 'لا يمكن تعديل المركبة أثناء حجزها.' : 'تعذر تحميل المركبة للتعديل.');
    });
    return () => controller.abort();
  }, [id]);

  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-3xl p-4 md:p-7">
    <Link href={`/vehicles/${id}`} className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18} />تفاصيل المركبة</Link>
    <section className="mt-5 rounded-3xl border bg-white p-5 shadow-sm md:p-7"><h1 className="text-2xl font-black">تعديل المركبة</h1><p className="mb-6 mt-2 text-sm text-slate-500">لن يُسمح بالتعديل إذا كانت المركبة محجوزة ضمن عملية أو مباعة.</p>{error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">{error}</div> : values ? <VehicleForm vehicleId={id} initialValues={values} /> : <div role="status" className="rounded-xl bg-slate-50 p-6 text-center text-slate-500">جارٍ تحميل البيانات…</div>}</section>
  </div></main>;
}

