/**
 * Create a LookaBerry API key directly in the database (no admin key needed — this runs on
 * the machine that owns the DB).
 *
 *   npx tsx scripts/create-api-key.ts --name lookaorchestrator-sync --permission OPERATOR \
 *     --write-env ~/Downloads/LOOKAORCHESTRATOR/.env
 *
 * With --write-env the key is written as LOOKABERRY_API_KEY=... into that file (replacing an
 * existing line) and never printed. Without it, the key is printed once — store it right away.
 * Keys are created without TOTP: they are meant for machine clients.
 */

import fs from 'node:fs';
import os from 'node:os';
import { prisma } from '../src/db/client.js';
import { createApiKey, type ApiKeyPermission, type ApiKeyStoreFull } from '../src/core/security/apiKeys.js';

const PERMISSIONS: ApiKeyPermission[] = ['ADMIN', 'OPERATOR', 'VIEWER', 'CAMPAIGN_MANAGER'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Replace or append KEY=value in a dotenv file, keeping every other line as is. */
export function upsertEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content}${content === '' || content.endsWith('\n') ? '' : '\n'}${line}\n`;
}

async function main() {
  const name = arg('name') ?? 'lookaorchestrator-sync';
  const permission = (arg('permission') ?? 'OPERATOR').toUpperCase() as ApiKeyPermission;
  if (!PERMISSIONS.includes(permission)) throw new Error(`--permission must be one of ${PERMISSIONS.join(', ')}`);
  const envPath = arg('write-env')?.replace(/^~(?=\/)/, os.homedir());

  const { record, plainKey } = await createApiKey(prisma as unknown as ApiKeyStoreFull, { name, permission }, { userId: undefined });

  if (envPath) {
    const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    fs.writeFileSync(envPath, upsertEnvLine(current, 'LOOKABERRY_API_KEY', plainKey), { mode: 0o600 });
    console.log(`Created ${permission} key "${name}" (id ${record.id}, ${plainKey.slice(0, 6)}…) and wrote LOOKABERRY_API_KEY to ${envPath}`);
  } else {
    console.log(`Created ${permission} key "${name}" (id ${record.id}). Shown once, store it now:\n${plainKey}`);
  }
}

if (process.argv[1]?.endsWith('create-api-key.ts')) {
  main()
    .catch(err => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
