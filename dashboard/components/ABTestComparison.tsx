'use client';

import { useState } from 'react';
import { Check, FlaskConical, Info, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmationDialog } from '@/components/ConfirmationDialog';
import { type ABTestGroup, type ABVariant } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ABTestComparisonProps {
  group: ABTestGroup;
  onPromote?: (groupId: string, winnerStepId: string) => Promise<void> | void;
  promoting?: boolean;
}

const metrics = [
  { key: 'impressions' as const, label: 'Impressions', color: 'bg-cyan' },
  { key: 'opens' as const, label: 'Opens', color: 'bg-amber' },
  { key: 'replies' as const, label: 'Replies', color: 'bg-mint' },
] as const;

function metricValue(variant: ABVariant, key: (typeof metrics)[number]['key']) {
  return variant[key];
}

export function ABTestComparison({ group, onPromote, promoting = false }: ABTestComparisonProps) {
  const [showPromoteConfirm, setShowPromoteConfirm] = useState(false);
  const fallbackWinner = [...group.variants].sort((a, b) => b.replies - a.replies || b.opens - a.opens)[0];
  const winner = group.variants.find(variant => variant.isWinner) ?? fallbackWinner;
  const hasSufficientSamples = group.totalImpressions >= group.minSamplesRequired;

  const handlePromoteClick = () => {
    if (group.hasWinner && winner) {
      setShowPromoteConfirm(true);
    }
  };

  const handleConfirmPromote = () => {
    setShowPromoteConfirm(false);
    if (winner) onPromote?.(group.variantGroup, winner.stepId);
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 border-b border-line">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-violet-300/10 text-violet-300">
              <FlaskConical size={17} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <CardTitle className="truncate">{group.variantGroup}</CardTitle>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{group.totalImpressions} impressions</span>
                <span className="opacity-50">·</span>
                <span>
                  Sample: {hasSufficientSamples ? (
                    <span className="text-mint">✓ {group.totalImpressions}/{group.minSamplesRequired}</span>
                  ) : (
                    <span className="text-amber">{group.totalImpressions}/{group.minSamplesRequired}</span>
                  )}
                </span>
                <span className="opacity-50">·</span>
                <span>Confidence threshold: {(group.requiredConfidence * 100).toFixed(0)}%</span>
              </div>
            </div>
          </div>
          {onPromote ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={handlePromoteClick}
              disabled={promoting || !group.hasWinner}
            >
              <Trophy size={14} aria-hidden="true" />
              {promoting ? 'Promoting...' : 'Promote Winner'}
            </Button>
          ) : null}
        </CardHeader>

        {group.bestVariantProbability !== null ? (
          <div className="border-b border-line bg-cyan/5 px-5 py-3">
            <div className="flex items-center gap-2">
              <Info size={14} className="text-cyan" aria-hidden="true" />
              <p className="text-xs text-muted">
                Best variant leads with{' '}
                <span className="font-semibold tabular-nums text-ink">{(group.bestVariantProbability * 100).toFixed(1)}%</span>
                {' '}probability
                {group.bestVariantProbability >= group.requiredConfidence ? (
                  <span className="ml-1 text-mint">(statistically significant ✓)</span>
                ) : (
                  <span className="ml-1 text-amber">(below {group.requiredConfidence * 100}% threshold)</span>
                )}
              </p>
            </div>
          </div>
        ) : null}

        <CardContent className="space-y-5 p-5">
          {group.variants.map(variant => (
            <div
              key={variant.stepId}
              className={cn(
                'rounded-md border p-4',
                variant.isWinner ? 'border-mint/50 bg-mint/5' : 'border-line bg-elevated/40',
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                      Variant {String.fromCharCode(65 + variant.stepIndex)}
                    </p>
                    {variant.isWinner ? <Check size={15} className="shrink-0 text-mint" aria-label="Current winner" /> : null}
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-ink">{variant.body || 'No copy preview available'}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-muted">Conv.</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-ink">
                    {variant.conversionRate.toFixed(1)}%
                  </p>
                </div>
              </div>

              {/* Metric bars */}
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

              {/* S13: Confidence interval & posterior mean */}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line/50 pt-3">
                <p className="text-[11px] text-muted">
                  Posterior mean:{' '}
                  <span className="tabular-nums text-ink">{(variant.posteriorMean * 100).toFixed(1)}%</span>
                </p>
                <p className="text-[11px] text-muted">
                  95% CI:{' '}
                  <span className="tabular-nums text-ink">
                    [{(variant.confidenceInterval95[0] * 100).toFixed(1)}%–{(variant.confidenceInterval95[1] * 100).toFixed(1)}%]
                  </span>
                </p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <ConfirmationDialog
        open={showPromoteConfirm}
        title="Promote winning variant"
        description={
          group.hasWinner && winner
            ? `This will set Variant ${String.fromCharCode(65 + winner.stepIndex)} as the only active variant for "${group.variantGroup}" and deactivate all others. This action cannot be easily undone.`
            : 'No winning variant detected.'
        }
        confirmLabel="Promote"
        variant="safe"
        loading={promoting}
        onConfirm={handleConfirmPromote}
        onCancel={() => setShowPromoteConfirm(false)}
      />
    </>
  );
}