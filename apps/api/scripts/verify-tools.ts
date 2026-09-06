// Phase 24 — Tool-Using Agents. Framework-level checks: registry
// lookup, permission enforcement, agent allowlist enforcement, execution
// logging (ToolExecutionTrace), and backward compatibility with every
// pre-Phase-24 tool registration. Tool-specific behavior (GitHub/
// Postgres/Filesystem) lives in verify-github-tool.ts/
// verify-postgres-tool.ts/verify-filesystem-tool.ts; Copilot's automatic
// tool selection lives in verify-tool-calling.ts. In-process only — no
// live server dependency.
import { z } from 'zod';
import { prisma } from '../src/db/prisma.js';
import { redis } from '../src/cache/redis.js';
import { createChecker } from './lib/verify-helpers.js';
import { aiFoundation } from '../src/ai/foundation.js';
import { ToolRegistry, ToolExecutor, ToolError, toolTelemetry } from '../src/ai/tools/index.js';
import { isToolAllowedForAgent } from '../src/ai/tools/agent-tool-access.js';
import { registerBuiltinTools } from '../src/ai/tools/builtin/index.js';
import type { AIContext } from '../src/ai/types/context.types.js';
// Side-effect imports — each agent's index.ts self-registers its own
// tools into aiFoundation.toolRegistry on import, the same way
// server.ts's route imports do transitively. This script runs standalone
// (no server.ts import), so it has to trigger that registration itself.
import '../src/ai/agents/risk/index.js';
import '../src/ai/agents/copilot/index.js';

registerBuiltinTools();

