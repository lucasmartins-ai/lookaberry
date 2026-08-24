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

export interface LeadInteraction {
  id: string;
  channel: string;
  status: string;
  subject: string | null;
  body: string;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  replied_at: string | null;
  created_at: string;
}

export interface LeadDetail {
  lead: {
    id: string;
    full_name: string;
    email: string | null;
    company: string | null;
    title: string | null;
    linkedin_url: string | null;
  };
  interactions: LeadInteraction[];
}

export interface CampaignMessage {
  id: string;
  lead_id?: string;
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
  conversionRate: number;
  posteriorMean: number;
  confidenceInterval95: [number, number];
}

export interface ABTestGroup {
  variantGroup: string;
  variants: ABVariant[];
  totalImpressions: number;
  hasWinner: boolean;
  minSamplesRequired: number;
  requiredConfidence: number;
  bestVariantProbability: number | null;
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

export interface SyncHealth {
  last_sync_at: string | null;
  latest_message_at: string | null;
  latest_campaign_update_at: string | null;
  api_version: string;
  error?: string;
}

export interface FilterState {
  channel: string;
  status: string;
  variant: string;
  periodStart: string;
  periodEnd: string;
}

export interface CampaignActionResponse {
  id: string;
  is_active: boolean;
  action: 'pause' | 'resume' | 'terminate';
  terminated: boolean;
}

export interface ConversionRates {
  deliveryRate: number;
  openRate: number;
  clickRate: number;
  replyRate: number;
  bounceRate: number;
}

export const funnelMetrics = [
  { key: 'sent', label: 'Sent', color: '#7dc6dc' },
  { key: 'delivered', label: 'Delivered', color: '#8de0bc' },
  { key: 'opened', label: 'Opened', color: '#f2bd72' },
  { key: 'clicked', label: 'Clicked', color: '#ed8e83' },
  { key: 'replied', label: 'Replied', color: '#c2a8ee' },
] as const;
