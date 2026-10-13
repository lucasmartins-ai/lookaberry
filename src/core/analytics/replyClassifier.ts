/**
 * One reply classifier for every channel (email, LinkedIn, WhatsApp, MCP feedback).
 * LLM when ANTHROPIC_API_KEY is set; otherwise a word-boundary heuristic (pt/en/es).
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/env.js';

export const REPLY_INTENTS = [
  'INTERESTED', 'MEETING', 'QUESTION', 'OBJECTION_PRICE', 'NOT_NOW',
  'WRONG_PERSON', 'NOT_INTERESTED', 'UNSUBSCRIBE', 'AUTO_REPLY', 'OTHER',
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];
export type ReplySentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'AMBIGUOUS';

export interface ReplyClassification {
  intent: ReplyIntent;
  sentiment: ReplySentiment;
  confidence: number; // 0-100
  source: 'llm' | 'heuristic';
}

const SENTIMENT_BY_INTENT: Record<ReplyIntent, ReplySentiment> = {
  INTERESTED: 'POSITIVE',
  MEETING: 'POSITIVE',
  QUESTION: 'NEUTRAL',
  OBJECTION_PRICE: 'NEUTRAL',
  NOT_NOW: 'NEUTRAL',
  WRONG_PERSON: 'NEUTRAL',
  NOT_INTERESTED: 'NEGATIVE',
  UNSUBSCRIBE: 'NEGATIVE',
  AUTO_REPLY: 'NEUTRAL',
  OTHER: 'AMBIGUOUS',
};

// Order matters: the first matching rule wins (opt-outs and refusals before positive words).
const RULES: Array<[ReplyIntent, RegExp]> = [
  ['AUTO_REPLY', /\b(out of (the )?office|auto(matic)?[- ]?reply|resposta autom[aá]tica|estou de f[eé]rias|fora do escrit[oó]rio|on (annual )?leave|ausente)\b/i],
  ['UNSUBSCRIBE', /\b(unsubscribe|opt[- ]?out|remove me|take me off|(please )?stop (sending|emailing|messaging|contacting)|please stop|do not contact|don'?t contact|descadastr\w*|remov(a|er)[- ]me|me remov\w*|n[aã]o (me )?(contate|mande|envie)|par(e|ar) de (enviar|mandar|me mandar|me enviar)|sair da lista|darme de baja)\b|^\s*(stop|parar|pare|sair)\s*[.!]*\s*$/i],
  ['NOT_INTERESTED', /\b(not interested|no thanks|no thank you|not a fit|we'?re (all )?set|n[aã]o (tenho|temos|estou|estamos) interess\w*|sem interesse|n[aã]o obrigad\w*|no me interesa|no gracias)\b/i],
  ['WRONG_PERSON', /\b(wrong person|not the right (person|contact)|no longer (work|with)|n[aã]o sou (eu|a pessoa)|pessoa errada|n[aã]o trabalho mais)\b/i],
  ['NOT_NOW', /\b(not (right )?now|maybe later|next (quarter|year|month)|reach out (later|in)|agora n[aã]o|mais pra frente|mais para frente|no momento n[aã]o|depois (a gente|conversamos))\b/i],
  ['OBJECTION_PRICE', /\b(too expensive|price|pricing|budget|cost|quanto custa|pre[cç]o|or[cç]amento|valor|caro)\b/i],
  ['MEETING', /\b(book a (call|meeting)|schedule|calendly|let'?s (talk|chat|meet|discuss)|set up a (call|meeting)|available (on|at|tomorrow)|agendar|marcar (uma )?(call|reuni[aã]o|conversa)|reuni[aã]o|podemos conversar)\b/i],
  ['INTERESTED', /\b(interested|sounds (good|great)|looks (good|great)|tell me more|send (me )?(more|details|info)|would love|happy to|tenho interesse|me interessa|pode (me )?(mandar|enviar)|quero saber mais|gostei|bora|me interesa)\b/i],
  ['QUESTION', /\?\s*$|\b(how does|what is|como funciona|o que [eé]|qual)\b/i],
  // Weak positive: a bare thank-you (refusals like "thanks but no thanks" matched earlier).
  ['INTERESTED', /\b(thanks|thank you|obrigad[oa]|valeu|gracias)\b/i],
];

export function classifyReplyHeuristic(content: string): ReplyClassification {
  const text = content.trim();
  for (const [intent, pattern] of RULES) {
    if (pattern.test(text)) {
      return { intent, sentiment: SENTIMENT_BY_INTENT[intent], confidence: 60, source: 'heuristic' };
    }
  }
  return { intent: 'OTHER', sentiment: 'AMBIGUOUS', confidence: 10, source: 'heuristic' };
}

const SYSTEM = `You classify replies to B2B outreach messages (any language). Return ONLY a JSON object:
{"intent": one of ${REPLY_INTENTS.join('|')}, "confidence": 0-100}
- UNSUBSCRIBE: asks to stop being contacted or to be removed (takes priority over everything else).
- NOT_INTERESTED: declines without asking to be removed.
- NOT_NOW: interested in principle but asks to come back later.
- MEETING: proposes or accepts a call/meeting. INTERESTED: positive, wants more information.
- AUTO_REPLY: out-of-office or automatic response. Be conservative with confidence.`;

export async function classifyReply(content: string): Promise<ReplyClassification> {
  const fallback = classifyReplyHeuristic(content);
  const apiKey = config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !content.trim()) return fallback;

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 2000, // room for adaptive thinking on current models
      system: SYSTEM,
      messages: [{ role: 'user', content: content.slice(0, 4000) }],
    });
    const text = response.content.find(block => block.type === 'text');
    const json = text && text.type === 'text' ? text.text.match(/\{[\s\S]*\}/)?.[0] : undefined;
    if (!json) return fallback;
    const parsed = JSON.parse(json) as { intent?: string; confidence?: number };
    const intent = REPLY_INTENTS.find(i => i === parsed.intent);
    if (!intent) return fallback;
    const confidence = Math.max(0, Math.min(100, Number(parsed.confidence ?? 0)));
    return { intent, sentiment: SENTIMENT_BY_INTENT[intent], confidence, source: 'llm' };
  } catch (err) {
    console.warn('[ReplyClassifier] LLM classification failed, using heuristic:', err instanceof Error ? err.message : String(err));
    return fallback;
  }
}
