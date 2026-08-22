import { describe, expect, it, vi } from 'vitest';
import {
  EntityEvidenceService,
  buildEvidenceContentHash,
  normalizeConfidence,
  sanitizeEvidenceData,
  type EvidenceRepository,
} from '../../src/core/evidence/service.js';

describe('Entity and evidence graph', () => {
  it('sanitizes sensitive payload fields and bounds nested data', () => {
    const result = sanitizeEvidenceData({
      title: 'Public hiring announcement',
      api_key: 'do-not-store',
      nested: { cookie: 'secret-cookie', count: 3 },
    });

    expect(result).toEqual({
      title: 'Public hiring announcement',
      api_key: '[REDACTED]',
      nested: { cookie: '[REDACTED]', count: 3 },
    });

    expect(sanitizeEvidenceData({
      sourceUrl: 'https://example.com/careers?access_token=secret&tab=open',
    })).toEqual({
      sourceUrl: 'https://example.com/careers?tab=open',
    });
  });

  it('normalizes confidence to the inclusive 0..1 range', () => {
    expect(normalizeConfidence()).toBe(1);
    expect(normalizeConfidence(-0.5)).toBe(0);
    expect(normalizeConfidence(0.75)).toBe(0.75);
    expect(normalizeConfidence(2)).toBe(1);
    expect(normalizeConfidence(Number.NaN)).toBe(0);
  });

  it('creates stable content hashes after sanitization', () => {
    const first = buildEvidenceContentHash(
      { fact: 'hiring', credentials: 'secret' },
      { count: 2 }
    );
    const second = buildEvidenceContentHash(
      { credentials: 'different-secret', fact: 'hiring' },
      { count: 2 }
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists evidence with explicit provenance and prepared payloads', async () => {
    const repository: EvidenceRepository = {
      createSource: vi.fn(),
      createPerson: vi.fn(),
      upsertIdentity: vi.fn(),
      createCompanyEvidence: vi.fn().mockResolvedValue({ id: 'company-evidence-1' }),
      createPersonEvidence: vi.fn().mockResolvedValue({ id: 'person-evidence-1' }),
      createRelationship: vi.fn(),
    };
    const service = new EntityEvidenceService(repository);
    const observedAt = new Date('2026-08-22T10:00:00.000Z');
    const expiresAt = new Date('2026-09-21T10:00:00.000Z');

    await service.createCompanyEvidence({
      company_id: 'company-1',
      source_id: 'source-1',
      evidence_type: 'HIRING_PAGE',
      classification: 'FACT',
      source_url: 'https://example.com/careers',
      observed_at: observedAt,
      expires_at: expiresAt,
      confidence: 1.2,
      normalized_data: { role: 'VP Sales' },
      raw_data: { session_token: 'redact-me' },
    });

    expect(repository.createCompanyEvidence).toHaveBeenCalledWith(expect.objectContaining({
      company_id: 'company-1',
      source_id: 'source-1',
      classification: 'FACT',
      observed_at: observedAt,
      expires_at: expiresAt,
      confidence: 1,
      normalized_data: { role: 'VP Sales' },
      raw_data: { session_token: '[REDACTED]' },
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });
});
