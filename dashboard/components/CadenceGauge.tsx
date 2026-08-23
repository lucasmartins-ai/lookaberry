'use client';

import { cn } from '@/lib/utils';

interface CadenceGaugeProps {
  label: string;
  used: number;
  limit: number;
  compact?: boolean;
}

export function CadenceGauge({ label, used, limit, compact = false }: CadenceGaugeProps) {
  const ratio = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  const percentage = Math.round(ratio * 100);
  const color = percentage >= 90 ? '#ed8e83' : percentage >= 70 ? '#f2bd72' : '#8de0bc';

  return (
    <div className={cn('flex items-center gap-4', compact ? 'py-2' : 'flex-col justify-center gap-3')}>
      <div
        className={cn('relative grid shrink-0 place-items-center rounded-full', compact ? 'h-14 w-14' : 'h-32 w-32')}
        style={{ background: `conic-gradient(${color} ${percentage * 3.6}deg, #2a3233 0deg)` }}
        role="progressbar"
        aria-label={`${label} utilization`}
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={cn('grid place-items-center rounded-full bg-panel', compact ? 'h-11 w-11' : 'h-24 w-24')}>
          <span className={cn('font-semibold tabular-nums text-ink', compact ? 'text-sm' : 'text-2xl')}>{percentage}%</span>
        </div>
      </div>
      <div className={cn(compact ? 'min-w-0' : 'text-center')}>
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="mt-1 text-xs tabular-nums text-muted">{used} / {limit} used</p>
      </div>
    </div>
  );
}
