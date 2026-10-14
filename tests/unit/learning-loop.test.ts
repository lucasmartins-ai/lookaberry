import { describe, expect, it, vi, afterEach } from 'vitest';
import { abStepDelta } from '../../src/core/analytics/service.js';
import { classifyReply, classifyReplyHeuristic } from '../../src/core/analytics/replyClassifier.js';
import { generateEmbeddingWithModel, generateLexicalEmbedding, LEXICAL_EMBEDDING_MODEL } from '../../src/core/icp/embeddings.js';
import { config } from '../../src/config/env.js';

describe('A/B conversion attribution', () => {
  const fresh = { openedAt: null, clickedAt: null, repliedAt: null };

  it('credits the first open, click and reply of a message to its step', () => {
    expect(abStepDelta('OPEN', fresh)).toEqual({ opens: { increment: 1 } });
    expect(abStepDelta('CLICK', fresh)).toEqual({ clicks: { increment: 1 } });
    expect(abStepDelta('REPLY', fresh)).toEqual({ replies: { increment: 1 } });
  });

  it('does not double count repeated events for the same message', () => {
    const seen = { openedAt: new Date(), clickedAt: new Date(), repliedAt: new Date() };
    expect(abStepDelta('OPEN', seen)).toBeNull();
    expect(abStepDelta('CLICK', seen)).toBeNull();
    expect(abStepDelta('REPLY', seen)).toBeNull();
    expect(abStepDelta('BOUNCE', fresh)).toBeNull();
  });
});

describe('embedding model labelling', () => {
  // Skipped when an embeddings provider is configured (it would call it).
  it.skipIf(Boolean(config.OPENAI_API_KEY || config.EMBEDDINGS_BASE_URL))('works with no API at all: local lexical embeddings', async () => {
    const { embedding, model } = await generateEmbeddingWithModel('B2B dental clinic in London');
    expect(model).toBe(LEXICAL_EMBEDDING_MODEL);
    expect(embedding).toHaveLength(1536);
  });

  it('lexical embeddings are meaningful: shared vocabulary means closer vectors', () => {
    const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    const icp = generateLexicalEmbedding('Clínicas odontológicas em São Paulo com agendamento online e WhatsApp');
    const dental = generateLexicalEmbedding('Clínica odontológica com agendamento pelo WhatsApp, implantes e ortodontia em São Paulo');
    const saas = generateLexicalEmbedding('B2B SaaS platform for DevOps observability and Kubernetes monitoring');
    expect(cos(icp, dental)).toBeGreaterThan(0.3);
    expect(cos(icp, dental)).toBeGreaterThan(cos(icp, saas) + 0.2);
  });
});

describe('reply classifier', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('maps opt-outs to UNSUBSCRIBE in pt/en', () => {
    for (const text of ['Please unsubscribe me', 'STOP', 'pare de mandar mensagem', 'me remova da lista']) {
      expect(classifyReplyHeuristic(text).intent, text).toBe('UNSUBSCRIBE');
    }
  });

  it('separates not-now, wrong person and auto replies from refusals', () => {
    expect(classifyReplyHeuristic('Maybe next quarter').intent).toBe('NOT_NOW');
    expect(classifyReplyHeuristic("I'm not the right person for this").intent).toBe('WRONG_PERSON');
    expect(classifyReplyHeuristic('Out of office until Monday').intent).toBe('AUTO_REPLY');
  });

  // Skipped when a key is configured (it would call the real API).
  it.skipIf(Boolean(config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY))('falls back to the heuristic when no API key is configured', async () => {
    const result = await classifyReply('Not interested, thanks');
    expect(result.source).toBe('heuristic');
    expect(result.intent).toBe('NOT_INTERESTED');
  });
});

describe('boolean env flags', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('treats "false" as false (z.coerce.boolean would make it true)', async () => {
    vi.stubEnv('AB_TEST_AUTO_PROMOTE', 'false');
    vi.stubEnv('EMAIL_TRACKING_ENABLED', 'false');
    vi.resetModules();
    const { config } = await import('../../src/config/env.js');
    expect(config.AB_TEST_AUTO_PROMOTE).toBe(false);
    expect(config.EMAIL_TRACKING_ENABLED).toBe(false);
  });

  it('accepts "true"/"1" and keeps defaults when unset', async () => {
    vi.stubEnv('AB_TEST_AUTO_PROMOTE', '1');
    vi.resetModules();
    const { config } = await import('../../src/config/env.js');
    expect(config.AB_TEST_AUTO_PROMOTE).toBe(true);
    expect(config.SCHEDULE_RESPECT_LEAD_TIMEZONE).toBe(true);
  });
});
