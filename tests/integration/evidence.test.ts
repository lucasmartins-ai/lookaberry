import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/client.js';
import { entityEvidenceService } from '../../src/core/evidence/service.js';

describe('Entity and evidence graph persistence', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('persists source, person, identity, evidence and relationship with provenance', async () => {
    const domain = `evidence-${Date.now()}.example`;
    const company = await prisma.company.create({
      data: {
        domain,
        name: 'Evidence Test Company',
      },
    });

    let sourceId: string | undefined;
    let personId: string | undefined;
    try {
      const source = await entityEvidenceService.createSource({
        name: 'Company careers page',
        source_type: 'WEB_PAGE',
        source_url: `https://${domain}/careers`,
        external_id: `${domain}:careers`,
      }) as { id: string };
      sourceId = source.id;
      const person = await entityEvidenceService.createPerson({
        company_id: company.id,
        full_name: 'Alex Morgan',
        title: 'VP Sales',
      }) as { id: string };
      personId = person.id;
      const identity = await entityEvidenceService.upsertIdentity({
        person_id: person.id,
        source_id: source.id,
        identity_type: 'EMAIL',
        value: 'Alex@Example.com',
      }) as { id: string; normalizedValue: string };
      const evidence = await entityEvidenceService.createPersonEvidence({
        person_id: person.id,
        source_id: source.id,
        evidence_type: 'JOB_TITLE',
        classification: 'FACT',
        source_url: `https://${domain}/leadership`,
        confidence: 0.95,
        normalized_data: { title: 'VP Sales' },
        raw_data: { api_key: 'must-not-persist' },
      }) as { id: string; classification: string; confidence: unknown; rawData: unknown };
      const relationship = await entityEvidenceService.createRelationship({
        company_id: company.id,
        person_id: person.id,
        source_id: source.id,
        relationship_type: 'EMPLOYEE_OF',
        confidence: 0.9,
      }) as { id: string };

      expect(identity.normalizedValue).toBe('alex@example.com');
      expect(evidence.classification).toBe('FACT');
      expect(Number(evidence.confidence)).toBeCloseTo(0.95, 4);
      expect(evidence.rawData).toEqual({ api_key: '[REDACTED]' });
      expect(relationship.id).toBeDefined();

      const graph = await prisma.person.findUnique({
        where: { id: person.id },
        include: { identities: true, evidence: true, relationships: true },
      });
      expect(graph?.identities).toHaveLength(1);
      expect(graph?.evidence).toHaveLength(1);
      expect(graph?.relationships).toHaveLength(1);
    } finally {
      if (personId) await prisma.person.delete({ where: { id: personId } });
      await prisma.company.delete({ where: { id: company.id } });
      if (sourceId) await prisma.source.delete({ where: { id: sourceId } });
    }
  });
});
