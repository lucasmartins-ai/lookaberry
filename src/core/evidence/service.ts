import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import type { EvidenceClassification, SanitizedJson } from './types.js';

export type { EvidenceClassification, SanitizedJson } from './types.js';

const SENSITIVE_KEY = /(password|secret|token|api[_-]?key|authorization|cookie|session[_-]?key|credential)/i;
const URL_KEY = /((^|[_-])(url|uri)|(?:url|uri)$)/i;
const MAX_STRING_LENGTH = 10_000;
const MAX_DEPTH = 8;

export function sanitizeEvidenceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().slice(0, 1_000);
  } catch {
    return value.trim().slice(0, 1_000);
  }
}

export interface SourceInput {
  name: string;
  source_type: string;
  source_url?: string;
  external_id?: string;
  metadata?: unknown;
}

export interface PersonInput {
  company_id?: string;
  first_name?: string;
  last_name?: string;
  full_name: string;
  title?: string;
  seniority?: string;
  linkedin_url?: string;
  email?: string;
  phone?: string;
  location?: string;
  metadata?: unknown;
}

export interface IdentityInput {
  person_id?: string;
  company_id?: string;
  source_id?: string;
  identity_type: string;
  value: string;
  normalized_value?: string;
  is_primary?: boolean;
  verified_at?: Date;
  confidence?: number;
  metadata?: unknown;
}

export interface EvidenceInput {
  source_id: string;
  evidence_type: string;
  classification: EvidenceClassification;
  source_url?: string;
  observed_at?: Date;
  expires_at?: Date;
  confidence?: number;
  normalized_data?: unknown;
  raw_data?: unknown;
}

export interface CompanyEvidenceInput extends EvidenceInput {
  company_id: string;
}

export interface PersonEvidenceInput extends EvidenceInput {
  person_id: string;
}

export interface RelationshipInput {
  company_id: string;
  person_id: string;
  source_id?: string;
  relationship_type: string;
  confidence?: number;
  started_at?: Date;
  ended_at?: Date;
  metadata?: unknown;
}

export interface EvidenceRepository {
  createSource(input: SourceInput): Promise<unknown>;
  createPerson(input: PersonInput): Promise<unknown>;
  upsertIdentity(input: IdentityInput): Promise<unknown>;
  createCompanyEvidence(input: CompanyEvidenceInput & { content_hash: string; normalized_data: SanitizedJson; raw_data?: SanitizedJson }): Promise<unknown>;
  createPersonEvidence(input: PersonEvidenceInput & { content_hash: string; normalized_data: SanitizedJson; raw_data?: SanitizedJson }): Promise<unknown>;
  createRelationship(input: RelationshipInput): Promise<unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function sanitizeEvidenceData(value: unknown, depth = 0): SanitizedJson {
  if (depth > MAX_DEPTH) return '[MAX_DEPTH_REACHED]';
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(item => sanitizeEvidenceData(item, depth + 1));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key)
          ? '[REDACTED]'
          : URL_KEY.test(key) && typeof entry === 'string'
            ? sanitizeEvidenceUrl(entry) ?? ''
            : sanitizeEvidenceData(entry, depth + 1),
      ])
    );
  }
  return String(value).slice(0, MAX_STRING_LENGTH);
}

export function normalizeConfidence(value = 1): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Number(value)));
}

function stableSerialize(value: SanitizedJson): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildEvidenceContentHash(normalizedData: unknown, rawData: unknown): string {
  const payload = sanitizeEvidenceData({ normalizedData, rawData });
  return createHash('sha256').update(stableSerialize(payload)).digest('hex');
}

