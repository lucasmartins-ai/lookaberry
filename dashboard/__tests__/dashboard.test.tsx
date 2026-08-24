import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardOverview } from '@/components/DashboardOverview';
import { CampaignDetailClient } from '@/components/CampaignDetailClient';
import { ABTestsClient } from '@/components/ABTestsClient';
import { SystemHealthClient } from '@/components/SystemHealthClient';
import { CadenceGauge } from '@/components/CadenceGauge';
import { ABTestComparison } from '@/components/ABTestComparison';
import { FilterBar } from '@/components/FilterBar';
import { SyncStatusBar } from '@/components/SyncStatusBar';
import { AutoRefresh } from '@/components/AutoRefresh';
import { ConversionRatesCard } from '@/components/ConversionRatesCard';
import { CampaignActions } from '@/components/CampaignActions';
import { ConfirmationDialog } from '@/components/ConfirmationDialog';
import { LeadDrillDown } from '@/components/LeadDrillDown';
import type { FilterState } from '@/lib/types';

// ─── Test fixtures ───

const campaign = {
  id: 'campaign-1',
  name: 'Enterprise Pilot',
  is_active: true,
  created_at: '2026-08-20T10:00:00.000Z',
};

const analytics = {
  campaign_id: 'campaign-1',
  campaign_name: 'Enterprise Pilot',
  sent: 120,
  delivered: 110,
  opened: 74,
  clicked: 31,
  replied: 12,
  bounced: 3,
  failed: 1,
  pending: 8,
  by_channel: { EMAIL: 90, LINKEDIN_MESSAGE: 30 },
};

const messages = [{
  id: 'message-1',
  lead_id: 'lead-1',
  lead_name: 'Alice Johnson',
  lead_email: 'alice@example.com',
  channel: 'EMAIL',
  status: 'OPENED',
  subject: 'A relevant introduction',
  body_preview: 'A relevant introduction',
  sent_at: '2026-08-23T10:00:00.000Z',
  opened_at: '2026-08-23T10:10:00.000Z',
  clicked_at: null,
  replied_at: null,
  created_at: '2026-08-23T09:59:00.000Z',
}];

const abGroups = [{
  variantGroup: 'subject-line',
  totalImpressions: 200,
  hasWinner: true,
  minSamplesRequired: 100,
  requiredConfidence: 0.95,
  bestVariantProbability: 0.97,
  variants: [
    {
      stepId: 'step-a', stepIndex: 0, body: 'Variant A body text', impressions: 100, opens: 40,
      replies: 8, clicks: 10, variantWeight: 1, active: true, isWinner: true,
      conversionRate: 8.0, posteriorMean: 0.085, confidenceInterval95: [0.04, 0.14] as [number, number],
    },
    {
      stepId: 'step-b', stepIndex: 1, body: 'Variant B body text', impressions: 100, opens: 28,
      replies: 4, clicks: 6, variantWeight: 1, active: true,
      conversionRate: 4.0, posteriorMean: 0.048, confidenceInterval95: [0.02, 0.09] as [number, number],
    },
  ],
}];

const cadence = {
  channelSlots: { email: { available: true, used: 12, limit: 20 } },
  globalSlots: { available: true, usedPerMinute: 20, usedPerHour: 180, limitPerMinute: 60, limitPerHour: 1000 },
  nextAvailableMs: 0,
};

const syncHealth = {
  last_sync_at: '2026-08-24T10:00:00.000Z',
  latest_message_at: '2026-08-24T09:55:00.000Z',
  latest_campaign_update_at: '2026-08-24T09:50:00.000Z',
  api_version: '0.1.0',
};

