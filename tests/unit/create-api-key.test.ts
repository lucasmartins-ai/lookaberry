import { describe, expect, it } from 'vitest';
import { upsertEnvLine } from '../../scripts/create-api-key.js';

describe('upsertEnvLine', () => {
  it('replaces an existing key and keeps every other line', () => {
    const env = 'META_TOKEN=abc\nLOOKABERRY_API_KEY=old\nOTHER=1\n';
    expect(upsertEnvLine(env, 'LOOKABERRY_API_KEY', 'new')).toBe('META_TOKEN=abc\nLOOKABERRY_API_KEY=new\nOTHER=1\n');
  });

  it('appends when missing, adding a newline if the file lacks one', () => {
    expect(upsertEnvLine('A=1', 'LOOKABERRY_API_KEY', 'k')).toBe('A=1\nLOOKABERRY_API_KEY=k\n');
    expect(upsertEnvLine('', 'LOOKABERRY_API_KEY', 'k')).toBe('LOOKABERRY_API_KEY=k\n');
  });
});
