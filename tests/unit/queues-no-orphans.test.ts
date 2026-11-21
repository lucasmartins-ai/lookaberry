import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A queue nobody enqueues to only shows up as a zero on /health/queues and hides that a stage never runs
// (signal_ingestion_queue sat like that until it was removed).
const SRC = join(__dirname, '../../src');
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
});

// ponytail: known orphans with a worker but no producer yet; remove an entry once something enqueues to it.
const KNOWN_ORPHANS = new Set(['icpQueue', 'enrichmentQueue', 'outreachInboxQueue']);

describe('queues', () => {
  const queueFile = readFileSync(join(SRC, 'core/queues/queue.ts'), 'utf8');
  const declared = [...queueFile.matchAll(/export const (\w+) = new Queue\('(\w+)'/g)].map(m => ({ name: m[1], queue: m[2] }));
  const others = files(SRC).filter(f => !f.endsWith('core/queues/queue.ts') && !f.endsWith('api/routes/health.ts')).map(f => readFileSync(f, 'utf8'));

  it('signal_ingestion_queue is gone', () => {
    expect(declared.map(d => d.queue)).not.toContain('signal_ingestion_queue');
    expect(others.some(s => s.includes('signal_ingestion_queue'))).toBe(false);
  });

  it('every declared queue is used outside queue.ts and the health route', () => {
    expect(declared.length).toBeGreaterThan(0);
    const orphans = declared.filter(d => !KNOWN_ORPHANS.has(d.name) && !others.some(s => new RegExp(`\\b${d.name}\\b`).test(s)));
    expect(orphans).toEqual([]);
  });
});
