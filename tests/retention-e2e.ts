/**
 * S15: End-to-End Retention Engine Verification
 *
 * Run: npx tsx tests/retention-e2e.ts
 * Requires: PostgreSQL 16 running on port 5433, Redis on 6379
 *
 * Verifies the full lifecycle:
 * 1. Ensure the LEAD retention policy exists with autoAnonymize=true
 * 2. Seed a test lead with a createdAt date far in the past
 * 3. Run the RetentionScheduler poll
 * 4. Verify the lead was anonymized (PII → SHA-256 hashes)
 * 5. Verify the audit trail entry was created
 */

import { prisma } from '../src/db/client.js';
import { RetentionScheduler } from '../src/core/execution/retentionScheduler.js';
import {
  getRetentionPolicy,
  updateRetentionPolicy,
  anonymizeLead,
  anonymizeField,
  type RetentionPolicy,
} from '../src/core/security/retention.js';

// ─────────────────────────── Helpers ───────────────────────────

const TEST_LEAD_ID = 'e2e00000-0000-0000-0000-00000000dead';
const TEST_COMPANY_ID = 'e2e00000-0000-0000-0000-00000000beef';
const TEST_CAMPAIGN_ID = 'e2e00000-0000-0000-0000-00000000cafe';
const TEST_ICP_ID = 'e2e00000-0000-0000-0000-00000000feed';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, extra?: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label} ${extra ? `— ${extra}` : ''}`);
    failed++;
  }
}

async function assert(label: string, fn: () => Promise<boolean> | boolean, extra?: string): Promise<void> {
  try {
    const result = await fn();
    ok(label, result, extra);
  } catch (err: any) {
    ok(label, false, `error: ${err.message}`);
  }
}

// ─────────────────────────── Main ───────────────────────────

async function main(): Promise<void> {
  console.log('🍓 S15 Retention Engine E2E Verification\n');
  console.log(`📅 Started: ${new Date().toISOString()}\n`);

  // ═══════════════════════════════════════════════════════════
  // 1. DB connectivity
  // ═══════════════════════════════════════════════════════════
  console.log('── 1. Database connectivity ──');
  await assert('PostgreSQL reachable', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  });
  console.log();

  // ═══════════════════════════════════════════════════════════
  // 2. Retention policy
  // ═══════════════════════════════════════════════════════════
  console.log('── 2. Retention policy ──');

  const db = prisma as any;

  // Enable auto-anonymize on LEAD with a short retention (1 day so the test lead qualifies)
  console.log('   Setting LEAD policy: autoAnonymize=true, retentionDays=1...');
  const policy = await updateRetentionPolicy(db, 'LEAD', {
    autoAnonymize: true,
    retentionDays: 1,
    description: 'E2E test policy — auto-anonymize after 1 day',
  }); // actor omitted — uses null/default

  ok('Policy autoAnonymize enabled', policy.autoAnonymize === true, String(policy.autoAnonymize));
  ok('Policy retentionDays = 1', policy.retentionDays === 1, String(policy.retentionDays));

  // Verify it's readable back
  const reread = await getRetentionPolicy(db, 'LEAD');
  ok('Policy readable back with correct values', reread.autoAnonymize && reread.retentionDays === 1);
  console.log();

  // ═══════════════════════════════════════════════════════════
  // 3. Seed test data
  // ═══════════════════════════════════════════════════════════
  console.log('── 3. Seed test data ──');

  const twoYearsAgo = new Date(Date.now() - 730 * 86_400_000);

  // Clean up any previous test data
  await db.idempotencyKey.deleteMany({ where: { leadId: TEST_LEAD_ID } }).catch(() => {});
  await db.leadSequenceState.deleteMany({ where: { leadId: TEST_LEAD_ID } }).catch(() => {});
  await db.outreachMessage.deleteMany({ where: { leadId: TEST_LEAD_ID } }).catch(() => {});
  await db.campaignMetric.deleteMany({ where: { campaignId: TEST_CAMPAIGN_ID } }).catch(() => {});
  await db.enrichmentLog.deleteMany({ where: { leadId: TEST_LEAD_ID } }).catch(() => {});
  await db.leadInteractionFeedback.deleteMany({ where: { leadId: TEST_LEAD_ID } }).catch(() => {});
  await db.intentSignal.deleteMany({ where: { companyId: TEST_COMPANY_ID } }).catch(() => {});
  await db.lead.deleteMany({ where: { id: TEST_LEAD_ID } }).catch(() => {});
  await db.company.deleteMany({ where: { id: TEST_COMPANY_ID } }).catch(() => {});
  await db.campaign.deleteMany({ where: { id: TEST_CAMPAIGN_ID } }).catch(() => {});
  await db.icpProfile.deleteMany({ where: { id: TEST_ICP_ID } }).catch(() => {});

  console.log('   Creating test ICP, Campaign, Company, Lead...');

  await db.icpProfile.create({
    data: {
      id: TEST_ICP_ID,
      name: 'E2E Test ICP',
      description: 'Test ICP for retention verification',
      targetIndustries: ['Software'],
      companySizeMin: 1,
      companySizeMax: 100,
      targetGeos: ['US'],
      techStackKeywords: ['TypeScript'],
      valuePropositions: [],
    },
  });

  await db.campaign.create({
    data: {
      id: TEST_CAMPAIGN_ID,
      icpId: TEST_ICP_ID,
      name: 'E2E Retention Test Campaign',
      isActive: false,
      dailyLimitLinkedin: 0,
      dailyLimitEmail: 0,
    },
  });

  await db.company.create({
    data: {
      id: TEST_COMPANY_ID,
      domain: 'retention-test.example.com',
      name: 'Retention Test Corp',
    },
  });

  await db.lead.create({
    data: {
      id: TEST_LEAD_ID,
      companyId: TEST_COMPANY_ID,
      firstName: 'Alice',
      lastName: 'Retention',
      fullName: 'Alice Retention',
      title: 'VP of Data Privacy',
      email: 'alice@retention-test.example.com',
      phone: '+15550009999',
      linkedinUrl: 'https://linkedin.com/in/alice-retention-test',
      location: 'San Francisco, CA',
      status: 'READY',
      createdAt: twoYearsAgo,
    },
  });

  // Verify seed
  const seeded = await db.lead.findUnique({
    where: { id: TEST_LEAD_ID },
    select: { id: true, firstName: true, email: true, createdAt: true, anonymizedAt: true },
  });

  ok('Lead seeded successfully', seeded !== null);
  ok('Lead has PII (firstName)', seeded?.firstName === 'Alice');
  ok('Lead has PII (email)', seeded?.email === 'alice@retention-test.example.com');
  ok('Lead not yet anonymized', seeded?.anonymizedAt === null);
  ok('Lead created 2 years ago', new Date(seeded?.createdAt).getFullYear() < 2026);
  console.log();

  // ═══════════════════════════════════════════════════════════
  // 4. Run retention scheduler
  // ═══════════════════════════════════════════════════════════
  console.log('── 4. Run retention scheduler ──');

  const retentionScheduler = new RetentionScheduler(100); // 100ms interval (we only poll once)
  const result = await retentionScheduler.poll();

  ok('Scheduler polled successfully', true);
  ok(`Leads anonymized: ${result.anonymized}`, result.anonymized >= 1, `expected >= 1, got ${result.anonymized}`);
  if (result.errors.length > 0) {
    console.log(`   ⚠️  ${result.errors.length} error(s): ${result.errors.join('; ')}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════
  // 5. Verify anonymization
  // ═══════════════════════════════════════════════════════════
  console.log('── 5. Verify anonymization ──');

  const anonLead = await db.lead.findUnique({
    where: { id: TEST_LEAD_ID },
  });

  ok('Lead still exists after anonymization', anonLead !== null);

  if (anonLead) {
    ok('firstName is anon_ hash', typeof anonLead.firstName === 'string' && anonLead.firstName.startsWith('anon_'),
      `got: ${anonLead.firstName?.slice(0, 20)}`);
    ok('lastName is anon_ hash', typeof anonLead.lastName === 'string' && anonLead.lastName!.startsWith('anon_'),
      `got: ${anonLead.lastName?.slice(0, 20)}`);
    ok('fullName is anon_ hash', typeof anonLead.fullName === 'string' && anonLead.fullName.startsWith('anon_'),
      `got: ${anonLead.fullName?.slice(0, 20)}`);
    ok('email is anon_ hash', typeof anonLead.email === 'string' && anonLead.email!.startsWith('anon_'),
      `got: ${anonLead.email?.slice(0, 20)}`);
    ok('phone is anon_ hash', typeof anonLead.phone === 'string' && anonLead.phone!.startsWith('anon_'),
      `got: ${anonLead.phone?.slice(0, 20)}`);
    ok('linkedinUrl is anon_ hash', typeof anonLead.linkedinUrl === 'string' && anonLead.linkedinUrl!.startsWith('anon_'),
      `got: ${anonLead.linkedinUrl?.slice(0, 20)}`);
    ok('title is anon_ hash', typeof anonLead.title === 'string' && anonLead.title.startsWith('anon_'),
      `got: ${anonLead.title?.slice(0, 20)}`);
    ok('location is anon_ hash', typeof anonLead.location === 'string' && anonLead.location!.startsWith('anon_'),
      `got: ${anonLead.location?.slice(0, 20)}`);
    ok('anonymizedAt is set', anonLead.anonymizedAt instanceof Date);
    ok('anonymizedAt is recent (within 5 min)', Date.now() - new Date(anonLead.anonymizedAt!).getTime() < 300_000);

    // Verify deterministic hashing (same input = same hash)
    const expectedEmail = anonymizeField('alice@retention-test.example.com');
    ok('Email hash is deterministic', anonLead.email === expectedEmail,
      `expected ${expectedEmail.slice(0, 20)}, got ${anonLead.email?.slice(0, 20)}`);

    // Verify metadata was cleared
    ok('metadata set to anonymized flag',
      typeof anonLead.metadata === 'object' && (anonLead.metadata as any)?.anonymized === true);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════
  // 6. Verify audit trail
  // ═══════════════════════════════════════════════════════════
  console.log('── 6. Verify audit trail ──');

  await assert('Audit entry created for anonymization', async () => {
    const entry = await db.auditLog.findFirst({
      where: { action: 'DATA_ANONYMIZED', targetId: TEST_LEAD_ID },
      orderBy: { createdAt: 'desc' },
    });
    return entry !== null;
  });

  await assert('Audit entry has actorId=null (system action)', async () => {
    const entry = await db.auditLog.findFirst({
      where: { action: 'DATA_ANONYMIZED', targetId: TEST_LEAD_ID },
      orderBy: { createdAt: 'desc' },
    });
    return entry?.actorId === null;
  });

  await assert('Policy update audit entry created', async () => {
    const entry = await db.auditLog.findFirst({
      where: { action: 'CONFIG_CHANGED', targetId: 'LEAD' },
      orderBy: { createdAt: 'desc' },
    });
    return entry !== null;
  });
  console.log();

  // ═══════════════════════════════════════════════════════════
  // 7. Cleanup
  // ═══════════════════════════════════════════════════════════
  console.log('── 7. Cleanup ──');

  // Restore the retention policy to safe defaults
  await updateRetentionPolicy(db, 'LEAD', {
    autoAnonymize: false,
    retentionDays: 730,
    description: 'Restored after E2E test',
  }); // actor omitted

  ok('Policy restored to safe defaults', true);

  // Delete test data
  await db.leadInteractionFeedback.deleteMany({ where: { leadId: TEST_LEAD_ID } }).catch(() => {});
  await db.enrichmentLog.deleteMany({ where: { leadId: TEST_LEAD_ID } }).catch(() => {});
  await db.outreachMessage.deleteMany({ where: { leadId: TEST_LEAD_ID } }).catch(() => {});
  await db.leadSequenceState.deleteMany({ where: { leadId: TEST_LEAD_ID } }).catch(() => {});
  await db.idempotencyKey.deleteMany({ where: { leadId: TEST_LEAD_ID } }).catch(() => {});
  await db.lead.deleteMany({ where: { id: TEST_LEAD_ID } }).catch(() => {});
  await db.company.deleteMany({ where: { id: TEST_COMPANY_ID } }).catch(() => {});
  await db.campaign.deleteMany({ where: { id: TEST_CAMPAIGN_ID } }).catch(() => {});
  await db.icpProfile.deleteMany({ where: { id: TEST_ICP_ID } }).catch(() => {});

  ok('Test data cleaned up', true);
  console.log();

  // ═══════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════
  const total = passed + failed;
  console.log('═══════════════════════════════════════════');
  console.log(`  Results: ${passed}/${total} passed`);
  if (failed > 0) {
    console.log(`           ${failed} FAILED`);
    process.exit(1);
  } else {
    console.log('  ✅ All checks passed!');
  }
  console.log('═══════════════════════════════════════════');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  prisma.$disconnect().finally(() => process.exit(1));
});