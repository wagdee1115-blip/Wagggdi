'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CarFront, Gavel, Home, Store, UserCircle } from 'lucide-react';

const items = [
  { href: '/', label: 'الرئيسية', Icon: Home },
  { href: '/market', label: 'السوق', Icon: Store },
  { href: '/vehicles', label: 'مركباتي', Icon: CarFront },
  { href: '/auctions', label: 'المزادات', Icon: Gavel },
  { href: '/account', label: 'حسابي', Icon: UserCircle },
];

export default function MobileNav() {
  const pathname = usePathname();
  if (pathname.startsWith('/auth')) return null;
  return <nav aria-label="التنقل الرئيسي" className="fixed inset-x-0 bottom-0 z-40 border-t bg-white/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
    <ul className="mx-auto grid max-w-lg grid-cols-5">
      {items.map(({ href, label, Icon }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return <li key={href}><Link href={href} aria-current={active ? 'page' : undefined} className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-bold ${active ? 'text-primary-900' : 'text-slate-500'}`}><Icon aria-hidden="true" size={20}/><span>{label}</span></Link></li>;
      })}
    </ul>
  </nav>;
}
