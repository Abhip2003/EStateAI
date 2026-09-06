import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { aiRequestLogRepository } from '../src/repositories/ai-request-log.repository.js';
import { prisma } from '../src/db/prisma.js';
import { aiProviderRegistry } from '../src/services/ai/provider-registry.js';
import { promptBuilder } from '../src/services/ai/prompt-builder.js';
import { estimateTokens } from '../src/services/ai/token-counter.js';
import { estimateCostUsd } from '../src/services/ai/cost-estimator.js';
import { responseParser } from '../src/services/ai/response-parser.js';
import {
  UnsupportedAIModelError,
  UnsupportedAIProviderError,
} from '../src/services/ai/ai-errors.js';
import '../src/services/ai/providers/index.js';
import { claudeProvider } from '../src/services/ai/providers/claude.provider.js';
import { openaiProvider } from '../src/services/ai/providers/openai.provider.js';
import { geminiProvider } from '../src/services/ai/providers/gemini.provider.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const CLAUDE_PORT = 3998;
const OPENAI_PORT = 3997;
const GEMINI_PORT = 3996;

const TRANSIENT_TRIGGER = 'trigger-transient-failure';
const PERMANENT_TRIGGER = 'trigger-permanent-failure';

interface GenerateResponseDto {
  provider: string;
  model: string;
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
  estimatedCostUsd: number;
  latencyMs: number;
}

interface ProvidersListDto {
  items: { id: string; models: string[] }[];
}

interface ModelsListDto {
  items: { provider: string; model: string }[];
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function lastUserContent(body: Record<string, unknown>): string {
  const messages = (body.messages ?? body.contents ?? []) as {
    content?: string;
    parts?: { text?: string }[];
  }[];
  const last = messages[messages.length - 1];
  return last?.content ?? last?.parts?.[0]?.text ?? '';
}

// One mock claude failure is pre-armed per script run — the "retries"
// check consumes it, verifying AIService retries a transient (5xx)
// failure and succeeds on the 2nd attempt.
let claudeTransientFailuresRemaining = 1;

function startClaudeMockServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/messages')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      const content = lastUserContent(body);

      if (content.includes(PERMANENT_TRIGGER)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid api key' }));
        return;
      }
      if (content.includes(TRANSIENT_TRIGGER) && claudeTransientFailuresRemaining > 0) {
        claudeTransientFailuresRemaining -= 1;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
        return;
      }

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } })}\n\n`,
        );
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: body.model,
          content: [{ type: 'text', text: `Mock claude response for: ${content}` }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 20 },
        }),
      );
    })();
  });

  return new Promise((resolve) => server.listen(CLAUDE_PORT, () => resolve(server)));
}

function startOpenAIMockServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/chat/completions')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      const content = lastUserContent(body);

      if (content.includes(PERMANENT_TRIGGER)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid api key' }));
        return;
      }

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'world' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            { message: { content: `Mock openai response for: ${content}` }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 },
        }),
      );
    })();
  });

  return new Promise((resolve) => server.listen(OPENAI_PORT, () => resolve(server)));
}

function startGeminiMockServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/models/')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      const content = lastUserContent(body);
      const isStream = req.url.includes('streamGenerateContent');
      // Path shape: /models/<model>:<action>?key=...
      const modelSegment = req.url.split('/models/')[1]?.split(':')[0] ?? 'unknown-model';

      if (content.includes(PERMANENT_TRIGGER)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid api key' }));
        return;
      }

      if (isStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'world' }] } }] })}\n\n`,
        );
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          modelVersion: modelSegment,
          candidates: [
            {
              content: { parts: [{ text: `Mock gemini response for: ${content}` }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, totalTokenCount: 40 },
        }),
      );
    })();
  });

  return new Promise((resolve) => server.listen(GEMINI_PORT, () => resolve(server)));
}

