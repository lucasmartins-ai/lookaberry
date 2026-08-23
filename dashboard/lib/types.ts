export interface Campaign {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
}

export interface CampaignAnalytics {
  campaign_id: string;
  campaign_name: string | null;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  failed: number;
  pending: number;
  by_channel: Record<string, number>;
}

export interface CampaignMessage {
  id: string;
  lead_name: string;
  lead_email: string | null;
  channel: string;
  status: string;
  subject: string | null;
  body_preview: string;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  replied_at: string | null;
  created_at: string;
}

export interface ABVariant {
  stepId: string;
  stepIndex: number;
  body: string;
  impressions: number;
  opens: number;
  replies: number;
  clicks: number;
  variantWeight: number;
  active: boolean;
  isWinner?: boolean;
}

export interface ABTestGroup {
  variantGroup: string;
  variants: ABVariant[];
  totalImpressions: number;
  hasWinner: boolean;
}

export interface CadenceChannelSlot {
  available: boolean;
  used: number;
  limit: number;
}

export interface CadenceState {
  channelSlots: Record<string, CadenceChannelSlot>;
  globalSlots: {
    available: boolean;
    usedPerMinute: number;
    usedPerHour: number;
    limitPerMinute: number;
    limitPerHour: number;
  };
  nextAvailableMs: number;
}

export const funnelMetrics = [
  { key: 'sent', label: 'Sent', color: '#7dc6dc' },
  { key: 'delivered', label: 'Delivered', color: '#8de0bc' },
  { key: 'opened', label: 'Opened', color: '#f2bd72' },
  { key: 'clicked', label: 'Clicked', color: '#ed8e83' },
  { key: 'replied', label: 'Replied', color: '#c2a8ee' },
] as const;