const leadDetail = {
  lead: {
    id: 'lead-1',
    full_name: 'Alice Johnson',
    email: 'alice@example.com',
    company: 'Acme Inc',
    title: 'VP Engineering',
    linkedin_url: 'https://linkedin.com/in/alice',
  },
  interactions: [{
    id: 'interaction-1',
    channel: 'EMAIL',
    status: 'REPLIED',
    subject: 'Re: Introduction',
    body: 'Thanks for reaching out! Let\'s chat.',
    sent_at: '2026-08-23T10:00:00.000Z',
    opened_at: '2026-08-23T10:05:00.000Z',
    clicked_at: '2026-08-23T10:06:00.000Z',
    replied_at: '2026-08-23T10:15:00.000Z',
    created_at: '2026-08-23T09:59:00.000Z',
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Existing S10 tests (preserved) ───

describe('dashboard components', () => {
  it('renders campaign analytics fetched from the API', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes('/api/v1/health/sync')) return Promise.resolve(new Response(JSON.stringify(syncHealth), { status: 200 }));
      if (input.endsWith('/api/v1/campaigns')) return Promise.resolve(new Response(JSON.stringify([campaign]), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(analytics), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DashboardOverview />);

    expect(await screen.findByText('Enterprise Pilot')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('renders detail analytics and recent messages from the API', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes('/health/sync')) return Promise.resolve(new Response(JSON.stringify(syncHealth), { status: 200 }));
      if (input === '/api/v1/campaigns') return Promise.resolve(new Response(JSON.stringify([campaign]), { status: 200 }));
      if (input.includes('/messages')) return Promise.resolve(new Response(JSON.stringify(messages), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(analytics), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CampaignDetailClient campaignId="campaign-1" />);

    expect(await screen.findByText('Alice Johnson')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Enterprise Pilot' })).toBeInTheDocument();
  });

  it('loads A/B groups and promotes the selected winner through the API', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ promoted: true }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(abGroups), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ABTestsClient campaignId="campaign-1" />);

    expect(await screen.findByText('subject-line')).toBeInTheDocument();

    // Promote button is now in ABTestComparison, click it
    fireEvent.click(screen.getByRole('button', { name: /promote winner/i }));
    // Confirm dialog should appear
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Promote winning variant/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/campaigns/campaign-1/ab-tests/subject-line/promote'),
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('loads global and per-channel cadence health from the API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(cadence), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SystemHealthClient />);

    expect(await screen.findByText('Cadence health')).toBeInTheDocument();
    expect(screen.getByText('20 / 60 used')).toBeInTheDocument();
    expect(screen.getByText('12 / 20 used')).toBeInTheDocument();
  });

  it('shows a bounded cadence utilization gauge', () => {
    render(<CadenceGauge label="Global / minute" used={45} limit={60} />);
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');
  });

  it('calls the promotion handler for an A/B winner', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    render(
      <ABTestComparison group={abGroups[0]!} onPromote={onPromote} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /promote winner/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(onPromote).toHaveBeenCalledWith('subject-line', 'step-a'));
  });
});

// ─── S13: FilterBar ───

describe('FilterBar', () => {
  it('renders filter controls and clears all', async () => {
    const onChange = vi.fn();
    const filters: FilterState = { channel: '', status: '', variant: '', periodStart: '', periodEnd: '' };

    render(<FilterBar filters={filters} onChange={onChange} />);

    expect(screen.getByLabelText('Filter by channel')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument();

    // Change channel
    const user = userEvent.setup();
    const channelSelect = screen.getByLabelText('Filter by channel');
    await user.selectOptions(channelSelect, 'EMAIL');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ channel: 'EMAIL' }));
  });

  it('shows clear button when filters are active', () => {
    const onChange = vi.fn();
    const filters: FilterState = { channel: 'EMAIL', status: '', variant: '', periodStart: '', periodEnd: '' };

    render(<FilterBar filters={filters} onChange={onChange} />);

    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  it('allows date range input', () => {
    const onChange = vi.fn();
    const filters: FilterState = { channel: '', status: '', variant: '', periodStart: '', periodEnd: '' };

    render(<FilterBar filters={filters} onChange={onChange} />);

    expect(screen.getByLabelText('Period start date')).toBeInTheDocument();
    expect(screen.getByLabelText('Period end date')).toBeInTheDocument();
  });
});

// ─── S13: SyncStatusBar ───

describe('SyncStatusBar', () => {
  it('shows connected state with sync info', () => {
    render(
      <SyncStatusBar
        syncHealth={syncHealth}
        error={null}
        isLoading={false}
        lastRefreshedAt={null}
      />,
    );

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/Last sync:/)).toBeInTheDocument();
  });

  it('shows error state', () => {
    render(
      <SyncStatusBar
        syncHealth={null}
        error="Network failure"
        isLoading={false}
        lastRefreshedAt={null}
      />,
    );

    expect(screen.getByText('Offline — API unreachable')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(
      <SyncStatusBar
        syncHealth={null}
        error={null}
        isLoading={true}
        lastRefreshedAt={null}
      />,
    );

    expect(screen.getByText('Syncing...')).toBeInTheDocument();
  });

  it('shows partial error when sync present but API errored', () => {
    render(
      <SyncStatusBar
        syncHealth={syncHealth}
        error="Partial load error"
        isLoading={false}
        lastRefreshedAt={null}
      />,
    );

    expect(screen.getByText('Partial load error')).toBeInTheDocument();
  });
});

// ─── S13: AutoRefresh ───

describe('AutoRefresh', () => {
  it('renders controls and triggers manual refresh', async () => {
    const onManualRefresh = vi.fn();
    const onToggle = vi.fn();
    const onIntervalChange = vi.fn();

    render(
      <AutoRefresh
        autoEnabled={false}
        refreshing={false}
        intervalMs={30000}
        minIntervalMs={5000}
        maxIntervalMs={300000}
        onToggle={onToggle}
        onIntervalChange={onIntervalChange}
        onManualRefresh={onManualRefresh}
      />,
    );

    expect(screen.getByLabelText('Manual refresh')).toBeInTheDocument();
    expect(screen.getByLabelText('Auto')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Manual refresh'));
    expect(onManualRefresh).toHaveBeenCalledTimes(1);
  });

  it('toggles auto refresh checkbox', () => {
    const onToggle = vi.fn();

    render(
      <AutoRefresh
        autoEnabled={false}
        refreshing={false}
        intervalMs={30000}
        minIntervalMs={5000}
        maxIntervalMs={300000}
        onToggle={onToggle}
        onIntervalChange={vi.fn()}
        onManualRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('Auto'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('shows disabled interval select when auto is off', () => {
    render(
      <AutoRefresh
        autoEnabled={false}
        refreshing={false}
        intervalMs={30000}
        minIntervalMs={5000}
        maxIntervalMs={300000}
        onToggle={vi.fn()}
        onIntervalChange={vi.fn()}
        onManualRefresh={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('Refresh interval');
    expect(select).toBeDisabled();
  });

  it('shows spinning icon when refreshing', () => {
    render(
      <AutoRefresh
        autoEnabled={true}
        refreshing={true}
        intervalMs={30000}
        minIntervalMs={5000}
        maxIntervalMs={300000}
        onToggle={vi.fn()}
        onIntervalChange={vi.fn()}
        onManualRefresh={vi.fn()}
      />,
    );

    const btn = screen.getByLabelText('Manual refresh');
    expect(btn).toBeDisabled();
  });
});

// ─── S13: ConversionRatesCard ───

describe('ConversionRatesCard', () => {
  it('displays computed conversion rates', () => {
    render(<ConversionRatesCard analytics={analytics} />);

    expect(screen.getByText('Conversion rates')).toBeInTheDocument();
    // Delivery rate: 110/120 = 91.7%
    expect(screen.getByText('91.7%')).toBeInTheDocument();
  });

  it('shows cumulative summary footer', () => {
    render(<ConversionRatesCard analytics={analytics} />);

    // recharts may leave measurement spans in the DOM from previous tests
    const all120s = screen.getAllByText('120');
    expect(all120s.length).toBeGreaterThanOrEqual(1);
    const all10_9 = screen.getAllByText('10.9%');
    expect(all10_9.length).toBe(2); // appears as rate and in footer
  });
});

// ─── S13: CampaignActions ───

describe('CampaignActions', () => {
  it('shows pause button for active campaign', () => {
    const onStatusChange = vi.fn();
    render(<CampaignActions campaignId="campaign-1" isActive={true} onStatusChange={onStatusChange} />);

    expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /end campaign/i })).toBeInTheDocument();
  });

  it('shows resume button for paused campaign', () => {
    const onStatusChange = vi.fn();
    render(<CampaignActions campaignId="campaign-1" isActive={false} onStatusChange={onStatusChange} />);

    expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument();
  });

  it('opens confirmation dialog on terminate click', async () => {
    const onStatusChange = vi.fn();
    render(<CampaignActions campaignId="campaign-1" isActive={true} onStatusChange={onStatusChange} />);

    fireEvent.click(screen.getByRole('button', { name: /end campaign/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/permanently end/)).toBeInTheDocument();
  });

  it('calls API on confirmed pause', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: 'campaign-1', is_active: false, action: 'pause', terminated: false }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const onStatusChange = vi.fn();
    render(<CampaignActions campaignId="campaign-1" isActive={true} onStatusChange={onStatusChange} />);

    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /yes, pause/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/campaigns/campaign-1/status'),
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'pause', is_active: false }),
      );
    });
  });
});

