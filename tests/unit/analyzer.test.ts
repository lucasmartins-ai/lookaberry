import { describe, it, expect } from 'vitest';
import { analyzeIcpContent } from '../../src/core/icp/analyzer.js';

describe('ICP Analyzer Engine', () => {
  it('should extract personas and value propositions from markdown', async () => {
    const markdown = `# Stripe

Stripe is a suite of APIs powering online payment processing and commerce solutions for internet businesses.
We help companies accept payments, send payouts, and manage their business online.`;

    const result = await analyzeIcpContent(markdown, 'https://stripe.com');

    expect(result.company_name).toBeDefined();
    expect(result.company_summary).toBeDefined();
    expect(Array.isArray(result.target_personas)).toBe(true);
    expect(result.target_personas.length).toBeGreaterThan(0);

    const firstPersona = result.target_personas[0];
    expect(firstPersona.title).toBeDefined();
    expect(firstPersona.seniority).toBeDefined();
    expect(firstPersona.core_pain).toBeDefined();

    expect(Array.isArray(result.value_propositions)).toBe(true);
    expect(result.value_propositions.length).toBeGreaterThan(0);
  });
});
