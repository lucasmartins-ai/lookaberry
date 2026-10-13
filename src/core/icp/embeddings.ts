import OpenAI from 'openai';
import { config } from '../../config/env.js';
import crypto from 'crypto';

export const EMBEDDING_DIMENSION = 1536;
export const SEMANTIC_EMBEDDING_MODEL = 'text-embedding-3-small';
/** Label for the non-semantic fallback; vectors with this label are never compared for ICP fit. */
export const HASH_EMBEDDING_MODEL = 'hash-sha256-v1';

/**
 * Deterministic pseudo-random normalized 1536-dim vector generator for offline/fallback use
 */
export function generateDeterministicEmbedding(text: string, dimensions = EMBEDDING_DIMENSION): number[] {
  const hash = crypto.createHash('sha256').update(text).digest();
  const vector: number[] = new Array(dimensions);

  let seed = hash.readUInt32LE(0);
  // Simple linear congruential generator for reproducible numbers
  function nextRand() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return (seed / 4294967296) * 2 - 1; // Range -1 to 1
  }

  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    const val = nextRand();
    vector[i] = val;
    sumSq += val * val;
  }

  // Normalize to unit length (L2 norm) so cosine distance <=> works identically
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < dimensions; i++) {
    vector[i] = Number((vector[i] / norm).toFixed(6));
  }

  return vector;
}

/**
 * Generates 1536-dim vector embedding using OpenAI text-embedding-3-small or deterministic fallback
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  return (await generateEmbeddingWithModel(text)).embedding;
}

/** Same as generateEmbedding, but also says which model produced the vector (store it next to the vector). */
export async function generateEmbeddingWithModel(text: string): Promise<{ embedding: number[]; model: string }> {
  const sanitizedText = text.replace(/\s+/g, ' ').trim().slice(0, 8000);

  if (config.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
      const response = await openai.embeddings.create({
        model: SEMANTIC_EMBEDDING_MODEL,
        input: sanitizedText,
        dimensions: EMBEDDING_DIMENSION,
      });

      if (response.data?.[0]?.embedding) {
        return { embedding: response.data[0].embedding, model: SEMANTIC_EMBEDDING_MODEL };
      }
    } catch (err: any) {
      console.warn(`OpenAI embedding failed: ${err.message}. Using deterministic vector generator...`);
    }
  }

  return { embedding: generateDeterministicEmbedding(sanitizedText, EMBEDDING_DIMENSION), model: HASH_EMBEDDING_MODEL };
}
