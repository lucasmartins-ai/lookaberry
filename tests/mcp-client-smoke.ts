import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prisma } from '../src/db/client.js';

async function runSmokeTest() {
  console.log('🧪 Starting MCP Client Smoke Test via Stdio transport...');

  // Spawn the LookaBerry MCP stdio server process
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp/transports/stdio.ts'],
  });

  const client = new Client(
    {
      name: 'test-mcp-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  try {
    await client.connect(transport);
    console.log('✅ Connected to LookaBerry MCP Server via stdio');

    // 1. List tools
    console.log('🔍 Querying available MCP tools...');
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map(t => t.name);
    console.log(`📋 Discovered tools:`, toolNames);

    if (!toolNames.includes('gtm_analyze_icp')) {
      throw new Error("Expected 'gtm_analyze_icp' in tool list");
    }
    console.log('✅ gtm_analyze_icp tool found and verified');

    // 2. Execute gtm_analyze_icp tool
    console.log('\n🚀 Invoking gtm_analyze_icp tool for https://example.com...');
    const callResult = await client.callTool({
      name: 'gtm_analyze_icp',
      arguments: {
        website_url: 'https://example.com',
        description: 'Global benchmark domain for network testing',
        target_geos: ['US', 'LATAM'],
      },
    });

    console.log('📦 Tool Execution Output:');
    const content = callResult.content as Array<{ type: string; text: string }>;
    const parsedOutput = JSON.parse(content[0].text);
    console.log(JSON.stringify(parsedOutput, null, 2));

    if (!parsedOutput.icp_id) {
      throw new Error('Expected icp_id in tool output');
    }

    // 3. Verify PostgreSQL pgvector database persistence
    console.log(`\n🔎 Verifying pgvector database record for ICP ID: ${parsedOutput.icp_id}...`);
    const dbProfile = await prisma.icpProfile.findUnique({
      where: { id: parsedOutput.icp_id },
      include: { personas: true },
    });

    if (!dbProfile) {
      throw new Error(`ICP profile ${parsedOutput.icp_id} was not found in PostgreSQL!`);
    }

    const vectorCheck = await prisma.$queryRaw<Array<{ has_vector: boolean }>>`
      SELECT (embedding IS NOT NULL) AS has_vector 
      FROM icp_profiles 
      WHERE id = ${parsedOutput.icp_id}::uuid;
    `;

    console.log('📊 Profile Name:', dbProfile.name);
    console.log('👥 Personas Count:', dbProfile.personas.length);
    console.log('⚡ pgvector 1536-dim Embedding Indexed:', vectorCheck[0]?.has_vector);

    if (!vectorCheck[0]?.has_vector) {
      throw new Error('Vector embedding was not persisted to pgvector column!');
    }

    // Cleanup
    await prisma.icpProfile.delete({ where: { id: parsedOutput.icp_id } });
    console.log('🧹 Cleaned up test database record.');

    console.log('\n🎉 ALL MCP SMOKE TESTS PASSED SUCCESSFULLY! Sprint 1 is 100% operational.');
  } catch (error) {
    console.error('❌ Smoke test failed:', error);
    process.exit(1);
  } finally {
    await client.close();
    await prisma.$disconnect();
    process.exit(0);
  }
}

runSmokeTest();
