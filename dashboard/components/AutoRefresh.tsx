'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface AutoRefreshOptions {
  defaultIntervalMs?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  enabled?: boolean;
}

/**
 * S13: Configurable auto-refresh hook.
 * Returns refresh state and controls. The parent calls the onRefresh callback
 * on each interval tick, or when the user triggers a manual refresh.
 */
export function useAutoRefresh(onRefresh: () => void | Promise<void>, options: AutoRefreshOptions = {}) {
  const {
    defaultIntervalMs = 30_000,
    minIntervalMs = 5_000,
    maxIntervalMs = 300_000,
    enabled = false,
  } = options;

  const [intervalMs, setIntervalMs] = useState(defaultIntervalMs);
  const [autoEnabled, setAutoEnabled] = useState(enabled);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onRefreshRef.current();
      setLastRefreshedAt(new Date());
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!autoEnabled) return;
    const id = window.setInterval(() => { void doRefresh(); }, intervalMs);
    return () => window.clearInterval(id);
  }, [autoEnabled, intervalMs, doRefresh]);

  const changeInterval = useCallback((ms: number) => {
    setIntervalMs(Math.min(maxIntervalMs, Math.max(minIntervalMs, ms)));
  }, [minIntervalMs, maxIntervalMs]);

  return {
    intervalMs,
    autoEnabled,
    refreshing,
    lastRefreshedAt,
    setInterval: changeInterval,
    setAutoEnabled,
    doRefresh,
    minIntervalMs,
    maxIntervalMs,
  };
}

const PRESET_INTERVALS = [
  { label: '5s', ms: 5_000 },
  { label: '15s', ms: 15_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
];

interface AutoRefreshProps {
  autoEnabled: boolean;
  refreshing: boolean;
  intervalMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  onToggle: (v: boolean) => void;
  onIntervalChange: (ms: number) => void;
  onManualRefresh: () => void;
}

export function AutoRefresh({
  autoEnabled,
  refreshing,
  intervalMs,
  onToggle,
  onIntervalChange,
  onManualRefresh,
}: AutoRefreshProps) {
  return (
    <div className="flex items-center gap-2 text-xs" role="group" aria-label="Auto-refresh controls">
      <button
        type="button"
        onClick={onManualRefresh}
        disabled={refreshing}
        className="grid h-8 w-8 place-items-center rounded-md bg-elevated text-muted hover:bg-line hover:text-ink disabled:opacity-50"
        aria-label="Manual refresh"
      >
        <svg
          className={refreshing ? 'animate-spin' : ''}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>

      <select
        value={intervalMs}
        onChange={e => onIntervalChange(Number(e.target.value))}
        className="h-8 rounded-md border border-line bg-elevated px-2 text-xs text-muted focus:border-mint focus:outline-none"
        aria-label="Refresh interval"
        disabled={!autoEnabled}
      >
        {PRESET_INTERVALS.map(p => (
          <option key={p.ms} value={p.ms}>{p.label}</option>
        ))}
      </select>

      <label className="flex items-center gap-1.5 text-muted">
        <input
          type="checkbox"
          checked={autoEnabled}
          onChange={e => onToggle(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-line bg-elevated accent-mint"
        />
        Auto
      </label>
    </div>
  );
}