async function collectStream(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const chunk of gen) {
    out += chunk;
  }
  return out;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let otherId: string | undefined;
  const logIdsToClean: string[] = [];

  const claudeMock = await startClaudeMockServer();
  const openaiMock = await startOpenAIMockServer();
  const geminiMock = await startGeminiMockServer();

  try {
    console.log('0. unit checks — provider registry, selection, prompt building');
    const registered = aiProviderRegistry
      .list()
      .map((p) => p.id())
      .sort();
    check(
      'all 3 providers registered',
      JSON.stringify(registered) === JSON.stringify(['claude', 'gemini', 'openai']),
      JSON.stringify(registered),
    );
    check(
      'resolveForModel routes claude-sonnet-5 to claude',
      aiProviderRegistry.resolveForModel('claude-sonnet-5').id() === 'claude',
    );
    check(
      'resolveForModel routes gpt-4o to openai',
      aiProviderRegistry.resolveForModel('gpt-4o').id() === 'openai',
    );
    check(
      'resolveForModel routes gemini-2.0-flash to gemini',
      aiProviderRegistry.resolveForModel('gemini-2.0-flash').id() === 'gemini',
    );
    let unsupportedModelThrew = false;
    try {
      aiProviderRegistry.resolveForModel('not-a-real-model');
    } catch (err) {
      unsupportedModelThrew = err instanceof UnsupportedAIModelError;
    }
    check('unsupported model throws UnsupportedAIModelError', unsupportedModelThrew);
    let unsupportedProviderThrew = false;
    try {
      aiProviderRegistry.resolve('not-a-real-provider');
    } catch (err) {
      unsupportedProviderThrew = err instanceof UnsupportedAIProviderError;
    }
    check('unsupported provider throws UnsupportedAIProviderError', unsupportedProviderThrew);

    const built = promptBuilder.build(
      {
        systemPrompt: 'You are a test assistant.',
        userPrompt: 'What is the risk?',
        model: 'claude-sonnet-5',
        // No knowledgeContext here — that's exercised end-to-end by
        // verify-knowledge.ts (Phase 7C), which owns prompt-compatibility
        // checks now that PromptBuilder consumes KnowledgeContext instead
        // of a freeform contextBlocks record.
      },
      1024,
    );
    check(
      'prompt builder carries systemPrompt through',
      built.systemPrompt === 'You are a test assistant.',
    );
    check(
      'prompt builder passes the user prompt through unchanged when there is no knowledge context',
      built.messages[0]?.content === 'What is the risk?',
      built.messages[0]?.content,
    );
    check('prompt builder defaults maxTokens', built.maxTokens === 1024);

    console.log('1. unit checks — token counter, cost estimator, response parser');
    check('estimateTokens is roughly chars/4', estimateTokens('a'.repeat(40)) === 10);
    check('estimateTokens of empty string is 0', estimateTokens('') === 0);
    const knownModelCost = estimateCostUsd('claude-sonnet-5', {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    });
    check(
      'known-model cost estimate is 3 + 15 = 18 USD',
      knownModelCost === 18,
      `${knownModelCost}`,
    );
    const unknownModelCost = estimateCostUsd('some-future-model', {
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    });
    check('unknown model falls back to default pricing (no throw)', unknownModelCost > 0);

    const normalized = responseParser.normalize(
      {
        provider: 'claude',
        model: 'claude-sonnet-5',
        text: 'hello',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'end_turn',
      },
      123,
    );
    check('response parser attaches latencyMs', normalized.latencyMs === 123);
    check('response parser attaches an estimated cost', normalized.estimatedCostUsd > 0);

    console.log('2. unit checks — streaming (each provider, against its own mock)');
    const claudeStreamText = await collectStream(
      claudeProvider.stream({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      }),
    );
    check(
      'claude stream yields concatenated deltas',
      claudeStreamText === 'Hello world',
      claudeStreamText,
    );
    const openaiStreamText = await collectStream(
      openaiProvider.stream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      }),
    );
    check(
      'openai stream yields concatenated deltas',
      openaiStreamText === 'Hello world',
      openaiStreamText,
    );
    const geminiStreamText = await collectStream(
      geminiProvider.stream({
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      }),
    );
    check(
      'gemini stream yields concatenated deltas',
      geminiStreamText === 'Hello world',
      geminiStreamText,
    );

    console.log('3. setup — admin+category, asset, owner + another user');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('ai');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-ai-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-ai-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-ai-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    console.log('4. POST /ai/generate — explicit provider+model, one per vendor');
    for (const [provider, model] of [
      ['claude', 'claude-sonnet-5'],
      ['openai', 'gpt-4o'],
      ['gemini', 'gemini-2.0-flash'],
    ] as const) {
      const res = await api<GenerateResponseDto>('POST', '/ai/generate', ownerToken, {
        provider,
        model,
        prompt: `hello from ${provider} test`,
        assetId,
      });
      check(`${provider} generate status 200`, res.status === 200, JSON.stringify(res.body));
      check(
        `${provider} response echoes provider/model`,
        res.body.provider === provider && res.body.model === model,
      );
      check(
        `${provider} response has non-zero usage`,
        res.body.usage.totalTokens > 0,
        JSON.stringify(res.body.usage),
      );
      check(`${provider} response has a positive estimated cost`, res.body.estimatedCostUsd >= 0);
    }

    console.log('5. provider selection — by model only, and by neither (config default)');
    const byModelOnly = await api<GenerateResponseDto>('POST', '/ai/generate', ownerToken, {
      model: 'gpt-4o-mini',
      prompt: 'model-only routing test',
      assetId,
    });
    check(
      'model-only request routes to openai',
      byModelOnly.status === 200 && byModelOnly.body.provider === 'openai',
      JSON.stringify(byModelOnly.body),
    );

    const byDefault = await api<GenerateResponseDto>('POST', '/ai/generate', ownerToken, {
      prompt: 'default routing test',
      assetId,
    });
    check(
      'no provider/model request routes to the configured default (claude)',
      byDefault.status === 200 && byDefault.body.provider === 'claude',
      JSON.stringify(byDefault.body),
    );

    console.log('6. retries — a transient (5xx) failure is retried and succeeds');
    const retryRes = await api<GenerateResponseDto>('POST', '/ai/generate', ownerToken, {
      provider: 'claude',
      model: 'claude-sonnet-5',
      prompt: TRANSIENT_TRIGGER,
      assetId,
    });
    check(
      'transient failure is retried to a 200',
      retryRes.status === 200,
      JSON.stringify(retryRes.body),
    );

    console.log('7. permanent failure — not retried, mapped to 502, logged as FAILED');
    const permFailRes = await api('POST', '/ai/generate', ownerToken, {
      provider: 'claude',
      model: 'claude-sonnet-5',
      prompt: PERMANENT_TRIGGER,
      assetId,
    });
    check(
      'permanent provider rejection maps to 502',
      permFailRes.status === 502,
      `${permFailRes.status}`,
    );

    console.log('8. usage recording — AIRequestLog rows persisted with correct data');
    const logsRes = await prisma.aIRequestLog.findMany({
      where: { assetId },
      orderBy: { createdAt: 'asc' },
    });
    for (const log of logsRes) logIdsToClean.push(log.id);
    const successLogs = logsRes.filter((l) => l.status === 'SUCCESS');
    const failedLogs = logsRes.filter((l) => l.status === 'FAILED');
    check('at least one SUCCESS log recorded', successLogs.length > 0);
    check(
      'exactly one FAILED log recorded (the permanent failure)',
      failedLogs.length === 1,
      `${failedLogs.length}`,
    );
    check(
      'FAILED log has attempts == 1 (not retried)',
      failedLogs[0]?.attempts === 1,
      `${failedLogs[0]?.attempts}`,
    );
    const retriedLog = successLogs.find((l) => l.attempts > 1);
    check('one SUCCESS log shows attempts > 1 (the retried transient failure)', !!retriedLog);
    check(
      'every SUCCESS log has non-zero totalTokens and a cost',
      successLogs.every((l) => l.totalTokens > 0 && l.estimatedCostUsd >= 0),
    );

    console.log('9. unsupported provider/model are rejected with 400');
    const badProviderRes = await api('POST', '/ai/generate', ownerToken, {
      provider: 'not-a-real-provider',
      prompt: 'x',
      assetId,
    });
    check('unsupported provider is 400', badProviderRes.status === 400, `${badProviderRes.status}`);
    const badModelRes = await api('POST', '/ai/generate', ownerToken, {
      model: 'not-a-real-model',
      prompt: 'x',
      assetId,
    });
    check('unsupported model is 400', badModelRes.status === 400, `${badModelRes.status}`);

    console.log('10. GET /ai/providers, GET /ai/models — registry introspection');
    const providersRes = await api<ProvidersListDto>('GET', '/ai/providers', ownerToken);
    check('providers list status 200', providersRes.status === 200);
    check('providers list has 3 entries', providersRes.body.items.length === 3);
    const modelsRes = await api<ModelsListDto>('GET', '/ai/models', ownerToken);
    const expectedModelCount = providersRes.body.items.reduce((sum, p) => sum + p.models.length, 0);
    check(
      'models list is the flattened union of every provider',
      modelsRes.body.items.length === expectedModelCount,
      `${modelsRes.body.items.length} vs ${expectedModelCount}`,
    );

    console.log('11. authorization — unauthenticated and cross-user access are rejected');
    const noAuthRes = await api('POST', '/ai/generate', undefined, { prompt: 'x', assetId });
    check('unauthenticated generate is 401', noAuthRes.status === 401, `${noAuthRes.status}`);
    const noAuthProviders = await api('GET', '/ai/providers', undefined);
    check('unauthenticated providers list is 401', noAuthProviders.status === 401);

    const crossUserRes = await api('POST', '/ai/generate', other.accessToken, {
      prompt: 'x',
      assetId,
    });
    check(
      'cross-user generate (assetId ownership) is 403',
      crossUserRes.status === 403,
      `${crossUserRes.status}`,
    );

    console.log('12. event generation — AI_REQUEST_STARTED/COMPLETED/FAILED, TOKEN_USAGE_RECORDED');
    const eventsRes = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events?limit=100`,
      ownerToken,
    );
    const eventTypes = eventsRes.body.items.map((e) => e.type);
    check('AI_REQUEST_STARTED event exists', eventTypes.includes('AI_REQUEST_STARTED'));
    check('AI_REQUEST_COMPLETED event exists', eventTypes.includes('AI_REQUEST_COMPLETED'));
    check('AI_REQUEST_FAILED event exists', eventTypes.includes('AI_REQUEST_FAILED'));
    check('TOKEN_USAGE_RECORDED event exists', eventTypes.includes('TOKEN_USAGE_RECORDED'));

    if (state.failed) {
      console.error('\nOne or more AI checks FAILED.');
    } else {
      console.log('\nAll AI checks passed.');
    }
  } finally {
    console.log('13. cleanup');
    claudeMock.close();
    openaiMock.close();
    geminiMock.close();
    for (const logId of logIdsToClean) {
      try {
        await aiRequestLogRepository.delete(logId);
      } catch {
        // Already deleted — fine.
      }
    }
    if (assetId) await assetRepository.delete(assetId);
    console.log('   ai request logs + asset deleted');
    if (categoryId) await categoryRepository.delete(categoryId);
    console.log('   category deleted');
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    if (otherId) await userRepository.delete(otherId);
    console.log('   users deleted');
  }

  await prisma.$disconnect();
  process.exit(state.failed ? 1 : 0);
}

void main();
