import './globals.css';
import type { Metadata } from 'next';
import PwaRegister from './pwa-register';

export const metadata: Metadata = { title:'مركبات', description:'منصة المركبات والخدمات المرورية في اليمن', manifest:'/manifest.json' };

export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="ar" dir="rtl"><body><PwaRegister />{children}</body></html>;
}
