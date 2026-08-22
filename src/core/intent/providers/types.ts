import type { EvidenceClassification, SanitizedJson } from '../../evidence/types.js';

export type ProviderStatus =
  | 'IMPLEMENTED'
  | 'PARTIALLY_IMPLEMENTED'
  | 'REQUIRES_CREDENTIALS'
  | 'NOT_AVAILABLE'
  | 'FALLBACK'
  | 'FAILED'
  | 'TIMEOUT';

export interface ProviderAvailability {
  status: ProviderStatus;
  reason?: string;
}

export interface JobPostingInput {
  title: string;
  url?: string;
  description?: string;
  department?: string;
  published_at?: Date | string;
  metadata?: unknown;
}

export interface AnnouncementInput {
  title: string;
  url?: string;
  summary?: string;
  kind?: string;
  published_at?: Date | string;
  metadata?: unknown;
}

export interface SignalCollectionInput {
  company_domain: string;
  company_name: string;
  company_industry?: string;
  company_description?: string;
  company_tech_stack?: string[];
  company_website_url?: string;
  website_url?: string;
  website_content?: string;
  website_html?: string;
  previous_website_content?: string;
  previous_website_html?: string;
  website_changed?: boolean;
  hiring_url?: string;
  hiring_html?: string;
  job_postings?: JobPostingInput[];
  announcements_url?: string;
  announcements_html?: string;
  announcement_items?: AnnouncementInput[];
  metadata?: unknown;
}

export interface RawSignal {
  providerId: string;
  companyDomain: string;
  companyName: string;
  companyIndustry?: string;
  companyDescription?: string;
  companyTechStack?: string[];
  signalType: string;
  source: string;
  sourceUrl?: string;
  title: string;
  summary: string;
  observedAt?: Date;
  ttlDays?: number;
  confidence?: number;
  sourceQuality?: number;
  intentWeight?: number;
  evidenceClassification?: EvidenceClassification;
  normalizedData?: unknown;
  rawData: unknown;
  metadata?: unknown;
  cost?: number;
  deduplicationKey?: string;
}

export interface NormalizedSignal {
  providerId: string;
  companyDomain: string;
  companyName: string;
  companyIndustry?: string;
  companyDescription?: string;
  companyTechStack?: string[];
  signalType: string;
  source: string;
  sourceUrl?: string;
  title: string;
  summary: string;
  observedAt: Date;
  expiresAt: Date;
  ttlDays: number;
  confidence: number;
  sourceQuality: number;
  intentWeight: number;
  evidenceClassification: EvidenceClassification;
  normalizedData: SanitizedJson;
  rawData: SanitizedJson;
  metadata: SanitizedJson;
  cost: number;
  contentHash: string;
  deduplicationKey: string;
}

export interface SignalProvider {
  id: string;
  type: string;
  source: string;
  cost: number;
  ttlDays: number;
  getAvailability(input: SignalCollectionInput): ProviderAvailability;
  collect(input: SignalCollectionInput): Promise<RawSignal[]>;
  normalize(signal: RawSignal): NormalizedSignal[];
}

export class SignalProviderError extends Error {
  constructor(
    public readonly status: Exclude<ProviderStatus, 'IMPLEMENTED' | 'PARTIALLY_IMPLEMENTED'>,
    message: string,
  ) {
    super(message);
    this.name = 'SignalProviderError';
  }
}

export interface ProviderRunResult {
  providerId: string;
  providerType: string;
  status: ProviderStatus;
  rawSignalCount: number;
  signals: NormalizedSignal[];
  cost: number;
  errors: string[];
}
