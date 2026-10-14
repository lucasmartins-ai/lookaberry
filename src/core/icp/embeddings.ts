import OpenAI from 'openai';
import { config } from '../../config/env.js';
import crypto from 'crypto';

/**
 * Embeddings without depending on any API.
 *
 * - lexical (default when nothing is configured): local feature-hashed bag of words +
 *   bigrams. No network, no key; texts that share vocabulary end up close, so ICP fit and
 *   lookalikes work out of the box.
 * - openai-compatible: any endpoint the person already runs or pays for (LM Studio,
 *   Ollama, MLX, OpenRouter…) via EMBEDDINGS_BASE_URL / EMBEDDINGS_MODEL.
 * - openai: OPENAI_API_KEY.
 *
 * Every vector is stored with its model label; vectors are only compared within one label.
 */

export const EMBEDDING_DIMENSION = 1536;
export const SEMANTIC_EMBEDDING_MODEL = 'text-embedding-3-small';
export const LEXICAL_EMBEDDING_MODEL = 'lexical-v2';
/** Legacy random fallback; vectors with this label are never compared for ICP fit. */
export const HASH_EMBEDDING_MODEL = 'hash-sha256-v1';

/**
 * Deterministic pseudo-random normalized vector (legacy, non-semantic). Kept for fixtures.
 */
export function generateDeterministicEmbedding(text: string, dimensions = EMBEDDING_DIMENSION): number[] {
  const hash = crypto.createHash('sha256').update(text).digest();
  const vector: number[] = new Array(dimensions);
  let seed = hash.readUInt32LE(0);
  function nextRand() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return (seed / 4294967296) * 2 - 1;
  }
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    const val = nextRand();
    vector[i] = val;
    sumSq += val * val;
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < dimensions; i++) vector[i] = Number((vector[i] / norm).toFixed(6));
  return vector;
}

const STOPWORDS = new Set((
  'a an and are as at be by for from has have in is it its of on or that the this to was were will with we you your our ' +
  'de da do das dos e em no na nos nas o os as um uma para por com que se ao aos sua seu suas seus mais como ' +
  'el la los las y en un una por con del al su ' +
  // contact-card / address boilerplate (scraped listings): carries no business meaning
  'localizacao location endereco address telefone phone tel comercial categoria nicho category niche ' +
  'av avenida rua street st road rd cep postcode zip centro brasil brazil uk'
).split(' '));

/**
 * pt/en (and some es) concept map: words for the same business concept collapse to one token,
 * so "clínica odontológica" (pt) and "dental clinic" (en) land close without any API.
 * Order matters: first match wins. Patterns run on lowercased, accent-stripped tokens.
 */
const CONCEPTS: Array<[string, RegExp]> = [
  ['dental', /^(odont|dent[aie]|dentist|ortodont|orthodont)/],
  ['clinic', /^(clinic|clinica|consultorio|practice$|practices$)/],
  ['physio', /^(fisio|physio|osteopat|quiropra|chiropract)/],
  ['vet', /^(vet$|vets$|veterin|petshop|pet$|pets$)/],
  ['health', /^(saude|health|medic|hospital)/],
  ['beauty', /^(estetic|aesthetic|beauty|beleza|salao|salon|spa$)/],
  ['barber', /^barb/],
  ['booking', /^(agend|booking|appointment|schedul|marcac|reserva|reservation|agenda$)/],
  ['customer_service', /^(atendiment|recepc|reception|frontdesk|suporte|support$)/],
  ['messaging', /^(whatsapp|mensag|messag|sms$|chat$|chats$|dm$)/],
  ['automation', /^(automac|automat|automatiz)/],
  ['software', /^(software|sistema|system|plataforma|platform|aplicativo|app$|apps$)/],
  ['ai', /^(ia$|ai$|inteligencia|intelligence|llm|gpt)/],
  ['sales', /^(venda|sales$|sale$|vendedor|comercial|commercial|selling)/],
  ['real_estate', /^(imobiliar|imovel|imoveis|corretor|realtor|realestate|broker|property|properties)/],
  ['client', /^(client|cliente|paciente|patient|customer)/],
  ['education', /^(curso|course|aula|lesson|educac|education|escola|school)/],
  ['website', /^(site$|sites$|website)/],
  ['team', /^(equipe|team)/],
];

