/**
 * Anti AI-slop lint for anything a prospect will read (messages, approach suggestions).
 * Deterministic: returns the reasons a text reads as generic/AI-written. Empty array = clean.
 */

const SLOP_PHRASES: Array<[RegExp, string]> = [
  [/\b(discover|unlock|game[- ]changing|revolutionary|seamless(ly)?|leverage|synergy|cutting[- ]edge|ai-powered|best-in-class|transformative|supercharge|empower|elevate|delve|robust solution)\b/i, 'jargão genérico (en)'],
  [/\b(in today'?s (fast[- ]paced|digital|competitive)|i hope (this|my) (email|message) finds you|just checking in|touching base|quick question)\b/i, 'abertura clichê (en)'],
  [/\b(revolucion\w*|alavanc\w*|potencializ\w*|sinergia|de ponta|inovador(a|es)?|transformador(a|es)?|disruptiv\w*|desbloque\w*|sem complica[çc][aã]o|solu[çc][aã]o completa|experi[eê]ncia (incr[ií]vel|única|perfeita)|levar (seu|sua|o seu|a sua) \w+ ao pr[oó]ximo n[ií]vel)\b/i, 'jargão genérico (pt)'],
  [/\b(espero que (esteja|estejam|você esteja) bem|no mundo (de hoje|atual|digital)|nos dias de hoje|venho por meio deste|gostaria de apresentar|passando para (saber|lembrar))\b/i, 'abertura clichê (pt)'],
  [/\b(n[aã]o [eé] (sobre|apenas|s[oó])|it'?s not (about|just)|not just\b)[^.!?]{0,80}([eé] sobre|mas (sim)?|it'?s about|but)\b/i, 'construção "não é X, é Y"'],
];

export function findSlop(text: string): string[] {
  const reasons: string[] = [];
  for (const [re, reason] of SLOP_PHRASES) if (re.test(text)) reasons.push(reason);
  if (/\{\{[^}]*\}\}|\[(nome|name|empresa|company|first ?name|cidade|city)\]|<(first_?name|company)>/i.test(text)) reasons.push('placeholder não preenchido');
  if ((text.match(/!/g) ?? []).length >= 3) reasons.push('excesso de exclamações');
  if ((text.match(/—/g) ?? []).length >= 2) reasons.push('excesso de travessões');
  if ((text.match(/\p{Extended_Pictographic}/gu) ?? []).length > 2) reasons.push('excesso de emojis');
  return reasons;
}

/** Numbers/percentages in `text` that never appear in `source`: likely invented metrics. Ignores 1-digit numbers. */
export function unsupportedNumbers(text: string, source: string): string[] {
  const sourceDigits = new Set((source.match(/\d+(?:[.,]\d+)?/g) ?? []).map(n => n.replace(',', '.')));
  return [...new Set((text.match(/\d+(?:[.,]\d+)?/g) ?? []).map(n => n.replace(',', '.')))]
    .filter(n => n.replace(/\D/g, '').length >= 2 && !sourceDigits.has(n));
}