const FAKE_CONTEXT: AIContext = {
  user: { id: 'verify-tools-user', role: 'USER' },
  toolHistory: [],
  executionHistory: [],
};

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. tool registry — every builtin + agent tool is registered and lookup-able');
  const expectedTools = [
    'postgres_query',
    'postgres_list_tables',
    'postgres_table_info',
    'github_repository_info',
    'github_repo_branches',
    'github_list_files',
    'github_commit_history',
    'github_list_pull_requests',
    'github_list_issues',
    'fs_read_file',
    'fs_list_directory',
    'fs_search_files',
    'web_search',
    'knowledge_search',
    // spot-check a few pre-Phase-24 agent tools still resolve fine
    'risk_engine_score',
    'copilot_asset_lookup',
  ];
  for (const toolName of expectedTools) {
    check(`registry has "${toolName}"`, aiFoundation.toolRegistry.has(toolName));
  }
  const listed = aiFoundation.toolRegistry.list();
  check('list() returns every registered tool', listed.length >= expectedTools.length);

  console.log(
    '2. tool lookup — get() returns a full ToolDefinition (id/name/description/permissions)',
  );
  const knowledgeTool = aiFoundation.toolRegistry.get('knowledge_search');
  check('knowledge_search has id', knowledgeTool.id === 'knowledge_search');
  check('knowledge_search has a non-empty description', knowledgeTool.description.length > 0);
  check(
    'knowledge_search declares permissions',
    Array.isArray(knowledgeTool.permissions) && knowledgeTool.permissions.length > 0,
  );
  check(
    'get() throws for an unknown tool name',
    (() => {
      try {
        aiFoundation.toolRegistry.get('does-not-exist');
        return false;
      } catch (e) {
        return e instanceof ToolError;
      }
    })(),
  );

  console.log('3. backward compatibility — a pre-Phase-24 tool gained id/permissions defaults');
  const riskTool = aiFoundation.toolRegistry.get('risk_engine_score');
  check('pre-Phase-24 tool id defaults to its name', riskTool.id === 'risk_engine_score');
  check(
    'pre-Phase-24 tool permissions default to ["read"]',
    JSON.stringify(riskTool.permissions) === JSON.stringify(['read']),
  );
  check(
    'ToolRegistry.execute() (the pre-Phase-24 call contract) still throws ToolExecutionError for an unknown tool',
    await (async () => {
      try {
        await aiFoundation.toolRegistry.execute('does-not-exist', {}, FAKE_CONTEXT);
        return false;
      } catch (e) {
        return e instanceof Error && e.name === 'ToolExecutionError';
      }
    })(),
  );

  console.log('4. permission enforcement — a tool declaring "write" is refused');
  const scratchRegistry = new ToolRegistry();
  scratchRegistry.register({
    name: 'fake_write_tool',
    description: 'a fake tool that declares write access, for permission-enforcement testing',
    permissions: ['write'],
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute() {
      return Promise.resolve({});
    },
  });
  const scratchExecutor = new ToolExecutor(scratchRegistry, toolTelemetry);
  const writeResult = await scratchExecutor.run('fake_write_tool', {}, FAKE_CONTEXT);
  check('write-permission tool call is refused', writeResult.success === false);
  check(
    'refusal error mentions the denied permission',
    (writeResult.error ?? '').toLowerCase().includes('write'),
    writeResult.error,
  );

  console.log('5. agent allowlist enforcement — an agent not declared for a tool is denied');
  check(
    'copilot-agent IS allowed to call web_search (declared)',
    isToolAllowedForAgent('copilot-agent', 'web_search'),
  );
  check(
    'discovery-agent is NOT allowed to call web_search (undeclared)',
    !isToolAllowedForAgent('discovery-agent', 'web_search'),
  );
  const deniedAgentResult = await aiFoundation.toolExecutor.run(
    'web_search',
    { query: 'test' },
    FAKE_CONTEXT,
    'discovery-agent',
  );
  check('ToolExecutor.run() denies the undeclared agent', deniedAgentResult.success === false);
  check(
    'denial error names the agent and tool',
    (deniedAgentResult.error ?? '').includes('discovery-agent') &&
      (deniedAgentResult.error ?? '').includes('web_search'),
    deniedAgentResult.error,
  );
  const allowedAgentResult = await aiFoundation.toolExecutor.run(
    'web_search',
    { query: 'branch protection best practices' },
    FAKE_CONTEXT,
    'copilot-agent',
  );
  check('ToolExecutor.run() allows the declared agent', allowedAgentResult.success === true);

  console.log(
    '6. execution logging — ToolExecutionTrace persists tool + agent + latency + success',
  );
  const before = await prisma.toolExecutionTrace.count({
    where: { toolName: 'web_search', agentId: 'copilot-agent' },
  });
  await aiFoundation.toolExecutor.run(
    'web_search',
    { query: 'execution trace check' },
    FAKE_CONTEXT,
    'copilot-agent',
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await prisma.toolExecutionTrace.count({
    where: { toolName: 'web_search', agentId: 'copilot-agent' },
  });
  check('a new ToolExecutionTrace row was written', after === before + 1, `${before} -> ${after}`);

  const latestTrace = await prisma.toolExecutionTrace.findFirst({
    where: { toolName: 'web_search', agentId: 'copilot-agent' },
    orderBy: { createdAt: 'desc' },
  });
  check('trace records success = true', latestTrace?.success === true);
  check('trace records a non-negative durationMs', (latestTrace?.durationMs ?? -1) >= 0);
  check('trace records the call arguments', !!latestTrace?.arguments);

  console.log('7. execution logging on failure — a failed call is traced too');
  const failResult = await aiFoundation.toolExecutor.run(
    'postgres_query',
    { sql: 'DROP TABLE "User"' },
    FAKE_CONTEXT,
    'compliance-agent',
  );
  check('write-shaped SQL is refused', failResult.success === false);
  const failTrace = await prisma.toolExecutionTrace.findFirst({
    where: { toolName: 'postgres_query', success: false },
    orderBy: { createdAt: 'desc' },
  });
  check('a failed call is also traced', !!failTrace && failTrace.error != null);

  if (state.failed) {
    console.error('\nOne or more tool framework checks FAILED.');
  } else {
    console.log('\nAll tool framework checks passed.');
  }

  await redis.quit().catch(() => undefined);
  await prisma.$disconnect();

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
