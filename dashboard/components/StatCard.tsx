import type { LucideIcon } from 'lucide-react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: number | string;
  icon: LucideIcon;
  tone?: 'cyan' | 'mint' | 'amber' | 'coral' | 'violet';
  detail?: string;
  trend?: number;
}

const toneClasses = {
  cyan: 'bg-cyan/10 text-cyan',
  mint: 'bg-mint/10 text-mint',
  amber: 'bg-amber/10 text-amber',
  coral: 'bg-coral/10 text-coral',
  violet: 'bg-violet-300/10 text-violet-300',
};

export function StatCard({ label, value, icon: Icon, tone = 'cyan', detail, trend }: StatCardProps) {
  return (
    <Card className="min-w-0">
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-[0.12em] text-muted">{label}</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-ink">{value}</p>
          {detail ? <p className="mt-1 truncate text-xs text-muted">{detail}</p> : null}
          {typeof trend === 'number' ? (
            <p className={cn('mt-2 flex items-center gap-1 text-xs', trend >= 0 ? 'text-mint' : 'text-coral')}>
              {trend >= 0 ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}
              {Math.abs(trend).toFixed(1)}% conversion
            </p>
          ) : null}
        </div>
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-md', toneClasses[tone])}>
          <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
        </span>
      </CardContent>
    </Card>
  );
}
