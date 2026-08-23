'use client';

import Link from 'next/link';
import { Activity, BarChart3, ChevronRight, Gauge, Radio } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/', label: 'Campaigns', icon: BarChart3 },
  { href: '/system', label: 'System health', icon: Activity },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-line bg-panel/90 px-4 py-5 lg:block">
        <div className="flex items-center gap-3 px-3">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-mint text-canvas">
            <Radio size={18} strokeWidth={2.2} aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-wide text-ink">LookaBerry</p>
            <p className="text-[11px] uppercase tracking-[0.14em] text-muted">Ops dashboard</p>
          </div>
        </div>
        <nav className="mt-10 space-y-1" aria-label="Primary navigation">
          {navItems.map(item => {
            const Icon = item.icon;
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className={cn('flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors', active ? 'bg-elevated text-ink' : 'text-muted hover:bg-elevated/70 hover:text-ink')}>
                <Icon size={17} aria-hidden="true" />
                {item.label}
                {active ? <ChevronRight size={14} className="ml-auto text-mint" aria-hidden="true" /> : null}
              </Link>
            );
          })}
        </nav>
        <div className="absolute bottom-5 left-7 right-7 border-t border-line pt-4">
          <div className="flex items-center gap-2 text-xs text-muted"><Gauge size={14} className="text-mint" aria-hidden="true" /> API connected locally</div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-line bg-canvas/95 px-4 py-3 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between gap-4">
            <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-ink"><Radio size={17} className="text-mint" aria-hidden="true" /> LookaBerry</Link>
            <nav className="flex items-center gap-1" aria-label="Mobile navigation">
              {navItems.map(item => {
                const Icon = item.icon;
                const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                return <Link key={item.href} href={item.href} aria-label={item.label} className={cn('grid h-9 w-9 place-items-center rounded-md', active ? 'bg-elevated text-ink' : 'text-muted')}><Icon size={17} aria-hidden="true" /></Link>;
              })}
            </nav>
          </div>
        </header>
        <main className="mx-auto min-h-screen max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-9">{children}</main>
      </div>
    </div>
  );
}
