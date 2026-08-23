'use client';

import Link from 'next/link';
import { ArrowLeft, Beaker, CheckCircle2, Clock3, Mail, MousePointer2, Reply, Send, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { CampaignAnalytics, CampaignMessage } from '@/lib/types';
import { FunnelChart } from '@/components/FunnelChart';
import { StatCard } from '@/components/StatCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const statDefinitions = [
  { key: 'sent', label: 'Sent', icon: Send, tone: 'cyan' as const },
  { key: 'delivered', label: 'Delivered', icon: CheckCircle2, tone: 'mint' as const },
  { key: 'opened', label: 'Opened', icon: Mail, tone: 'amber' as const },
  { key: 'clicked', label: 'Clicked', icon: MousePointer2, tone: 'coral' as const },
  { key: 'replied', label: 'Replied', icon: Reply, tone: 'violet' as const },
  { key: 'bounced', label: 'Bounced', icon: ShieldAlert, tone: 'coral' as const },
  { key: 'pending', label: 'Pending', icon: Clock3, tone: 'cyan' as const },
] as const;

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function statusClass(status: string) {
  if (status === 'REPLIED') return 'border-mint/30 bg-mint/10 text-mint';
  if (status === 'OPENED' || status === 'CLICKED' || status === 'DELIVERED') return 'border-cyan/30 bg-cyan/10 text-cyan';
  if (status === 'FAILED' || status === 'BOUNCED') return 'border-coral/30 bg-coral/10 text-coral';
  return 'border-line bg-elevated text-muted';
}

export function CampaignDetailClient({ campaignId }: { campaignId: string }) {
  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null);
  const [messages, setMessages] = useState<CampaignMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch<CampaignAnalytics>(`/api/v1/campaigns/${campaignId}/analytics`),
      apiFetch<CampaignMessage[]>(`/api/v1/campaigns/${campaignId}/messages?limit=25`),
    ]).then(([nextAnalytics, nextMessages]) => {
      if (!active) return;
      setAnalytics(nextAnalytics);
      setMessages(nextMessages);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load campaign');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [campaignId]);

  if (loading) return <div className="h-96 animate-pulse rounded-lg border border-line bg-panel" aria-label="Loading campaign" />;
  if (error || !analytics) return <div className="rounded-lg border border-coral/40 bg-coral/10 p-5 text-sm text-coral" role="alert">{error ?? 'Campaign analytics unavailable'}</div>;

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href="/" className="mb-4 inline-flex items-center gap-2 text-xs text-muted hover:text-ink"><ArrowLeft size={14} aria-hidden="true" /> All campaigns</Link>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-mint">Campaign detail</p>
          <h1 className="mt-2 break-words text-3xl font-semibold text-ink">{analytics.campaign_name ?? campaignId}</h1>
        </div>
        <Button variant="secondary" asChild><Link href={`/campaigns/${campaignId}/ab-tests`}><Beaker size={15} aria-hidden="true" /> A/B tests</Link></Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {statDefinitions.map(stat => <StatCard key={stat.key} label={stat.label} value={analytics[stat.key].toLocaleString()} icon={stat.icon} tone={stat.tone} />)}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader><CardTitle>Conversion funnel</CardTitle></CardHeader>
          <CardContent><FunnelChart analytics={analytics} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Channel mix</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {Object.entries(analytics.by_channel).length === 0 ? <p className="text-sm text-muted">No channel data yet.</p> : Object.entries(analytics.by_channel).map(([channel, count]) => {
              const total = Math.max(1, Object.values(analytics.by_channel).reduce((sum, value) => sum + value, 0));
              return <div key={channel}><div className="flex justify-between gap-3 text-sm"><span className="text-ink">{channel.replaceAll('_', ' ')}</span><span className="tabular-nums text-muted">{count}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-cyan" style={{ width: `${(count / total) * 100}%` }} /></div></div>;
            })}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="border-b border-line"><CardTitle>Recent messages</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-line bg-elevated/40 text-[11px] uppercase tracking-[0.12em] text-muted"><tr><th className="px-5 py-3 font-medium">Lead</th><th className="px-5 py-3 font-medium">Channel</th><th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3 font-medium">Subject</th><th className="px-5 py-3 font-medium">Created</th></tr></thead>
              <tbody className="divide-y divide-line">
                {messages.map(message => <tr key={message.id} className="hover:bg-elevated/30"><td className="px-5 py-4"><p className="font-medium text-ink">{message.lead_name}</p><p className="mt-1 text-xs text-muted">{message.lead_email ?? 'No email'}</p></td><td className="px-5 py-4 text-xs text-muted">{message.channel.replaceAll('_', ' ')}</td><td className="px-5 py-4"><Badge className={statusClass(message.status)}>{message.status}</Badge></td><td className="max-w-[260px] px-5 py-4"><p className="truncate text-ink">{message.subject ?? message.body_preview}</p></td><td className="whitespace-nowrap px-5 py-4 text-xs text-muted">{formatDate(message.created_at)}</td></tr>)}
              </tbody>
            </table>
          </div>
          {messages.length === 0 ? <p className="p-8 text-center text-sm text-muted">No messages recorded for this campaign.</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
