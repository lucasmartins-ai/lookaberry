import { describe, expect, it, vi } from 'vitest';

// No network: the scraper returns a fixed page.
vi.mock('../../src/core/icp/scraper.js', () => ({
  scrapeWebsite: async (url: string) => ({ url, title: 'Acme', markdown: '# Acme\nAgendamento online para clínicas odontológicas em São Paulo.', rawText: '', source: 'cheerio_fallback', tokensSavedPct: 0 }),
}));

const { icpService } = await import('../../src/core/icp/service.js');

describe('gtm_analyze_icp in agent mode (default: no server LLM)', () => {
  it('returns the reduced page and format for the calling agent instead of calling an API', async () => {
    const result = await icpService.analyzeIcp({ website_url: 'https://acme.test', target_geos: ['BR'] });
    expect(result).toMatchObject({ mode: 'agent', website_url: 'https://acme.test' });
    if (!('mode' in result)) throw new Error('expected a brief');
    expect(result.prompt).toContain('clínicas odontológicas');
    expect(result.prompt).toContain('Target Geos: BR');
    expect(result.system).toContain('"target_personas"');
    expect(result.next_step).toContain('analysis=');
  });
});
