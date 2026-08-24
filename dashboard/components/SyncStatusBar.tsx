'use client';

import { AlertTriangle, CheckCircle, Wifi, WifiOff } from 'lucide-react';
import type { SyncHealth } from '@/lib/types';

interface SyncStatusBarProps {
  syncHealth: SyncHealth | null;
  error: string | null;
  isLoading: boolean;
  lastRefreshedAt: Date | null;
}

function formatRelative(date: string | null | undefined): string {
  if (!date) return 'Never';
  const diff = Date.now() - new Date(date).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function SyncStatusBar({ syncHealth, error, isLoading, lastRefreshedAt }: SyncStatusBarProps) {
  const hasError = error !== null;
  const offline = syncHealth === null && !isLoading && error !== null;
  const lastSync = syncHealth?.last_sync_at ?? null;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-elevated/40 px-4 py-2 text-xs"
      role="status"
      aria-live="polite"
    >
      {isLoading ? (
        <span className="flex items-center gap-1.5 text-muted">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber" />
          Syncing...
        </span>
      ) : offline ? (
        <span className="flex items-center gap-1.5 text-coral">
          <WifiOff size={13} aria-hidden="true" />
          Offline — API unreachable
        </span>
      ) : hasError ? (
        <span className="flex items-center gap-1.5 text-amber">
          <AlertTriangle size={13} aria-hidden="true" />
          {error}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-mint">
          <CheckCircle size={13} aria-hidden="true" />
          Connected
        </span>
      )}

      {lastSync && !offline ? (
        <span className="flex items-center gap-1.5 text-muted">
          <Wifi size={13} aria-hidden="true" />
          Last sync: {formatRelative(lastSync)}
        </span>
      ) : null}

      {lastRefreshedAt ? (
        <span className="text-muted">Refreshed {formatRelative(lastRefreshedAt.toISOString())}</span>
      ) : null}
    </div>
  );
}