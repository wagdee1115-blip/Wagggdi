import './globals.css';
import type { Metadata } from 'next';
import PwaRegister from './pwa-register';
import MobileNav from './components/mobile-nav';

const isGovernmentDemo = process.env.APP_MODE === 'GOVERNMENT_DEMO';

export const metadata: Metadata = {
  title: isGovernmentDemo ? 'مركبات | عرض حكومي تجريبي' : 'مركبات',
  description:'منصة المركبات والخدمات المرورية في اليمن',
  manifest:'/manifest.json',
};

export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="ar" dir="rtl"><body><PwaRegister />{isGovernmentDemo && <div role="status" className="sticky top-0 z-[60] border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-xs font-bold text-amber-950">بيئة عرض حكومي تجريبية — لا توجد معاملات حكومية أو مالية حقيقية</div>}{children}<MobileNav /></body></html>;
}