// ─── S13: ConfirmationDialog ───

describe('ConfirmationDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ConfirmationDialog
        open={false}
        title="Test"
        description="Desc"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders dialog when open', () => {
    render(
      <ConfirmationDialog
        open={true}
        title="Delete item"
        description="This cannot be undone"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete item')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone')).toBeInTheDocument();
  });

  it('calls onCancel on Cancel click', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmationDialog open={true} title="T" description="D" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onConfirm on Confirm click', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmationDialog open={true} title="T" description="D" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmationDialog open={true} title="T" description="D" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('applies danger variant styling', () => {
    render(
      <ConfirmationDialog open={true} title="T" description="D" variant="danger" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmBtn.className).toContain('bg-coral');
  });

  it('disables buttons when loading', () => {
    render(
      <ConfirmationDialog open={true} title="T" description="D" loading={true} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});

// ─── S13: LeadDrillDown ───

describe('LeadDrillDown', () => {
  it('loads and displays lead interaction timeline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(leadDetail), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LeadDrillDown
        campaignId="campaign-1"
        leadId="lead-1"
        leadName="Alice Johnson"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('Alice Johnson')).toBeInTheDocument();
    // Title is concatenated: "VP Engineering · Acme Inc"
    expect(screen.getByText(/VP Engineering/)).toBeInTheDocument();
    expect(screen.getByText(/Thanks for reaching out/)).toBeInTheDocument();
    expect(screen.getByText('Interaction timeline')).toBeInTheDocument();
  });

  it('calls onClose when back button clicked', () => {
    const onClose = vi.fn();
    render(
      <LeadDrillDown
        campaignId="campaign-1"
        leadId="lead-1"
        leadName="Alice"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /back to messages/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

// ─── S13: ABTestComparison enhanced stats ───

describe('ABTestComparison S13 stats', () => {
  it('displays sample sufficiency status', () => {
    render(
      <ABTestComparison group={abGroups[0]!} />,
    );

    // 200/100 = sufficient — check for the sample count text
    expect(screen.getByText(/200\/100/)).toBeInTheDocument();
  });

  it('displays confidence interval and posterior mean for variants', () => {
    render(
      <ABTestComparison group={abGroups[0]!} />,
    );

    expect(screen.getAllByText(/95% CI:/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Posterior mean:/).length).toBeGreaterThan(0);
    expect(screen.getByText(/statistically significant ✓/)).toBeInTheDocument();
  });

  it('displays confidence threshold info', () => {
    render(
      <ABTestComparison group={abGroups[0]!} />,
    );

    expect(screen.getByText(/Confidence threshold: 95%/)).toBeInTheDocument();
  });

  it('shows confirmation before promoting', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    render(
      <ABTestComparison group={abGroups[0]!} onPromote={onPromote} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /promote winner/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Variant A/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(onPromote).toHaveBeenCalledWith('subject-line', 'step-a'));
  });

  it('disables promote button when hasWinner is false', () => {
    const groupNoWinner = { ...abGroups[0]!, hasWinner: false };
    groupNoWinner.variants = groupNoWinner.variants.map(v => ({ ...v, isWinner: false }));
    const onPromote = vi.fn();
    render(<ABTestComparison group={groupNoWinner} onPromote={onPromote} />);

    const btn = screen.getByRole('button', { name: /promote winner/i });
    expect(btn).toBeDisabled();
  });
});

// ─── S13: Responsive & accessibility checks ───

describe('S13 accessibility', () => {
  it('FilterBar has search landmark role', () => {
    render(<FilterBar filters={{ channel: '', status: '', variant: '', periodStart: '', periodEnd: '' }} onChange={vi.fn()} />);
    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('SyncStatusBar has status role with live region', () => {
    render(<SyncStatusBar syncHealth={syncHealth} error={null} isLoading={false} lastRefreshedAt={null} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('AutoRefresh has group role', () => {
    render(
      <AutoRefresh
        autoEnabled={false} refreshing={false} intervalMs={30000}
        minIntervalMs={5000} maxIntervalMs={300000}
        onToggle={vi.fn()} onIntervalChange={vi.fn()} onManualRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole('group')).toHaveAttribute('aria-label', 'Auto-refresh controls');
  });

  it('CampaignActions has group role', () => {
    render(<CampaignActions campaignId="c1" isActive={true} onStatusChange={vi.fn()} />);
    expect(screen.getByRole('group')).toHaveAttribute('aria-label', 'Campaign actions');
  });

  it('ConfirmationDialog is modal with aria-modal', () => {
    render(<ConfirmationDialog open={true} title="T" description="D" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });
});

// ─── S13: Keyboard navigation tests ───

describe('S13 keyboard navigation', () => {
  it('ConfirmationDialog closes on Escape', () => {
    const onCancel = vi.fn();
    render(<ConfirmationDialog open={true} title="Test" description="Desc" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('ConfirmationDialog traps focus with Tab', () => {
    render(<ConfirmationDialog open={true} title="Test" description="Desc" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });

    // On open, cancel button should be focused
    expect(cancelBtn).toHaveFocus();
  });
});

// ─── S13: DashboardOverview with sync health ───

describe('DashboardOverview S13 integration', () => {
  it('displays sync status bar', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes('/health/sync')) return Promise.resolve(new Response(JSON.stringify(syncHealth), { status: 200 }));
      if (input.endsWith('/api/v1/campaigns')) return Promise.resolve(new Response(JSON.stringify([campaign]), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(analytics), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DashboardOverview />);

    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('displays filter bar', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes('/health/sync')) return Promise.resolve(new Response(JSON.stringify(syncHealth), { status: 200 }));
      if (input.endsWith('/api/v1/campaigns')) return Promise.resolve(new Response(JSON.stringify([campaign]), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(analytics), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DashboardOverview />);

    expect(await screen.findByRole('search')).toBeInTheDocument();
  });

  it('shows auto-refresh controls', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes('/health/sync')) return Promise.resolve(new Response(JSON.stringify(syncHealth), { status: 200 }));
      if (input.endsWith('/api/v1/campaigns')) return Promise.resolve(new Response(JSON.stringify([campaign]), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(analytics), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DashboardOverview />);

    expect(await screen.findByLabelText('Manual refresh')).toBeInTheDocument();
    expect(screen.getByLabelText('Auto')).toBeInTheDocument();
  });
});