function concept(token: string): string {
  for (const [name, pattern] of CONCEPTS) if (pattern.test(token)) return name;
  return token;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t) && !/\d/.test(t)) // numbers: phones, CEPs, street numbers
    .map(concept);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Local lexical embedding: hashed concept-mapped unigrams + unordered bigrams, sublinear tf, signed, L2-normalized. */
export function generateLexicalEmbedding(text: string, dimensions = EMBEDDING_DIMENSION): number[] {
  const words = tokens(text);
  const counts = new Map<string, number>();
  words.forEach((w, i) => {
    counts.set(w, (counts.get(w) ?? 0) + 1);
    if (i > 0) {
      // order-insensitive bigram: "clínica odontológica" (pt) and "dental clinic" (en) share it
      const pair = [words[i - 1]!, w].sort().join('_');
      counts.set(pair, (counts.get(pair) ?? 0) + 0.5);
    }
  });
  const vector = new Array(dimensions).fill(0);
  for (const [term, tf] of counts) {
    const h = fnv1a(term);
    vector[h % dimensions] += (h & 0x80000000 ? -1 : 1) * (1 + Math.log(tf + 1));
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map(v => Number((v / norm).toFixed(6)));
}

/** Fit any provider's vector into the vector(1536) column; zero-padding keeps cosine intact. */
function toDimension(v: number[]): number[] {
  if (v.length === EMBEDDING_DIMENSION) return v;
  if (v.length > EMBEDDING_DIMENSION) return v.slice(0, EMBEDDING_DIMENSION);
  return [...v, ...new Array(EMBEDDING_DIMENSION - v.length).fill(0)];
}

type Provider = 'lexical' | 'openai-compatible' | 'openai';

export function resolveEmbeddingProvider(): Provider {
  if (config.EMBEDDINGS_PROVIDER !== 'auto') return config.EMBEDDINGS_PROVIDER;
  if (config.EMBEDDINGS_BASE_URL) return 'openai-compatible';
  if (config.OPENAI_API_KEY) return 'openai';
  return 'lexical';
}

/** The label vectors from the active provider are stored under. */
export function currentEmbeddingModel(): string {
  const provider = resolveEmbeddingProvider();
  if (provider === 'openai') return SEMANTIC_EMBEDDING_MODEL;
  if (provider === 'openai-compatible') return `compat:${config.EMBEDDINGS_MODEL || 'default'}`;
  return LEXICAL_EMBEDDING_MODEL;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  return (await generateEmbeddingWithModel(text)).embedding;
}

/** Embed with the active provider; on any provider failure fall back to lexical (never to noise). */
export async function generateEmbeddingWithModel(text: string): Promise<{ embedding: number[]; model: string }> {
  const sanitizedText = text.replace(/\s+/g, ' ').trim().slice(0, 8000);
  const provider = resolveEmbeddingProvider();

  if (provider !== 'lexical') {
    try {
      const client = provider === 'openai'
        ? new OpenAI({ apiKey: config.OPENAI_API_KEY })
        : new OpenAI({ apiKey: config.EMBEDDINGS_API_KEY || 'not-needed', baseURL: config.EMBEDDINGS_BASE_URL });
      const response = await client.embeddings.create({
        model: provider === 'openai' ? SEMANTIC_EMBEDDING_MODEL : (config.EMBEDDINGS_MODEL || 'default'),
        input: sanitizedText,
        ...(provider === 'openai' ? { dimensions: EMBEDDING_DIMENSION } : {}),
      });
      const vector = response.data?.[0]?.embedding;
      if (vector?.length) return { embedding: toDimension(vector), model: currentEmbeddingModel() };
    } catch (err: any) {
      console.warn(`Embedding provider ${provider} failed: ${err.message}. Using local lexical embeddings...`);
    }
  }

  return { embedding: generateLexicalEmbedding(sanitizedText), model: LEXICAL_EMBEDDING_MODEL };
}
