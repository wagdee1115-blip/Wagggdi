import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import VehicleForm from '@/app/components/vehicle-form';
import { getCurrentUser } from '@/lib/api-auth';

export default async function NewVehiclePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/auth/login?next=/vehicles/new');
  return <main dir="rtl" className="min-h-screen bg-slate-50"><div className="mx-auto max-w-3xl p-4 md:p-7">
    <Link href="/vehicles" className="inline-flex items-center gap-2 text-sm font-bold text-primary-900"><ArrowRight size={18} />مركباتي</Link>
    <section className="mt-5 rounded-3xl border bg-white p-5 shadow-sm md:p-7"><h1 className="text-2xl font-black">إضافة مركبة</h1><p className="mb-6 mt-2 text-sm leading-6 text-slate-500">تُحفظ المركبة كمسودة خاصة، ثم تنتقل إلى صفحة توثيق الملكية لدى المزود الحكومي. لا تصبح نشطة أو قابلة للنشر قبل نجاح التوثيق.</p><VehicleForm /></section>
  </div></main>;
}
