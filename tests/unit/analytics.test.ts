import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService, applySignalFeedback, requiresHumanReview, type AnalyticsRepository } from '../../src/core/analytics/service.js';

describe('Analytics feedback loop', () => {
  it('adjusts signal weights with bounded positive and negative feedback', () => {
    expect(applySignalFeedback(98, 'POSITIVE')).toBe(100);
    expect(applySignalFeedback(2, 'NEGATIVE')).toBe(0);
    expect(applySignalFeedback(50, 'NEUTRAL')).toBe(50);
  });

  it('flags ambiguous or low-confidence classifications for human review', () => {
    expect(requiresHumanReview({ sentiment: 'POSITIVE', confidence: 84 })).toBe(true);
    expect(requiresHumanReview({ sentiment: 'POSITIVE', confidence: 85 })).toBe(false);
    expect(requiresHumanReview({ sentiment: 'AMBIGUOUS', confidence: 99 })).toBe(true);
  });

  it('records explicit feedback without invoking the classifier', async () => {
    const repository: AnalyticsRepository = {
      recordFeedback: vi.fn().mockResolvedValue({ feedbackId: 'feedback-1', requiresHumanReview: false }),
      getMetrics: vi.fn(),
    };
    const service = new AnalyticsService(repository);
    const result = await service.recordFeedback({
      campaign_id: '00000000-0000-0000-0000-000000000010',
      lead_id: '00000000-0000-0000-0000-000000000011',
      interaction_type: 'REPLY',
      sentiment: 'POSITIVE',
      confidence: 100,
      content: 'Interested, let us talk.',
    });

    expect(result).toEqual({ feedbackId: 'feedback-1', requiresHumanReview: false });
    expect(repository.recordFeedback).toHaveBeenCalledWith(expect.objectContaining({ interaction_type: 'REPLY' }), { sentiment: 'POSITIVE', confidence: 100 });
  });
});
