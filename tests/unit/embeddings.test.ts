import { describe, it, expect } from 'vitest';
import { generateDeterministicEmbedding, generateEmbedding, EMBEDDING_DIMENSION } from '../../src/core/icp/embeddings.js';

describe('Embedding Engine', () => {
  it('should generate a 1536-dimensional vector', async () => {
    const vector = await generateEmbedding('B2B Outbound GTM software with pgvector');
    expect(Array.isArray(vector)).toBe(true);
    expect(vector.length).toBe(EMBEDDING_DIMENSION);
  });

  it('should generate normalized unit vectors deterministically', () => {
    const text1 = 'LookaBerry AI Outbound';
    const text2 = 'LookaBerry AI Outbound';
    const text3 = 'Completely different topic about gardening';

    const v1 = generateDeterministicEmbedding(text1);
    const v2 = generateDeterministicEmbedding(text2);
    const v3 = generateDeterministicEmbedding(text3);

    expect(v1.length).toBe(1536);
    expect(v1).toEqual(v2);
    expect(v1).not.toEqual(v3);

    // Verify Euclidean norm is approximately 1.0
    const norm = Math.sqrt(v1.reduce((sum, val) => sum + val * val, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });
});
