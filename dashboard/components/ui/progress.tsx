import * as React from 'react';
import { cn } from '@/lib/utils';

export function Progress({ value, className }: { value: number; className?: string }) {
  const bounded = Math.min(100, Math.max(0, value));
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-line', className)} role="progressbar" aria-valuenow={bounded} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-cyan transition-[width]" style={{ width: `${bounded}%` }} />
    </div>
  );
}
