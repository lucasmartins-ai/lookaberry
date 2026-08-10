import { prisma } from '../src/db/client.js';
import { initVectorExtension, setIcpProfileEmbedding, setCompanyEmbedding } from '../src/db/pgvector.js';
import { generateDeterministicEmbedding } from '../src/core/icp/embeddings.js';

async function seed() {
  console.log('🌱 Starting LookaBerry Database Seed...');

  // Ensure pgvector extension and indexes are ready
  await initVectorExtension();

  // 1. Clean existing seed data
  console.log('🧹 Cleaning old test records...');
  await prisma.leadInteractionFeedback.deleteMany();
  await prisma.campaignMetric.deleteMany();
  await prisma.outreachMessage.deleteMany();
  await prisma.sequenceStep.deleteMany();
  await prisma.outreachSequence.deleteMany();
  await prisma.outreachAccount.deleteMany();
  await prisma.enrichmentLog.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.intentSignal.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.icpPersona.deleteMany();
  await prisma.icpProfile.deleteMany();
  await prisma.company.deleteMany();

  // 2. Create ICP Profile
  console.log('🎯 Creating Demo ICP Profile...');
  const icpProfile = await prisma.icpProfile.create({
    data: {
      name: 'B2B SaaS Growth & AI Outbound',
      websiteUrl: 'https://lookaberry.dev',
      description: 'Ideal customer profile targeting high-growth B2B SaaS companies seeking autonomous AI-driven outbound engines.',
      targetIndustries: ['Software', 'Information Technology', 'Artificial Intelligence', 'B2B SaaS'],
      companySizeMin: 10,
      companySizeMax: 1000,
      targetGeos: ['US', 'LATAM', 'BR', 'EMEA'],
      techStackKeywords: ['PostgreSQL', 'TypeScript', 'Node.js', 'Fastify', 'OpenAI', 'Anthropic'],
      valuePropositions: [
        'Zero token-waste hybrid lead ranking with pgvector',
        'Autonomous waterfall enrichment with verified deliverability',
        'Hyper-personalized contextual outreach with Anthropic prompt caching'
      ],
      personas: {
        create: [
          {
            jobTitles: ['VP of Sales', 'Head of Revenue', 'CRO'],
            seniorityLevels: ['VP', 'C-Level'],
            responsibilities: 'Oversees pipeline generation, sales operations and outbound conversion efficiency.',
            priorityScore: 90
          },
          {
            jobTitles: ['Chief Technology Officer', 'VP of Engineering'],
            seniorityLevels: ['C-Level', 'VP'],
            responsibilities: 'Maintains tech stack, reduces token expenditure, integrates AI agents and infrastructure.',
            priorityScore: 85
          },
          {
            jobTitles: ['Head of Growth', 'Director of Demand Generation'],
            seniorityLevels: ['Director', 'Head'],
            responsibilities: 'Drives outbound strategy, intent signal capture, and multichannel cadence testing.',
            priorityScore: 80
          }
        ]
      }
    }
  });

  const icpText = `${icpProfile.name} ${icpProfile.description} ${icpProfile.targetIndustries.join(' ')}`;
  await setIcpProfileEmbedding(icpProfile.id, generateDeterministicEmbedding(icpText));
  console.log(`✅ ICP Profile created: ${icpProfile.name} (${icpProfile.id})`);

  // 3. Create Sample Target Companies
  console.log('🏢 Creating Target Companies...');
  const company1 = await prisma.company.create({
    data: {
      domain: 'cloudpulse.io',
      name: 'CloudPulse Analytics',
      linkedinUrl: 'https://linkedin.com/company/cloudpulse-io',
      employeeCount: 140,
      industry: 'Software',
      country: 'US',
      techStack: ['PostgreSQL', 'React', 'AWS', 'Kubernetes', 'TypeScript'],
      description: 'Real-time observability and cloud infrastructure analytics platform for modern engineering teams.',
      icpFitScore: 88.5
    }
  });
  await setCompanyEmbedding(company1.id, generateDeterministicEmbedding(`${company1.name} ${company1.industry} ${company1.description}`));

  const company2 = await prisma.company.create({
    data: {
      domain: 'fintechflow.com.br',
      name: 'FintechFlow Brasil',
      linkedinUrl: 'https://linkedin.com/company/fintechflow-br',
      employeeCount: 85,
      industry: 'Financial Technology',
      country: 'BR',
      techStack: ['Node.js', 'PostgreSQL', 'GCP', 'Docker'],
      description: 'API-first banking and payment infrastructure powering high-volume digital transactions.',
      icpFitScore: 78.0
    }
  });
  await setCompanyEmbedding(company2.id, generateDeterministicEmbedding(`${company2.name} ${company2.industry} ${company2.description}`));

  // 4. Create Intent Signals
  console.log('📡 Creating Intent Signals...');
  const signal1 = await prisma.intentSignal.create({
    data: {
      companyId: company1.id,
      signalType: 'HIRING',
      source: 'LinkedIn Talent Insights',
      title: 'CloudPulse is actively hiring 4 Senior Account Executives and a Head of Outbound',
      summary: 'CloudPulse opened multiple outbound sales positions indicating aggressive pipeline scaling for Q3.',
      intentWeight: 85.0,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      isActive: true,
      rawPayload: { positions: ['Senior Account Executive', 'Head of Outbound'], department: 'Sales' }
    }
  });

  const signal2 = await prisma.intentSignal.create({
    data: {
      companyId: company2.id,
      signalType: 'FUNDING',
      source: 'Crunchbase',
      title: 'FintechFlow Brasil raises $12M Series A to expand outbound sales team',
      summary: 'FintechFlow announced Series A funding led by top VC to expand commercial operations in LATAM.',
      intentWeight: 90.0,
      expiresAt: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
      isActive: true,
      rawPayload: { round: 'Series A', amount: 12000000, currency: 'USD' }
    }
  });

  // 5. Create Sample Leads
  console.log('👤 Creating Leads...');
  const lead1 = await prisma.lead.create({
    data: {
      companyId: company1.id,
      firstName: 'Sarah',
      lastName: 'Connor',
      fullName: 'Sarah Connor',
      title: 'VP of Sales',
      seniority: 'VP',
      linkedinUrl: 'https://linkedin.com/in/sarah-connor-cloudpulse',
      email: 'sarah.connor@cloudpulse.io',
      emailStatus: 'VERIFIED',
      location: 'San Francisco, CA',
      icpScore: 88.5,
      intentScore: 85.0,
      totalPriorityScore: 86.4,
      status: 'READY'
    }
  });

  const lead2 = await prisma.lead.create({
    data: {
      companyId: company2.id,
      firstName: 'Lucas',
      lastName: 'Silva',
      fullName: 'Lucas Silva',
      title: 'Chief Technology Officer',
      seniority: 'C-Level',
      linkedinUrl: 'https://linkedin.com/in/lucas-silva-fintechflow',
      email: 'lucas.silva@fintechflow.com.br',
      emailStatus: 'VERIFIED',
      location: 'São Paulo, Brasil',
      icpScore: 78.0,
      intentScore: 90.0,
      totalPriorityScore: 85.2,
      status: 'READY'
    }
  });

  // 6. Create Demo Campaign
  console.log('🚀 Creating Outbound Campaign...');
  const campaign = await prisma.campaign.create({
    data: {
      icpId: icpProfile.id,
      name: 'Q3 Enterprise AI Outbound Pilot',
      isActive: true,
      dailyLimitLinkedin: 25,
      dailyLimitEmail: 60,
      steps: {
        create: [
          {
            stepOrder: 0,
            channel: 'LINKEDIN_CONNECT',
            delayHours: 0,
            promptTemplate: 'Short connection hook based on hiring signal {{signal.summary}}'
          },
          {
            stepOrder: 1,
            channel: 'EMAIL',
            delayHours: 24,
            promptTemplate: 'Direct value proposition email linking hiring pain with LookaBerry automation'
          }
        ]
      }
    }
  });

  // 7. Create Demo Outreach Account
  await prisma.outreachAccount.create({
    data: {
      provider: 'SMARTLEAD',
      externalId: 'acc_demo_email_01',
      channel: 'EMAIL',
      dailyLimit: 100,
      sentToday: 12,
      quotaDate: new Date()
    }
  });

  // 8. Create Demo Campaign Metric
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  await prisma.campaignMetric.create({
    data: {
      campaignId: campaign.id,
      metricDate: today,
      sentCount: 45,
      openCount: 28,
      clickCount: 12,
      replyCount: 6,
      bounceCount: 1,
      positiveReplies: 4,
      negativeReplies: 1
    }
  });

  console.log('\n======================================================');
  console.log('🎉 LookaBerry Database Seeded Successfully!');
  console.log(`- ICP Profile ID: ${icpProfile.id}`);
  console.log(`- Campaign ID:    ${campaign.id}`);
  console.log(`- Sample Leads:   ${lead1.fullName} (${lead1.id}), ${lead2.fullName} (${lead2.id})`);
  console.log(`- Sinais Ativos:  ${signal1.title}, ${signal2.title}`);
  console.log('======================================================\n');
}

seed()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
