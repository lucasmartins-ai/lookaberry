import { describe, expect, it, vi } from 'vitest';
import { DetectIntentSignalsInputSchema, IntentSignalInputSchema, ScoreAndRankLeadsInputSchema } from '../../src/mcp/schemas/intent.js';
import { registerIntentTools } from '../../src/mcp/tools/intent.js';

describe('Intent MCP compatibility contracts', () => {
  it('accepts the existing signal input shape', () => {
    const parsed = IntentSignalInputSchema.parse({
      company_domain: 'example.com',
      company_name: 'Example',
      signal_type: 'HIRING',
      source: 'careers',
      title: 'VP Sales',
      summary: 'Open role',
    });

    expect(parsed.signal_type).toBe('HIRING');
  });

  it('accepts provider collection inputs and applies safe defaults', () => {
    const parsed = DetectIntentSignalsInputSchema.parse({
      icp_id: '00000000-0000-0000-0000-000000000001',
      collection_inputs: [{
        company_domain: 'example.com',
        company_name: 'Example',
        job_postings: [{ title: 'VP Sales' }],
      }],
    });

    expect(parsed.provider_timeout_ms).toBe(10_000);
    expect(parsed.collection_inputs?.[0].job_postings?.[0].title).toBe('VP Sales');
  });

  it('does not change the ranking tool contract', () => {
    const parsed = ScoreAndRankLeadsInputSchema.parse({
      icp_id: '00000000-0000-0000-0000-000000000001',
    });

    expect(parsed.status_filter).toBe('READY');
    expect(parsed.min_score).toBe(60);
    expect(parsed.limit).toBe(25);
  });

  it('keeps both intent MCP tools registered', () => {
    const names: string[] = [];
    const server = { tool: vi.fn((name: string) => names.push(name)) };
    registerIntentTools(server as never);

    expect(names).toEqual(['gtm_detect_intent_signals', 'gtm_score_and_rank_leads']);
  });
});
