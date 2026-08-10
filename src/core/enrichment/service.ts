import { resolveMx } from 'node:dns/promises';
import axios from 'axios';
import { prisma } from '../../db/client.js';
import { config } from '../../config/env.js';
import type { WaterfallEnrichLeadInput, WaterfallEnrichLeadOutput } from '../../mcp/schemas/enrichment.js';

export type EmailStatus = 'VERIFIED' | 'RISKY' | 'INVALID' | 'NOT_FOUND';

export interface EnrichmentLead {
  id: string;
  email: string | null;
  emailStatus: string;
  linkedinUrl?: string | null;
  phone?: string | null;
  firstName?: string;
  lastName?: string | null;
  fullName?: string;
  title?: string;
  companyDomain?: string;
}

export interface ProviderResult {
  email?: string;
  linkedin_url?: string;
  phone?: string;
  raw_payload?: unknown;
}

export interface EnrichmentProvider {
  name: string;
  credits: number;
  enrich(lead: EnrichmentLead): Promise<ProviderResult | null>;
}

export interface EmailVerifier {
  verify(email: string): Promise<EmailStatus>;
}

interface EnrichmentRepository {
  getLead(id: string): Promise<EnrichmentLead | null>;
  findCachedLead(id: string): Promise<{ email: string; emailStatus: EmailStatus; linkedinUrl?: string | null; phone?: string | null; provider: string } | null>;
  saveResult(input: { leadId: string; companyId?: string; provider: string; costCredits: number; status: string; responsePayload?: unknown }): Promise<void>;
  updateLead(id: string, result: { email?: string; emailStatus: EmailStatus; linkedinUrl?: string; phone?: string }): Promise<void>;
}

const mxVerifier: EmailVerifier = {
  async verify(email) {
    const domain = email.split('@')[1];
    if (!domain) return 'INVALID';
    try {
      const records = await resolveMx(domain);
      return records.length > 0 ? 'VERIFIED' : 'RISKY';
    } catch {
      return 'RISKY';
    }
  },
};

const apolloProvider: EnrichmentProvider = {
  name: 'APOLLO',
  credits: 1,
  async enrich(lead) {
    if (!config.APOLLO_API_KEY) return null;
    const response = await axios.post('https://api.apollo.io/api/v1/people/match', {
      first_name: lead.firstName,
      last_name: lead.lastName,
      organization_domain: lead.companyDomain,
      person_titles: lead.title ? [lead.title] : undefined,
    }, { headers: { 'x-api-key': config.APOLLO_API_KEY } });
    const person = response.data?.person;
    return person ? { email: person.email, linkedin_url: person.linkedin_url, phone: person.phone_numbers?.[0]?.sanitized_number, raw_payload: { id: person.id, email: person.email } } : null;
  },
};

const dropcontactProvider: EnrichmentProvider = {
  name: 'DROPCONTACT',
  credits: 1,
  async enrich(lead) {
    if (!config.DROPCONTACT_API_KEY) return null;
    const response = await axios.post('https://api.dropcontact.com/batch', {
      data: [{ first_name: lead.firstName, last_name: lead.lastName, email: lead.email, company: lead.companyDomain, job: lead.title }],
    }, { headers: { 'X-Access-Token': config.DROPCONTACT_API_KEY } });
    const contact = response.data?.data?.[0];
    return contact ? { email: contact.email, linkedin_url: contact.linkedin, phone: contact.phone, raw_payload: { success: response.data?.success } } : null;
  },
};

const unavailableProvider = (name: string): EnrichmentProvider => ({ name, credits: 0, async enrich() { return null; } });

const defaultVerifier: EmailVerifier = config.ZEROBOUNCE_API_KEY ? {
  async verify(email) {
    const response = await axios.get('https://api.zerobounce.net/v2/validate', { params: { api_key: config.ZEROBOUNCE_API_KEY, email } });
    const status = String(response.data?.status ?? '').toLowerCase();
    if (status === 'valid') return 'VERIFIED';
    if (status === 'invalid') return 'INVALID';
    return 'RISKY';
  },
} : mxVerifier;

