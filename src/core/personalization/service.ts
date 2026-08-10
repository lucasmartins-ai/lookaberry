import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../db/client.js';
import { config } from '../../config/env.js';
import type { GenerateHyperPersonalizedMessageInput, GenerateHyperPersonalizedMessageOutput } from '../../mcp/schemas/personalization.js';

const STATIC_PROMPT = `You write concise B2B outbound messages. Use only facts in the user payload. Never invent company details, results, metrics, customers, or shared context. Start from the active signal and connect it to the lead's role. Avoid generic AI copy and spam language. Return JSON only with: subject (string or null), body (string), hook_used (string). Keep LinkedIn connection requests under 300 characters, LinkedIn messages under 700 characters, and emails under 120 words.`;
const BANNED_TERMS = /\b(discover|unlock|game[- ]changing|revolutionary|seamless|leverage|synergy|cutting[- ]edge|ai-powered|best-in-class|transformative)\b/gi;

interface PersonalizationRepository {
  getContext(leadId: string, signalId?: string): Promise<{
    lead: { firstName: string; title: string; companyName: string };
    signal: { summary: string; title: string; signalType: string } | null;
  } | null>;
}

interface MessageGenerator {
  generate(input: { system: string; prompt: string; channel: GenerateHyperPersonalizedMessageInput['channel'] }): Promise<{ subject?: string | null; body: string; hook_used: string }>;
}

const prismaRepository: PersonalizationRepository = {
  async getContext(leadId, signalId) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { company: true } });
    if (!lead) return null;
    const signal = signalId
      ? await prisma.intentSignal.findFirst({ where: { id: signalId, companyId: lead.companyId } })
      : await prisma.intentSignal.findFirst({ where: { companyId: lead.companyId, isActive: true, expiresAt: { gt: new Date() } }, orderBy: [{ intentWeight: 'desc' }, { detectedAt: 'desc' }] });
    return {
      lead: { firstName: lead.firstName, title: lead.title, companyName: lead.company.name },
      signal: signal ? { summary: signal.summary, title: signal.title, signalType: signal.signalType } : null,
    };
  },
};

const anthropicGenerator: MessageGenerator = {
  async generate({ system, prompt, channel }) {
    const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 300,
      temperature: 0.3,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Channel: ${channel}\n${prompt}` }],
    });
    const text = response.content.find(block => block.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Anthropic returned no text response');
    const json = text.text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('Anthropic returned invalid JSON');
    return JSON.parse(json) as { subject?: string | null; body: string; hook_used: string };
  },
};

export function buildDynamicPrompt(context: Awaited<ReturnType<PersonalizationRepository['getContext']>>, input: GenerateHyperPersonalizedMessageInput) {
  if (!context) throw new Error(`Lead not found: ${input.lead_id}`);
  if (!context.signal) throw new Error('No active intent signal found for this lead');
  return JSON.stringify({ lead: context.lead, active_signal: context.signal, tone: input.tone, instructions: 'Use the signal summary as the only pain/context source. Do not add an ICP fact that is not present in this payload.' });
}

export function applyMessageGuardrails(output: { subject?: string | null; body: string; hook_used: string }, channel: GenerateHyperPersonalizedMessageInput['channel']): GenerateHyperPersonalizedMessageOutput {
  const text = [output.subject, output.body, output.hook_used].filter(Boolean).join(' ');
  BANNED_TERMS.lastIndex = 0;
  if (BANNED_TERMS.test(text)) throw new Error('Generated message contains a blocked spam or generic term');
  const body = output.body.trim();
  if (!body || body.length > (channel === 'LINKEDIN_CONNECT' ? 300 : channel === 'LINKEDIN_MESSAGE' ? 700 : 800)) throw new Error('Generated message exceeds the channel limit');
  return { subject: output.subject?.trim() || undefined, body, hook_used: output.hook_used.trim(), estimated_tokens_used: Math.ceil(text.length / 4) };
}

export interface PersonalizationDependencies { repository?: PersonalizationRepository; generator?: MessageGenerator; }

export class HyperPersonalizationService {
  private readonly repository: PersonalizationRepository;
  private readonly generator: MessageGenerator;
  constructor(dependencies: PersonalizationDependencies = {}) { this.repository = dependencies.repository ?? prismaRepository; this.generator = dependencies.generator ?? anthropicGenerator; }
  async generateMessage(input: GenerateHyperPersonalizedMessageInput): Promise<GenerateHyperPersonalizedMessageOutput> {
    const context = await this.repository.getContext(input.lead_id, input.signal_id);
    const prompt = buildDynamicPrompt(context, input);
    return applyMessageGuardrails(await this.generator.generate({ system: STATIC_PROMPT, prompt, channel: input.channel }), input.channel);
  }
}

export const hyperPersonalizationService = new HyperPersonalizationService();
