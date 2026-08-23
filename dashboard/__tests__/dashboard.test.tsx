import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DashboardOverview } from '@/components/DashboardOverview';
import { CampaignDetailClient } from '@/components/CampaignDetailClient';
import { ABTestsClient } from '@/components/ABTestsClient';
import { SystemHealthClient } from '@/components/SystemHealthClient';
import { CadenceGauge } from '@/components/CadenceGauge';
import { ABTestComparison } from '@/components/ABTestComparison';

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
  variants: [
    { stepId: 'step-a', stepIndex: 0, body: 'A', impressions: 100, opens: 40, replies: 8, clicks: 10, variantWeight: 1, active: true, isWinner: true },
    { stepId: 'step-b', stepIndex: 1, body: 'B', impressions: 100, opens: 28, replies: 4, clicks: 6, variantWeight: 1, active: true },
  ],
}];

const cadence = {
  channelSlots: { email: { available: true, used: 12, limit: 20 } },
  globalSlots: { available: true, usedPerMinute: 20, usedPerHour: 180, limitPerMinute: 60, limitPerHour: 1000 },
  nextAvailableMs: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('dashboard components', () => {
  it('renders campaign analytics fetched from the API', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.endsWith('/api/v1/campaigns')) return Promise.resolve(new Response(JSON.stringify([campaign]), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(analytics), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DashboardOverview />);

    expect(await screen.findByText('Enterprise Pilot')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/campaigns'), expect.any(Object));
  });

  it('renders detail analytics and recent messages from the API', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes('/messages')) return Promise.resolve(new Response(JSON.stringify(messages), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(analytics), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CampaignDetailClient campaignId="campaign-1" />);

    expect(await screen.findByText('Alice Johnson')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Enterprise Pilot' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/campaigns/campaign-1/analytics'), expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/campaigns/campaign-1/messages'), expect.any(Object));
  });

  it('loads A/B groups and promotes the selected winner through the API', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ promoted: true }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(abGroups), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ABTestsClient campaignId="campaign-1" />);

    expect(await screen.findByText('subject-line')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /promote winner/i }));
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
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/health/cadence'), expect.any(Object));
  });

  it('shows a bounded cadence utilization gauge', () => {
    render(<CadenceGauge label="Global / minute" used={45} limit={60} />);

    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');
  });

  it('calls the promotion handler for an A/B winner', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    render(
      <ABTestComparison
        group={{
          variantGroup: 'subject-line',
          totalImpressions: 200,
          hasWinner: true,
          variants: [
            { stepId: 'step-a', stepIndex: 0, body: 'A', impressions: 100, opens: 40, replies: 8, clicks: 10, variantWeight: 1, active: true, isWinner: true },
            { stepId: 'step-b', stepIndex: 1, body: 'B', impressions: 100, opens: 28, replies: 4, clicks: 6, variantWeight: 1, active: true },
          ],
        }}
        onPromote={onPromote}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /promote winner/i }));
    await waitFor(() => expect(onPromote).toHaveBeenCalledWith('subject-line', 'step-a'));
  });
});
