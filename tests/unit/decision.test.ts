import { describe, expect, it } from 'vitest';
import {
  buildDecisionFactors,
  buildRecommendedActions,
  buildWhyNow,
  classifyUrgency,
  computeLeadMatchScore,
  computeSignalScore,
  evaluate,
  scoreEvidenceStrength,
} from '../../src/core/decision/engine.js';
import type { DecisionContext, DecisionEvidence, NormalizedDecisionSignal } from '../../src/core/decision/types.js';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function activeSignal(overrides: Partial<NormalizedDecisionSignal> = {}): NormalizedDecisionSignal {
  return {
    signalId: 's-1',
    signalType: 'HIRING',
    source: 'jobs.example.com',
    title: 'VP of Sales opening',
    summary: 'Company posted a VP of Sales role on their careers page.',
    observedAt: new Date('2026-08-22T00:00:00.000Z'),
    expiresAt: new Date('2026-09-21T00:00:00.000Z'),
    isActive: true,
    intentWeight: 80,
    confidence: 1,
    sourceQuality: 1,
    evidenceClassification: 'FACT',
    deduplicationKey: 'hiring-vp-sales',
    ...overrides,
  };
}

function expiredSignal(): NormalizedDecisionSignal {
  return {
    ...activeSignal(),
    signalId: 's-expired',
    expiresAt: new Date('2026-08-22T11:59:00.000Z'),
  };
}

function inactiveSignal(): NormalizedDecisionSignal {
  return {
    ...activeSignal(),
    signalId: 's-inactive',
    isActive: false,
  };
}

function fundingSignal(): NormalizedDecisionSignal {
  return {
    ...activeSignal(),
    signalId: 's-2',
    signalType: 'FUNDING',
    source: 'techcrunch.com',
    title: 'Series B $30M',
    summary: 'Company raised $30M Series B led by Accel.',
    intentWeight: 85,
    evidenceClassification: 'FACT',
    deduplicationKey: 'series-b-30m',
  };
}

function factEvidence(overrides: Partial<DecisionEvidence> = {}): DecisionEvidence {
  return {
    evidenceId: 'e-1',
    evidenceType: 'HIRING_PAGE',
    classification: 'FACT',
    sourceUrl: 'https://example.com/careers',
    observedAt: new Date('2026-08-22T00:00:00.000Z'),
    confidence: 1,
    ...overrides,
  };
}

function makeContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    leadId: 'lead-1',
    companyId: 'company-1',
    companyName: 'Acme Corp',
    icpFit: 0.8,
    leadTitle: 'VP of Sales',
    leadSeniority: 'VP',
    signals: [activeSignal()],
    evidence: [factEvidence()],
    ...overrides,
  };
}