const prismaRepository: EnrichmentRepository = {
  async getLead(id) {
    const lead = await prisma.lead.findUnique({ include: { company: true }, where: { id } });
    return lead ? { ...lead, companyDomain: lead.company.domain } : null;
  },
  async findCachedLead(id) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { email: true, emailStatus: true, linkedinUrl: true, phone: true } });
    if (!lead?.email || lead.emailStatus === 'UNVERIFIED' || lead.emailStatus === 'INVALID' || lead.emailStatus === 'NOT_FOUND') return null;
    return { email: lead.email, emailStatus: lead.emailStatus as EmailStatus, linkedinUrl: lead.linkedinUrl, phone: lead.phone, provider: 'LOCAL_CACHE' };
  },
  async saveResult(input) {
    await prisma.enrichmentLog.create({ data: { leadId: input.leadId, companyId: input.companyId, provider: input.provider, costCredits: input.costCredits, status: input.status, responsePayload: input.responsePayload as any } });
  },
  async updateLead(id, result) {
    await prisma.lead.update({ where: { id }, data: { email: result.email, emailStatus: result.emailStatus, linkedinUrl: result.linkedinUrl, phone: result.phone, status: result.emailStatus === 'VERIFIED' ? 'READY' : undefined } });
  },
};

export interface WaterfallDependencies {
  getLead?: EnrichmentRepository['getLead'];
  findCachedLead?: EnrichmentRepository['findCachedLead'];
  saveResult?: EnrichmentRepository['saveResult'];
  updateLead?: EnrichmentRepository['updateLead'];
  providers?: EnrichmentProvider[];
  verifier?: EmailVerifier;
}

export class WaterfallEnrichmentService {
  private readonly repository: EnrichmentRepository;
  private readonly providers: EnrichmentProvider[];
  private readonly verifier: EmailVerifier;

  constructor(dependencies: WaterfallDependencies = {}) {
    this.repository = {
      getLead: dependencies.getLead ?? prismaRepository.getLead,
      findCachedLead: dependencies.findCachedLead ?? prismaRepository.findCachedLead,
      saveResult: dependencies.saveResult ?? prismaRepository.saveResult,
      updateLead: dependencies.updateLead ?? prismaRepository.updateLead,
    };
    this.providers = dependencies.providers ?? [config.APOLLO_API_KEY ? apolloProvider : unavailableProvider('APOLLO'), config.DROPCONTACT_API_KEY ? dropcontactProvider : unavailableProvider('DROPCONTACT')];
    this.verifier = dependencies.verifier ?? defaultVerifier;
  }

  async enrichLead(input: WaterfallEnrichLeadInput): Promise<WaterfallEnrichLeadOutput> {
    const lead = await this.repository.getLead(input.lead_id);
    if (!lead) throw new Error(`Lead not found: ${input.lead_id}`);

    if (!input.force_refresh) {
      const cached = await this.repository.findCachedLead(input.lead_id);
      if (cached) {
        return { lead_id: input.lead_id, email: cached.email, email_status: cached.emailStatus, linkedin_url: cached.linkedinUrl ?? undefined, phone: cached.phone ?? undefined, provider_used: cached.provider, credits_consumed: 0 };
      }
    }

    let credits = 0;
    for (const provider of this.providers) {
      credits += provider.credits;
      try {
        const result = await provider.enrich(lead);
        await this.repository.saveResult({ leadId: lead.id, provider: provider.name, costCredits: provider.credits, status: result?.email ? 'FOUND' : 'NOT_FOUND', responsePayload: result });
        if (!result?.email) continue;

        const emailStatus = await this.verifier.verify(result.email);
        await this.repository.saveResult({ leadId: lead.id, provider: 'SMTP_VALIDATOR', costCredits: 0, status: emailStatus, responsePayload: { email: result.email } });
        if (emailStatus === 'INVALID') continue;

        const output = { lead_id: lead.id, email: result.email, email_status: emailStatus, linkedin_url: result.linkedin_url, phone: result.phone, provider_used: provider.name, credits_consumed: credits };
        await this.repository.updateLead(lead.id, { email: result.email, emailStatus, linkedinUrl: result.linkedin_url, phone: result.phone });
        return output;
      } catch (error) {
        await this.repository.saveResult({ leadId: lead.id, provider: provider.name, costCredits: provider.credits, status: 'FAILED', responsePayload: { error: error instanceof Error ? error.message : String(error) } });
      }
    }

    await this.repository.updateLead(lead.id, { emailStatus: 'NOT_FOUND' });
    return { lead_id: lead.id, email_status: 'NOT_FOUND', provider_used: 'NONE', credits_consumed: credits };
  }
}

export const waterfallEnrichmentService = new WaterfallEnrichmentService();
