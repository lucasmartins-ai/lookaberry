'use client';

import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { CadenceState } from '@/lib/types';
import { CadenceGauge } from '@/components/CadenceGauge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function channelLabel(channel: string) {
  return channel.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function SystemHealthClient() {
  const [state, setState] = useState<CadenceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setState(await apiFetch<CadenceState>('/api/v1/health/cadence'));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load cadence health');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <div className="space-y-7">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-mint">System monitor</p><h1 className="mt-2 text-3xl font-semibold text-ink sm:text-4xl">Cadence health</h1></div>
        <Button variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={15} aria-hidden="true" /> Refresh</Button>
      </div>

      {error ? <div className="flex items-start gap-3 rounded-lg border border-coral/40 bg-coral/10 p-5 text-sm text-coral" role="alert"><AlertTriangle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />{error}</div> : null}
      {loading ? <div className="h-72 animate-pulse rounded-lg border border-line bg-panel" aria-label="Loading cadence health" /> : state ? <>
        <div className="grid gap-5 md:grid-cols-2">
          <Card><CardHeader><CardTitle>Global / minute</CardTitle></CardHeader><CardContent><CadenceGauge label="Messages per minute" used={state.globalSlots.usedPerMinute} limit={state.globalSlots.limitPerMinute} /></CardContent></Card>
          <Card><CardHeader><CardTitle>Global / hour</CardTitle></CardHeader><CardContent><CadenceGauge label="Messages per hour" used={state.globalSlots.usedPerHour} limit={state.globalSlots.limitPerHour} /></CardContent></Card>
        </div>
        <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Channel breakdown</CardTitle></div><Activity size={17} className={state.globalSlots.available ? 'text-mint' : 'text-coral'} aria-label={state.globalSlots.available ? 'Cadence available' : 'Cadence constrained'} /></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Object.entries(state.channelSlots).length === 0 ? <p className="text-sm text-muted">No channel activity in the current window.</p> : Object.entries(state.channelSlots).map(([channel, slot]) => <div key={channel} className="rounded-md border border-line bg-elevated/40 p-4"><CadenceGauge label={channelLabel(channel)} used={slot.used} limit={slot.limit} compact /><p className="mt-2 text-right text-xs text-muted">{slot.available ? 'Ready for next send' : 'At channel limit'}</p></div>)}</CardContent></Card>
        <p className="text-xs text-muted">Next global slot available in {Math.max(0, Math.ceil(state.nextAvailableMs / 1000))} seconds.</p>
      </> : null}
    </div>
  );
}
