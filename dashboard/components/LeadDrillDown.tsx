'use client';

import { ArrowLeft, Mail, MousePointerClick, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { LeadDetail, LeadInteraction } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface LeadDrillDownProps {
  campaignId: string;
  leadId: string;
  leadName: string;
  onClose: () => void;
}

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

function TimelineEntry({ interaction, index, total }: { interaction: LeadInteraction; index: number; total: number }) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-line bg-panel text-[11px] font-semibold tabular-nums text-mint">
          {index + 1}
        </span>
        {index < total - 1 ? <div className="mt-1 w-px flex-1 bg-line" /> : null}
      </div>
      <div className="min-w-0 flex-1 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink">{interaction.channel.replaceAll('_', ' ')}</span>
          <Badge className={statusClass(interaction.status)}>{interaction.status}</Badge>
          <span className="text-[11px] text-muted">{formatDate(interaction.sent_at ?? interaction.created_at)}</span>
        </div>
        {interaction.subject ? (
          <p className="mt-1 text-sm font-medium text-ink">{interaction.subject}</p>
        ) : null}
        <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-muted">{interaction.body}</p>
        <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
          {interaction.opened_at ? <span className="flex items-center gap-1"><Mail size={11} aria-hidden="true" /> Opened {formatDate(interaction.opened_at)}</span> : null}
          {interaction.clicked_at ? <span className="flex items-center gap-1"><MousePointerClick size={11} aria-hidden="true" /> Clicked {formatDate(interaction.clicked_at)}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function LeadDrillDown({ campaignId, leadId, leadName, onClose }: LeadDrillDownProps) {
  const [data, setData] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<LeadDetail>(`/api/v1/campaigns/${campaignId}/leads/${leadId}`)
      .then(d => { if (active) setData(d); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Failed to load lead details'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [campaignId, leadId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Button variant="ghost" size="sm" onClick={onClose} className="text-xs text-muted hover:text-ink">
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" />
          Back to messages
        </Button>
      </div>

      {loading ? (
        <div className="h-64 animate-pulse rounded-lg border border-line bg-panel" aria-label="Loading lead details" />
      ) : error ? (
        <div className="rounded-lg border border-coral/40 bg-coral/10 p-5 text-sm text-coral" role="alert">{error}</div>
      ) : data ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-start gap-4">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-cyan/10 text-cyan">
                  <User size={22} aria-hidden="true" />
                </span>
                <div>
                  <CardTitle>{data.lead.full_name}</CardTitle>
                  <p className="mt-1 text-sm text-muted">{data.lead.title}{data.lead.title && data.lead.company ? ' · ' : ''}{data.lead.company}</p>
                  <p className="text-sm text-muted">{data.lead.email}</p>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader className="border-b border-line">
              <CardTitle>Interaction timeline</CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              {data.interactions.length === 0 ? (
                <p className="text-sm text-muted">No interactions recorded.</p>
              ) : (
                <div>
                  {data.interactions.map((interaction, index) => (
                    <TimelineEntry
                      key={interaction.id}
                      interaction={interaction}
                      index={index}
                      total={data.interactions.length}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}