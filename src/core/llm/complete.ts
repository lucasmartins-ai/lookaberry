/**
 * Optional server-side LLM. LookaBerry is a tool for the person's own agent (Claude Code,
 * Hermes, Codex, Cursor…): by default (LLM_MODE=agent) nothing here calls an API and MCP
 * tools hand the writing/analysis to the calling agent instead.
 *
 * LLM_MODE=server enables, in order: ANTHROPIC_API_KEY (official SDK), then any
 * OpenAI-compatible endpoint the person already has (LLM_BASE_URL + LLM_MODEL: OpenAI,
 * OpenRouter, LM Studio, Ollama, MLX…).
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../../config/env.js';

export type ServerLlm = 'anthropic' | 'openai-compatible' | null;

export function serverLlm(): ServerLlm {
  if (config.LLM_MODE !== 'server') return null;
  if (config.ANTHROPIC_API_KEY) return 'anthropic';
  if (config.LLM_BASE_URL && config.LLM_MODEL) return 'openai-compatible';
  return null;
}

/** Thrown by server-only paths in agent mode; MCP tools turn it into a brief for the agent. */
export class AgentModeError extends Error {
  constructor(message = 'No server-side LLM (LLM_MODE=agent): the calling agent does this step') {
    super(message);
    this.name = 'AgentModeError';
  }
}

/** Text completion from the configured server LLM, or null in agent mode / on failure. */
export async function completeText(params: { system: string; prompt: string; maxTokens?: number }): Promise<string | null> {
  const llm = serverLlm();
  if (!llm) return null;
  try {
    if (llm === 'anthropic') {
      const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: params.maxTokens ?? 4000, // room for adaptive thinking on current models
        system: params.system,
        messages: [{ role: 'user', content: params.prompt }],
      });
      const text = response.content.find(block => block.type === 'text');
      return text && text.type === 'text' ? text.text : null;
    }
    const client = new OpenAI({ apiKey: config.LLM_API_KEY || 'not-needed', baseURL: config.LLM_BASE_URL });
    const completion = await client.chat.completions.create({
      model: config.LLM_MODEL,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.prompt },
      ],
    });
    return completion.choices[0]?.message?.content ?? null;
  } catch (err) {
    console.warn(`[LLM] ${llm} completion failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** First {...} block of a model reply, parsed; null if absent or invalid. */
export function parseJsonObject<T>(text: string | null): T | null {
  const json = text?.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
