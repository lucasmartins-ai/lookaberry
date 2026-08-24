'use client';

import { Filter, X } from 'lucide-react';
import type { FilterState } from '@/lib/types';
import { Button } from '@/components/ui/button';

interface FilterBarProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

const CHANNELS = ['EMAIL', 'LINKEDIN_MESSAGE', 'LINKEDIN_INMAIL', 'WHATSAPP'];
const STATUSES = ['QUEUED', 'SCHEDULED', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED', 'FAILED'];

export function FilterBar({ filters, onChange }: FilterBarProps) {
  const activeCount = [
    filters.channel ? 1 : 0,
    filters.status ? 1 : 0,
    filters.variant ? 1 : 0,
    filters.periodStart || filters.periodEnd ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  const clearAll = () => onChange({ channel: '', status: '', variant: '', periodStart: '', periodEnd: '' });

  const set = (key: keyof FilterState, value: string) =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap" role="search" aria-label="Dashboard filters">
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
        <Filter size={13} aria-hidden="true" />
        Filters
        {activeCount > 0 ? (
          <span className="ml-0.5 grid h-4 min-w-[1rem] place-items-center rounded-full bg-mint px-1 text-[10px] tabular-nums text-canvas">
            {activeCount}
          </span>
        ) : null}
      </span>

      {/* Channel */}
      <select
        value={filters.channel}
        onChange={e => set('channel', e.target.value)}
        className="h-8 rounded-md border border-line bg-elevated px-2 text-xs text-muted focus:border-mint focus:outline-none"
        aria-label="Filter by channel"
      >
        <option value="">All channels</option>
        {CHANNELS.map(c => (
          <option key={c} value={c}>{c.replaceAll('_', ' ')}</option>
        ))}
      </select>

      {/* Status */}
      <select
        value={filters.status}
        onChange={e => set('status', e.target.value)}
        className="h-8 rounded-md border border-line bg-elevated px-2 text-xs text-muted focus:border-mint focus:outline-none"
        aria-label="Filter by status"
      >
        <option value="">All statuses</option>
        {STATUSES.map(s => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      {/* Period */}
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={filters.periodStart}
          onChange={e => set('periodStart', e.target.value)}
          className="h-8 w-32 rounded-md border border-line bg-elevated px-2 text-xs text-muted focus:border-mint focus:outline-none"
          aria-label="Period start date"
        />
        <span className="text-xs text-muted">–</span>
        <input
          type="date"
          value={filters.periodEnd}
          onChange={e => set('periodEnd', e.target.value)}
          className="h-8 w-32 rounded-md border border-line bg-elevated px-2 text-xs text-muted focus:border-mint focus:outline-none"
          aria-label="Period end date"
        />
      </div>

      {/* Variant */}
      <input
        type="text"
        value={filters.variant}
        onChange={e => set('variant', e.target.value)}
        placeholder="Variant group..."
        className="h-8 w-32 rounded-md border border-line bg-elevated px-2 text-xs text-muted placeholder:text-muted/50 focus:border-mint focus:outline-none"
        aria-label="Filter by variant group"
      />

      {activeCount > 0 ? (
        <Button variant="ghost" size="sm" onClick={clearAll} className="text-xs text-muted hover:text-coral">
          <X size={13} className="mr-1" aria-hidden="true" />
          Clear
        </Button>
      ) : null}
    </div>
  );
}