const prismaRepository: EvidenceRepository = {
  async createSource(input) {
    const metadata = sanitizeEvidenceData(input.metadata ?? {});
    if (input.external_id) {
      const existing = await prisma.source.findFirst({
        where: { sourceType: input.source_type, externalId: input.external_id },
      });
      if (existing) {
        return prisma.source.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            sourceUrl: sanitizeEvidenceUrl(input.source_url),
            metadata: metadata as Prisma.InputJsonValue,
          },
        });
      }
    }
    return prisma.source.create({
      data: {
        name: input.name,
        sourceType: input.source_type,
        sourceUrl: sanitizeEvidenceUrl(input.source_url),
        externalId: input.external_id,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  },

  async createPerson(input) {
    return prisma.person.create({
      data: {
        companyId: input.company_id,
        firstName: input.first_name,
        lastName: input.last_name,
        fullName: input.full_name,
        title: input.title,
        seniority: input.seniority,
        linkedinUrl: sanitizeEvidenceUrl(input.linkedin_url),
        email: input.email,
        phone: input.phone,
        location: input.location,
        metadata: sanitizeEvidenceData(input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  },

  async upsertIdentity(input) {
    const normalizedValue = input.normalized_value ?? input.value.trim().toLowerCase();
    const existing = await prisma.identity.findFirst({
      where: { identityType: input.identity_type, normalizedValue },
    });
    const data = {
      personId: input.person_id,
      companyId: input.company_id,
      sourceId: input.source_id,
      identityType: input.identity_type,
      value: input.value,
      normalizedValue,
      isPrimary: input.is_primary ?? false,
      verifiedAt: input.verified_at,
      confidence: normalizeConfidence(input.confidence),
      metadata: sanitizeEvidenceData(input.metadata ?? {}) as Prisma.InputJsonValue,
    };
    return existing
      ? prisma.identity.update({ where: { id: existing.id }, data })
      : prisma.identity.create({ data });
  },

  async createCompanyEvidence(input) {
    return prisma.companyEvidence.create({
      data: {
        companyId: input.company_id,
        sourceId: input.source_id,
        evidenceType: input.evidence_type,
        classification: input.classification,
        sourceUrl: sanitizeEvidenceUrl(input.source_url),
        observedAt: input.observed_at,
        expiresAt: input.expires_at,
        confidence: normalizeConfidence(input.confidence),
        normalizedData: input.normalized_data as Prisma.InputJsonValue,
        rawData: input.raw_data as Prisma.InputJsonValue | undefined,
        contentHash: input.content_hash,
      },
    });
  },

  async createPersonEvidence(input) {
    return prisma.personEvidence.create({
      data: {
        personId: input.person_id,
        sourceId: input.source_id,
        evidenceType: input.evidence_type,
        classification: input.classification,
        sourceUrl: sanitizeEvidenceUrl(input.source_url),
        observedAt: input.observed_at,
        expiresAt: input.expires_at,
        confidence: normalizeConfidence(input.confidence),
        normalizedData: input.normalized_data as Prisma.InputJsonValue,
        rawData: input.raw_data as Prisma.InputJsonValue | undefined,
        contentHash: input.content_hash,
      },
    });
  },

  async createRelationship(input) {
    const data = {
      companyId: input.company_id,
      personId: input.person_id,
      sourceId: input.source_id,
      relationshipType: input.relationship_type,
      confidence: normalizeConfidence(input.confidence),
      startedAt: input.started_at,
      endedAt: input.ended_at,
      metadata: sanitizeEvidenceData(input.metadata ?? {}) as Prisma.InputJsonValue,
    };
    return prisma.relationship.upsert({
      where: {
        companyId_personId_relationshipType: {
          companyId: input.company_id,
          personId: input.person_id,
          relationshipType: input.relationship_type,
        },
      },
      create: data,
      update: data,
    });
  },
};

function prepareEvidence<T extends EvidenceInput>(input: T) {
  const normalizedData = sanitizeEvidenceData(input.normalized_data ?? {});
  const rawData = input.raw_data === undefined ? undefined : sanitizeEvidenceData(input.raw_data);
  return {
    ...input,
    observed_at: input.observed_at ?? new Date(),
    confidence: normalizeConfidence(input.confidence),
    normalized_data: normalizedData,
    raw_data: rawData,
    content_hash: buildEvidenceContentHash(normalizedData, rawData),
  };
}

export class EntityEvidenceService {
  constructor(private readonly repository: EvidenceRepository = prismaRepository) {}

  createSource(input: SourceInput) {
    return this.repository.createSource(input);
  }

  createPerson(input: PersonInput) {
    return this.repository.createPerson(input);
  }

  upsertIdentity(input: IdentityInput) {
    return this.repository.upsertIdentity(input);
  }

  createCompanyEvidence(input: CompanyEvidenceInput) {
    return this.repository.createCompanyEvidence(prepareEvidence(input));
  }

  createPersonEvidence(input: PersonEvidenceInput) {
    return this.repository.createPersonEvidence(prepareEvidence(input));
  }

  createRelationship(input: RelationshipInput) {
    return this.repository.createRelationship({
      ...input,
      confidence: normalizeConfidence(input.confidence),
    });
  }
}

export const entityEvidenceService = new EntityEvidenceService();
