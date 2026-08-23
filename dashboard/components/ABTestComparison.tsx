'use client';

import { Check, FlaskConical, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type ABTestGroup, type ABVariant } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ABTestComparisonProps {
  group: ABTestGroup;
  onPromote?: (groupId: string, winnerStepId: string) => Promise<void> | void;
  promoting?: boolean;
}

const metrics = [
  { key: 'impressions', label: 'Impressions', color: 'bg-cyan' },
  { key: 'opens', label: 'Opens', color: 'bg-amber' },
  { key: 'replies', label: 'Replies', color: 'bg-mint' },
] as const;

function metricValue(variant: ABVariant, key: (typeof metrics)[number]['key']) {
  return variant[key];
}

export function ABTestComparison({ group, onPromote, promoting = false }: ABTestComparisonProps) {
  const fallbackWinner = [...group.variants].sort((a, b) => b.replies - a.replies || b.opens - a.opens)[0];
  const winner = group.variants.find(variant => variant.isWinner) ?? fallbackWinner;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 border-b border-line">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-violet-300/10 text-violet-300">
            <FlaskConical size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <CardTitle className="truncate">{group.variantGroup}</CardTitle>
            <p className="mt-1 text-xs text-muted">{group.totalImpressions} total impressions</p>
          </div>
        </div>
        {onPromote && winner ? (
          <Button variant="secondary" size="sm" onClick={() => onPromote(group.variantGroup, winner.stepId)} disabled={promoting}>
            <Trophy size={14} aria-hidden="true" />
            {promoting ? 'Promoting...' : 'Promote Winner'}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        {group.variants.map(variant => (
          <div key={variant.stepId} className={cn('rounded-md border p-4', variant.isWinner ? 'border-mint/50 bg-mint/5' : 'border-line bg-elevated/40')}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Variant {String.fromCharCode(65 + variant.stepIndex)}</p>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-ink">{variant.body || 'No copy preview available'}</p>
              </div>
              {variant.isWinner ? <Check size={17} className="shrink-0 text-mint" aria-label="Current winner" /> : null}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {metrics.map(metric => {
                const max = Math.max(1, ...group.variants.map(item => metricValue(item, metric.key)));
                const value = metricValue(variant, metric.key);
                return (
                  <div key={metric.key}>
                    <div className="flex justify-between gap-2 text-xs">
                      <span className="text-muted">{metric.label}</span>
                      <span className="tabular-nums text-ink">{value}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                      <div className={cn('h-full rounded-full', metric.color)} style={{ width: `${(value / max) * 100}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
