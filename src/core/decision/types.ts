import type { EvidenceClassification } from '../evidence/types.js';
import type { ChannelCapability, ChannelId } from '../channels/types.js';

export type Urgency = 'HIGH' | 'MEDIUM' | 'LOW';

export type TimingWindow = 'IMMEDIATE' | 'WITHIN_24H' | 'WITHIN_WEEK';

export interface DecisionFactor {
  /** Human-readable name of the factor (e.g. "Recent Hiring Activity") */
  name: string;
  /** Contribution to the total opportunity score, 0–100 */
  contribution: number;
  /** Evidence URL or supporting statement */
  evidence: string;
  /** Classification of the supporting evidence */
  evidenceClassification: EvidenceClassification;
}

export interface RecommendedAction {
  /** Communication channel */
  channel: ChannelId;
  /** Capability required by this action */
  capability: ChannelCapability;
  /** When to execute */
  timing: TimingWindow;
  /** Actionable prompt describing what to send or do */
  template: string;
  /** Business rationale backing the action */
  rationale: string;
}

export interface OpportunityScore {
  /** Lead ID, if the opportunity is lead-specific; undefined for company-level evaluation */
  leadId?: string;
  /** Company ID */
  companyId: string;
  /** Company name for display purposes */
  companyName: string;
  /** Overall opportunity score 0–100 */
  score: number;
  /** Urgency classification */
  urgency: Urgency;
  /** Top contributing factors, sorted by contribution descending */
  topFactors: DecisionFactor[];
  /** Concise sentences explaining why the prospect should be contacted now */
  whyNow: string[];
  /** Ranked actions the agent should take */
  recommendedActions: RecommendedAction[];
  /** Summary of the signal landscape used for scoring */
  signalSummary: {
    activeSignalCount: number;
    duplicateSignalCount: number;
    topSignalTypes: string[];
    latestSignalAgeHours: number;
    evidenceStrength: number;
  };
  /** ICP fit score 0–1 based on vector similarity or explicit icpFitScore */
  icpFit: number;
}

export interface DecisionContext {
  /** Lead ID, optional for company-level evaluation */
  leadId?: string;
  /** Company ID */
  companyId: string;
  /** Company name */
  companyName: string;
  /** ICP fit score 0–1 */
  icpFit: number;
  /** Lead title, if available */
  leadTitle?: string;
  /** Lead seniority, if available */
  leadSeniority?: string;
  /** Active intent signals */
  signals: NormalizedDecisionSignal[];
  /** Evidence items associated with the company */
  evidence: DecisionEvidence[];
}

export interface NormalizedDecisionSignal {
  signalId: string;
  signalType: string;
  source: string;
  title: string;
  summary: string;
  observedAt: Date;
  expiresAt: Date;
  isActive: boolean;
  intentWeight: number;
  confidence: number;
  sourceQuality: number;
  evidenceClassification: EvidenceClassification;
  deduplicationKey?: string | null;
}

export interface DecisionEvidence {
  evidenceId: string;
  evidenceType: string;
  classification: EvidenceClassification;
  sourceUrl?: string | null;
  observedAt: Date;
  confidence: number;
}

export interface EvaluateOpportunityInput {
  icp_id: string;
  lead_id?: string;
  company_id?: string;
  min_weight?: number;
}

export interface EvaluateOpportunityOutput {
  evaluated: OpportunityScore[];
  evaluated_at: string;
  total_candidates: number;
}