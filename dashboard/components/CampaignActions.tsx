'use client';

import { Pause, Play, StopCircle } from 'lucide-react';
import { useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { CampaignActionResponse } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ConfirmationDialog';

interface CampaignActionsProps {
  campaignId: string;
  isActive: boolean;
  onStatusChange: (newStatus: CampaignActionResponse) => void;
}

type Action = 'pause' | 'resume' | 'terminate';

export function CampaignActions({ campaignId, isActive, onStatusChange }: CampaignActionsProps) {
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [loading, setLoading] = useState(false);

  const execute = async (action: Action) => {
    setLoading(true);
    try {
      const result = await apiFetch<CampaignActionResponse>(`/api/v1/campaigns/${campaignId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      });
      onStatusChange(result);
    } catch {
      // Error handling is done at the parent level via refresh
    } finally {
      setLoading(false);
      setPendingAction(null);
    }
  };

  const dialogTitle =
    pendingAction === 'terminate' ? 'Terminate campaign'
    : pendingAction === 'pause' ? 'Pause campaign'
    : 'Resume campaign';

  const dialogDesc =
    pendingAction === 'terminate' ? 'This will permanently end the campaign and deactivate all pending messages. This action cannot be undone.'
    : pendingAction === 'pause' ? 'The campaign will stop sending new messages. You can resume it later.'
    : 'The campaign will resume sending messages according to its schedule.';

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Campaign actions">
        {isActive ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPendingAction('pause')}
            className="text-xs"
          >
            <Pause size={13} className="mr-1.5" aria-hidden="true" />
            Pause
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPendingAction('resume')}
            className="text-xs"
          >
            <Play size={13} className="mr-1.5" aria-hidden="true" />
            Resume
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPendingAction('terminate')}
          className="text-xs text-coral hover:text-coral hover:bg-coral/10"
        >
          <StopCircle size={13} className="mr-1.5" aria-hidden="true" />
          End campaign
        </Button>
      </div>

      <ConfirmationDialog
        open={pendingAction !== null}
        title={dialogTitle}
        description={dialogDesc}
        confirmLabel={pendingAction === 'terminate' ? 'Yes, end campaign' : `Yes, ${pendingAction}`}
        variant={pendingAction === 'terminate' ? 'danger' : 'safe'}
        loading={loading}
        onConfirm={() => { if (pendingAction) void execute(pendingAction); }}
        onCancel={() => setPendingAction(null)}
      />
    </>
  );
}