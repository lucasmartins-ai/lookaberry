'use client';

import Link from 'next/link';
import { Activity, ArrowUpRight, CheckCircle2, Clock3, Mail, MousePointer2, Reply, Send, ShieldAlert, Users, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { Campaign, CampaignAnalytics, FilterState, SyncHealth } from '@/lib/types';
import { StatCard } from '@/components/StatCard';
import { Badge } from '@/components/ui/badge';
import { FilterBar } from '@/components/FilterBar';
import { AutoRefresh, useAutoRefresh } from '@/components/AutoRefresh';
import { SyncStatusBar } from '@/components/SyncStatusBar';

interface CampaignWithAnalytics extends Campaign {
  analytics: CampaignAnalytics;
}

const statDefinitions = [
  { key: 'sent', label: 'Sent', icon: Send, tone: 'cyan' as const },
  { key: 'delivered', label: 'Delivered', icon: CheckCircle2, tone: 'mint' as const },
  { key: 'opened', label: 'Opened', icon: Mail, tone: 'amber' as const },
  { key: 'clicked', label: 'Clicked', icon: MousePointer2, tone: 'coral' as const },
  { key: 'replied', label: 'Replied', icon: Reply, tone: 'violet' as const },
  { key: 'bounced', label: 'Bounced', icon: ShieldAlert, tone: 'coral' as const },
  { key: 'pending', label: 'Pending', icon: Clock3, tone: 'cyan' as const },
] as const;

function conversionRate(analytics: CampaignAnalytics, key: 'delivered' | 'opened' | 'clicked' | 'replied') {
  return analytics.sent > 0 ? (analytics[key] / analytics.sent) * 100 : 0;
}

const DEFAULT_FILTERS: FilterState = { channel: '', status: '', variant: '', periodStart: '', periodEnd: '' };

function buildFilterParams(filters: FilterState): string {
  const params = new URLSearchParams();
  if (filters.channel) params.set('channel', filters.channel);
  if (filters.status) params.set('status', filters.status);
  if (filters.periodStart) params.set('period_start', filters.periodStart);
  if (filters.periodEnd) params.set('period_end', filters.periodEnd);
  return params.toString();
}

export function DashboardOverview() {
  const [campaigns, setCampaigns] = useState<CampaignWithAnalytics[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [syncHealth, setSyncHealth] = useState<SyncHealth | null>(null);

  const load = useCallback(async () => {
    try {
      const campaignList = await apiFetch<Campaign[]>('/api/v1/campaigns');
      const filterQs = buildFilterParams(filters);
      const withAnalytics = await Promise.all(
        campaignList.map(async campaign => ({
          ...campaign,
          analytics: await apiFetch<CampaignAnalytics>(
            `/api/v1/campaigns/${campaign.id}/analytics${filterQs ? `?${filterQs}` : ''}`,
          ),
        })),
      );
      setCampaigns(withAnalytics);
      setError(null);

      // S13: Fetch sync health in parallel
      try {
        const health = await apiFetch<SyncHealth>('/api/v1/health/sync');
        setSyncHealth(health);
      } catch {
        setSyncHealth(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load campaigns');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const refresh = useAutoRefresh(load, { enabled: false });

  return (
    <div className="space-y-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-mint">Campaign operations</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-normal text-ink sm:text-4xl">Overview</h1>
        </div>
        <div className="flex items-center gap-3">
          <AutoRefresh
            autoEnabled={refresh.autoEnabled}
            refreshing={refresh.refreshing}
            intervalMs={refresh.intervalMs}
            minIntervalMs={refresh.minIntervalMs}
            maxIntervalMs={refresh.maxIntervalMs}
            onToggle={refresh.setAutoEnabled}
            onIntervalChange={refresh.setInterval}
            onManualRefresh={() => void refresh.doRefresh()}
          />
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Activity size={15} className="text-mint" aria-hidden="true" /> Live
          </span>
        </div>
      </div>

      <SyncStatusBar
        syncHealth={syncHealth}
        error={error}
        isLoading={loading}
        lastRefreshedAt={refresh.lastRefreshedAt}
      />

      <FilterBar filters={filters} onChange={setFilters} />

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading campaigns">
          {[1, 2, 3].map(item => <div key={item} className="h-56 animate-pulse rounded-lg border border-line bg-panel" />)}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-coral/40 bg-coral/10 p-5 text-sm text-coral" role="alert">{error}</div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-panel/50 p-10 text-center">
          <Users size={24} className="mx-auto text-muted" aria-hidden="true" />
          <h2 className="mt-4 text-base font-semibold text-ink">No campaigns yet</h2>
          <p className="mt-2 text-sm text-muted">No campaign data available.</p>
        </div>
      ) : (
        <div className="space-y-10">
          {campaigns.map(({ analytics, ...campaign }) => (
            <section key={campaign.id} aria-labelledby={`campaign-${campaign.id}`}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 id={`campaign-${campaign.id}`} className="truncate text-lg font-semibold text-ink">{campaign.name}</h2>
                      <Badge className={campaign.is_active ? 'border-mint/30 bg-mint/10 text-mint' : 'border-line text-muted'}>{campaign.is_active ? 'Active' : 'Paused'}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted">{analytics.sent.toLocaleString()} messages in the current campaign view</p>
                  </div>
                </div>
                <Link href={`/campaigns/${campaign.id}`} className="inline-flex items-center gap-1.5 text-xs font-medium text-mint hover:text-ink">
                  Open campaign <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                {statDefinitions.map(stat => {
                  const value = analytics[stat.key];
                  const rateKey = stat.key === 'delivered' || stat.key === 'opened' || stat.key === 'clicked' || stat.key === 'replied' ? stat.key : null;
                  return <StatCard key={stat.key} label={stat.label} value={value.toLocaleString()} icon={stat.icon} tone={stat.tone} trend={rateKey ? conversionRate(analytics, rateKey) : undefined} detail={rateKey ? `${conversionRate(analytics, rateKey).toFixed(1)}% of sent` : undefined} />;
                })}
              </div>
              {analytics.failed > 0 ? <p className="mt-3 flex items-center gap-2 text-xs text-coral"><XCircle size={14} aria-hidden="true" /> {analytics.failed} failed message{analytics.failed === 1 ? '' : 's'} require attention.</p> : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}