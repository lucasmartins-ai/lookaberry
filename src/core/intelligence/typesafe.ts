/**
 * TypeSafe System One (Jev) client for LookaBerry.
 *
 * Key resolution: process.env.TYPESAFE_API_KEY -> macOS Keychain (-s typesafe).
 * Ledger: shared with LOOKAORCHESTRATOR (logs/typesafe/jev.jsonl) so the daily
 * Jev feedback covers LookaBerry usage too; appends never throw. evaluate()
 * returns null on any failure so callers keep their own fallbacks.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevResponse {
  model: string;
  answers: Record<string, { type: string; [k: string]: unknown }>;
  usage?: { input_tokens: number; output_tokens: number };
}

const LEDGER_FILE =
  process.env.TYPESAFE_LEDGER_PATH ??
  path.join(os.homedir(), 'Downloads', 'LOOKAORCHESTRATOR', 'logs', 'typesafe', 'jev.jsonl');

let cachedKey: string | null | undefined;

function ledger(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // monitoring must never break a call
  }
}

export function resolveTypesafeKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  if (process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim().length > 0) {
    cachedKey = process.env.TYPESAFE_API_KEY.trim();
    return cachedKey;
  }
  try {
    const out = execSync('security find-generic-password -s "typesafe" -w', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 2500,
    }).trim();
    cachedKey = out.length > 0 ? out : null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

export function isJevEnabled(): boolean {
  return resolveTypesafeKey() !== null;
}

export async function jevEvaluate(args: {
  state: string | Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  feature: string;
  model?: string;
  timeoutMs?: number;
}): Promise<JevResponse | null> {
  const key = resolveTypesafeKey();
  const model = args.model ?? 'jev-latest';
  const stateChars =
    typeof args.state === 'string' ? args.state.length : JSON.stringify(args.state).length;
  if (!key) {
    ledger({
      ts: new Date().toISOString(),
      feature: args.feature,
      model,
      status: 'error',
      error: 'no api key',
      state_chars: stateChars,
    });
    return null;
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 12000);
  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, state: args.state, questions: args.questions }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      ledger({
        ts: new Date().toISOString(),
        feature: args.feature,
        model,
        status: 'error',
        http_status: res.status,
        error: errText.slice(0, 500),
        latency_ms: Date.now() - started,
        state_chars: stateChars,
      });
      return null;
    }

    const data = (await res.json()) as JevResponse;
    const answers: Record<string, unknown> = {};
    for (const [qid, a] of Object.entries(data.answers ?? {})) {
      const ans = a as any;
      answers[qid] =
        ans.type === 'choice'
          ? { choice: ans.choice, confidence: ans.confidence }
          : ans.type === 'score'
            ? { score: ans.score, confidence: ans.confidence }
            : { noul: ans.noul };
    }
    ledger({
      ts: new Date().toISOString(),
      feature: args.feature,
      model,
      status: 'ok',
      latency_ms: Date.now() - started,
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
      state_chars: stateChars,
      answers,
    });
    return data;
  } catch (err: any) {
    ledger({
      ts: new Date().toISOString(),
      feature: args.feature,
      model,
      status: 'error',
      error: `network: ${err?.message || err}`.slice(0, 300),
      latency_ms: Date.now() - started,
      state_chars: stateChars,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
