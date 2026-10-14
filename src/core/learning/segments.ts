/**
 * Canonical segments so the orchestrator's free-text industries ("dental",
 * "Odontologia / Saúde Privada", "health_clinic") and LookaBerry's company.industry
 * land in the same bucket. First match wins (most specific first).
 */
const RULES: Array<[string, RegExp]> = [
  ['dental', /dent|odont/i],
  ['physio', /physio|fisio|osteopat|chiropract|quiropr/i],
  ['vet', /\bvet|veterin|pet\b|animal/i],
  ['barbershop', /barber|barbearia/i],
  ['beauty', /salon|sal[aã]o|beauty|beleza|est[eé]tic|spa\b|nail|hair/i],
  ['health_clinic', /clinic|cl[ií]nica|health|sa[uú]de|medic|m[eé]dic|hospital|therap|terap/i],
  ['agency', /agency|ag[eê]ncia|marketing|advertis|publicidade|digital studio/i],
  ['saas', /saas|software|tech|startup|platform/i],
  ['legal', /law|legal|advoca|jur[ií]dic/i],
  ['real_estate', /real estate|imobili|property/i],
  ['restaurant', /restaurant|restaurante|food|caf[eé]|bar\b/i],
];

export function normalizeSegment(raw?: string | null): string {
  const text = (raw ?? '').trim();
  if (!text) return 'unknown';
  for (const [segment, pattern] of RULES) if (pattern.test(text)) return segment;
  return 'other';
}
