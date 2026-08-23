'use client';

import Link from 'next/link';
import { ArrowLeft, Beaker, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ABTestComparison } from '@/components/ABTestComparison';
import { apiFetch } from '@/lib/api';
import type { ABTestGroup } from '@/lib/types';
import { Button } from '@/components/ui/button';

export function ABTestsClient({ campaignId }: { campaignId: string }) {
  const [groups, setGroups] = useState<ABTestGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setGroups(await apiFetch<ABTestGroup[]>(`/api/v1/campaigns/${campaignId}/ab-tests`));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load A/B tests');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [campaignId]);

  async function promote(groupId: string, winnerStepId: string) {
    setPromoting(groupId);
    try {
      await apiFetch(`/api/v1/campaigns/${campaignId}/ab-tests/${encodeURIComponent(groupId)}/promote`, { method: 'POST', body: JSON.stringify({ winnerStepId }) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to promote winner');
    } finally {
      setPromoting(null);
    }
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href={`/campaigns/${campaignId}`} className="mb-4 inline-flex items-center gap-2 text-xs text-muted hover:text-ink"><ArrowLeft size={14} aria-hidden="true" /> Campaign detail</Link>
          <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-md bg-violet-300/10 text-violet-300"><Beaker size={19} aria-hidden="true" /></span><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-mint">Experimentation</p><h1 className="mt-1 text-3xl font-semibold text-ink">A/B tests</h1></div></div>
        </div>
        <Button variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={15} aria-hidden="true" /> Refresh</Button>
      </div>

      {error ? <div className="rounded-lg border border-coral/40 bg-coral/10 p-5 text-sm text-coral" role="alert">{error}</div> : null}
      {loading ? <div className="h-64 animate-pulse rounded-lg border border-line bg-panel" aria-label="Loading A/B tests" /> : groups.length === 0 ? <div className="rounded-lg border border-dashed border-line bg-panel/50 p-10 text-center"><Beaker size={24} className="mx-auto text-muted" aria-hidden="true" /><h2 className="mt-4 text-base font-semibold text-ink">No active experiments</h2></div> : <div className="space-y-5">{groups.map(group => <ABTestComparison key={group.variantGroup} group={group} onPromote={promote} promoting={promoting === group.variantGroup} />)}</div>}
    </div>
  );
}