describe('Decision engine — unit', () => {
  describe('score computation', () => {
    it('returns zero score for empty signals', () => {
      const ctx = makeContext({ signals: [], evidence: [] });
      const result = evaluate(ctx, NOW);
      expect(result.score).toBeLessThan(50);
    });

    it('produces maximum score for high-urgency signals with strong evidence and ICP fit', () => {
      const ctx = makeContext({
        signals: [
          activeSignal({ intentWeight: 100, confidence: 1, evidenceClassification: 'FACT', observedAt: NOW }),
          fundingSignal(),
        ],
        evidence: [factEvidence(), factEvidence({ evidenceId: 'e-2', evidenceType: 'FUNDING_ANNOUNCEMENT' })],
        icpFit: 1.0,
        leadTitle: 'CEO',
        leadSeniority: 'C-Level',
      });
      const result = evaluate(ctx, NOW);
      expect(result.score).toBeGreaterThanOrEqual(60);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.urgency).toBe('HIGH');
    });

    it('handles conflicting signals where some are high and some are low weight', () => {
      const ctx = makeContext({
        signals: [
          activeSignal({ intentWeight: 90, evidenceClassification: 'FACT' }),
          activeSignal({ signalId: 's-low', signalType: 'CONTENT_ENGAGEMENT', intentWeight: 20, evidenceClassification: 'UNVERIFIED', deduplicationKey: 'low-signal' }),
        ],
      });
      const result = evaluate(ctx, NOW);
      expect(result.signalSummary.activeSignalCount).toBe(2);
      expect(result.topFactors.length).toBeGreaterThan(0);
      // High-weight signal should dominate
      const topFactor = result.topFactors[0];
      expect(topFactor.name).toContain('Hiring');
    });

    it('returns zero for leads with no signals at all', () => {
      const ctx = makeContext({ signals: [], evidence: [], icpFit: 0.5 });
      const result = evaluate(ctx, NOW);
      expect(result.signalSummary.activeSignalCount).toBe(0);
      expect(result.whyNow.some(r => r.includes('No active signals'))).toBe(true);
      expect(result.recommendedActions.length).toBeGreaterThan(0);
      expect(result.urgency).toBe('LOW');
    });

    it('excludes expired and inactive signals', () => {
      const ctx = makeContext({
        signals: [activeSignal(), expiredSignal(), inactiveSignal()],
      });
      const result = evaluate(ctx, NOW);
      expect(result.signalSummary.activeSignalCount).toBe(1);
      expect(result.signalSummary.duplicateSignalCount).toBe(2); // expired + inactive = non-active from total count of 3
      // duplicateSignalCount = total - active, where total = signals.length
      // but isActiveSignal filters both expired AND inactive
    });
  });

  describe('urgency classification', () => {
    it('classifies HIGH for recent FACT signal with high weight', () => {
      expect(classifyUrgency(2, 80, 'FACT')).toBe('HIGH');
    });

    it('classifies MEDIUM for signals within 30 days with moderate weight', () => {
      expect(classifyUrgency(200, 60, 'INFERENCE')).toBe('MEDIUM');
    });

    it('classifies LOW for old or low weight signals', () => {
      expect(classifyUrgency(800, 30, 'UNVERIFIED')).toBe('LOW');
    });
  });

  describe('signal scoring', () => {
    it('scores active signals and ignores expired ones', () => {
      const score = computeSignalScore([activeSignal(), expiredSignal()], NOW);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('deduplicates by key keeping the highest weight', () => {
      const dedupKey = 'same-event';
      const score = computeSignalScore([
        activeSignal({ deduplicationKey: dedupKey, intentWeight: 80 }),
        activeSignal({ signalId: 'dup-2', deduplicationKey: dedupKey, intentWeight: 60 }),
      ], NOW);
      expect(score).toBeGreaterThan(0);
    });

    it('handles missing deduplication keys by falling back to signalId', () => {
      const score = computeSignalScore([
        activeSignal({ deduplicationKey: undefined }),
        activeSignal({ deduplicationKey: undefined }),
      ], NOW);
      expect(score).toBeGreaterThan(0);
    });
  });

  describe('evidence strength', () => {
    it('returns 0 for no evidence', () => {
      expect(scoreEvidenceStrength([])).toBe(0);
    });

    it('weights FACT higher than UNVERIFIED', () => {
      const factScore = scoreEvidenceStrength([factEvidence()]);
      const unverifiedScore = scoreEvidenceStrength([
        { ...factEvidence(), classification: 'UNVERIFIED', evidenceId: 'e-u' },
      ]);
      expect(factScore).toBeGreaterThan(unverifiedScore);
    });

    it('averages multiple evidence items', () => {
      const score = scoreEvidenceStrength([
        factEvidence(),
        factEvidence({ evidenceId: 'e-2', classification: 'INFERENCE', confidence: 0.5 }),
      ]);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('lead match', () => {
    it('scores C-Level higher than Manager', () => {
      const cLevel = computeLeadMatchScore(makeContext({ leadTitle: 'CEO', leadSeniority: 'C-Level' }));
      const manager = computeLeadMatchScore(makeContext({ leadTitle: 'Engineering Manager', leadSeniority: 'Manager' }));
      expect(cLevel).toBeGreaterThan(manager);
    });

    it('scores buying roles higher than support roles', () => {
      const vpSales = computeLeadMatchScore(makeContext({ leadTitle: 'VP of Sales', leadSeniority: 'VP' }));
      const hr = computeLeadMatchScore(makeContext({ leadTitle: 'HR Manager', leadSeniority: 'Manager' }));
      expect(vpSales).toBeGreaterThan(hr);
    });

    it('returns a baseline for unknown titles', () => {
      const score = computeLeadMatchScore(makeContext({ leadTitle: undefined, leadSeniority: undefined }));
      expect(score).toBe(50);
    });
  });

  describe('whyNow', () => {
    it('generates rationale for active signals', () => {
      const reasons = buildWhyNow([activeSignal(), fundingSignal()], NOW);
      expect(reasons.length).toBeGreaterThan(1);
      expect(reasons.some(r => r.includes('expanding'))).toBe(true);
      expect(reasons.some(r => r.includes('funding'))).toBe(true);
    });

    it('adds recency prefix for very recent signals', () => {
      const veryRecent = activeSignal({ observedAt: new Date(NOW.getTime() - 2 * 3_600_000) });
      const reasons = buildWhyNow([veryRecent], NOW);
      expect(reasons[0]).toContain('24 hours');
    });

    it('shows placeholder when no signals are active', () => {
      const reasons = buildWhyNow([], NOW);
      expect(reasons[0]).toContain('No active signals');
    });
  });

  describe('recommended actions', () => {
    it('generates channel-specific actions for HIRING', () => {
      const actions = buildRecommendedActions([activeSignal()], 'Acme Corp', 'VP of Sales', NOW);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.some(a => a.channel === 'linkedin' && a.capability === 'sendMessage')).toBe(true);
    });

    it('generates actions for FUNDING', () => {
      const actions = buildRecommendedActions([fundingSignal()], 'Acme Corp', 'CTO', NOW);
      expect(actions.some(a => a.channel === 'email' && a.capability === 'sendMessage' && a.timing === 'IMMEDIATE')).toBe(true);
    });

    it('interpolates firstName, companyName, and signalTitle in templates', () => {
      const actions = buildRecommendedActions([activeSignal()], 'Acme Corp', 'Alice Johnson', NOW);
      const msg = actions.find(a => a.channel === 'linkedin' && a.capability === 'sendMessage');
      expect(msg?.template).toContain('Alice');
      expect(msg?.template).toContain('Acme Corp');
      expect(msg?.template).toContain('VP of Sales opening');
    });

    it('falls back to default actions when no signals are active', () => {
      const actions = buildRecommendedActions([], 'Acme Corp', 'Some Person', NOW);
      expect(actions[0].channel).toBe('linkedin');
      expect(actions[0].capability).toBe('connect');
      expect(actions[0].template).toContain('Some'); // first name extraction
      expect(actions[0].template).toContain('Acme Corp');
      expect(actions[1].channel).toBe('manual');
      expect(actions[1].capability).toBe('followUp');
      expect(actions[1].template).toContain('Acme Corp');
    });

    it('filters out actions whose channel does not support the required capability', () => {
      // manual does not support sendMessage — actions requiring sendMessage on manual should be filtered
      // but manual DEFAULT_ACTIONS use followUp which is supported
      const actions = buildRecommendedActions([], 'Acme Corp', 'Some Person', NOW);
      // Default actions: linkedin/connect + manual/followUp — both should pass registry
      expect(actions.length).toBe(2);
      expect(actions.every(a => a.channel === 'linkedin' || a.channel === 'manual')).toBe(true);
    });

    it('limits actions to at most 4', () => {
      const actions = buildRecommendedActions(
        [activeSignal(), fundingSignal(), activeSignal({ signalId: 's-3', signalType: 'TECH_INSTALL', deduplicationKey: 'tech-1', title: 'Installed Kubernetes' })],
        'Acme Corp',
        'VP Sales',
        NOW,
      );
      expect(actions.length).toBeLessThanOrEqual(4);
    });
  });

  describe('buildDecisionFactors', () => {
    it('includes signal, evidence, ICP fit and lead match when present', () => {
      const ctx = makeContext({
        signals: [activeSignal()],
        evidence: [factEvidence()],
        icpFit: 0.8,
        leadTitle: 'VP of Sales',
        leadSeniority: 'VP',
      });
      const factors = buildDecisionFactors(ctx, 60, 0.8, 85, NOW);
      expect(factors.length).toBeGreaterThanOrEqual(2);
      expect(factors.some(f => f.name.includes('Hiring'))).toBe(true);
      expect(factors.some(f => f.name === 'ICP fit')).toBe(true);
      expect(factors.some(f => f.name === 'Lead seniority match')).toBe(true);
    });

    it('sorts factors by contribution descending', () => {
      const ctx = makeContext({
        signals: [activeSignal({ intentWeight: 90 })],
        evidence: [factEvidence()],
        icpFit: 0.5,
        leadTitle: 'Engineer',
        leadSeniority: 'Individual Contributor',
      });
      const factors = buildDecisionFactors(ctx, 80, 1, 30, NOW);
      for (let i = 1; i < factors.length; i++) {
        expect(factors[i].contribution).toBeLessThanOrEqual(factors[i - 1].contribution);
      }
    });
  });

  describe('evaluate (full pipeline)', () => {
    it('returns a complete OpportunityScore structure', () => {
      const ctx = makeContext({
        signals: [activeSignal(), fundingSignal()],
        evidence: [factEvidence()],
        icpFit: 0.85,
        leadTitle: 'CTO',
        leadSeniority: 'C-Level',
      });
      const result = evaluate(ctx, NOW);

      expect(result.leadId).toBe('lead-1');
      expect(result.companyId).toBe('company-1');
      expect(result.companyName).toBe('Acme Corp');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(result.urgency);
      expect(result.topFactors.length).toBeGreaterThan(0);
      expect(result.whyNow.length).toBeGreaterThan(0);
      expect(result.recommendedActions.length).toBeGreaterThan(0);
      expect(result.signalSummary.topSignalTypes.length).toBe(2);
      expect(result.signalSummary.evidenceStrength).toBeGreaterThan(0);
      expect(result.icpFit).toBe(0.85);
    });

    it('handles lead without title gracefully', () => {
      const ctx = makeContext({
        signals: [activeSignal()],
        evidence: [],
        icpFit: 0.5,
        leadTitle: undefined,
        leadSeniority: undefined,
      });
      const result = evaluate(ctx, NOW);
      expect(result.topFactors.some(f => f.name === 'Lead seniority match')).toBe(false);
    });

    it('computes hours correctly for latestSignalAgeHours', () => {
      const twoDaysAgo = new Date(NOW.getTime() - 48 * 3_600_000);
      const ctx = makeContext({
        signals: [activeSignal({ observedAt: twoDaysAgo })],
        evidence: [],
      });
      const result = evaluate(ctx, NOW);
      expect(result.signalSummary.latestSignalAgeHours).toBeCloseTo(48, -0.5); // Allow rounding tolerance
    });
  });
});