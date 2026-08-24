'use client';

import { ArrowDownRight, ArrowUpRight, MousePointer2, Reply } from 'lucide-react';
import type { CampaignAnalytics, ConversionRates } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ConversionRatesCardProps {
  analytics: CampaignAnalytics;
}

function computeRates(analytics: CampaignAnalytics): ConversionRates {
  const sent = analytics.sent || 1;
  const delivered = analytics.delivered || 1;
  return {
    deliveryRate: (analytics.delivered / sent) * 100,
    openRate: (analytics.opened / delivered) * 100,
    clickRate: (analytics.clicked / delivered) * 100,
    replyRate: (analytics.replied / delivered) * 100,
    bounceRate: (analytics.bounced / sent) * 100,
  };
}

function RateRow({ label, value, icon: Icon }: { label: string; value: number; icon: React.ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }> }) {
  const isPositive = value > 0;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/50 py-2.5 last:border-b-0">
      <span className="text-sm text-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-semibold tabular-nums text-ink">{value.toFixed(1)}%</span>
        <span className={isPositive ? 'text-mint' : 'text-coral'}>
          {isPositive ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}
        </span>
      </div>
    </div>
  );
}

export function ConversionRatesCard({ analytics }: ConversionRatesCardProps) {
  const rates = computeRates(analytics);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversion rates</CardTitle>
      </CardHeader>
      <CardContent>
        <RateRow label="Delivery rate" value={rates.deliveryRate} icon={Reply} />
        <RateRow label="Open rate (of delivered)" value={rates.openRate} icon={Reply} />
        <RateRow label="Click rate (of delivered)" value={rates.clickRate} icon={MousePointer2} />
        <RateRow label="Reply rate (of delivered)" value={rates.replyRate} icon={Reply} />
        <RateRow label="Bounce rate" value={rates.bounceRate} icon={Reply} />
        <div className="mt-4 rounded-md bg-elevated/40 p-3">
          <p className="text-xs text-muted">
            <span className="font-semibold tabular-nums text-ink">{analytics.sent.toLocaleString()}</span> messages sent ·
            <span className="ml-1 font-semibold tabular-nums text-mint">{analytics.replied.toLocaleString()}</span> replies ·
            <span className="ml-1 font-semibold tabular-nums text-amber">{rates.replyRate.toFixed(1)}%</span> overall reply rate
          </p>
        </div>
      </CardContent>
    </Card>
  );
}