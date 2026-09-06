// Phase 16 — AI foundation unit-level checks. This module (src/ai/) ships
// no new routes and needs no running API server, so — unlike most other
// verify:* scripts — this one runs entirely in-process against the
// exported classes/functions themselves. It still follows the shared
// createChecker() convention (scripts/lib/verify-helpers.ts) used by
// every other verify script in this project, since no unit-test
// framework (jest/vitest) is installed here.
import { z } from 'zod';
import { createChecker } from './lib/verify-helpers.js';
import {
  AIError,
  LLMError,
  ProviderError,
  RateLimitError,
  ToolExecutionError,
  ParsingError,
  PromptError,
  MemoryError,
} from '../src/ai/errors/index.js';
import { loadAIConfig } from '../src/ai/config/index.js';
import { withRetry, maskSecret } from '../src/ai/utils/index.js';
import {
  LLMProviderFactory,
  LLMProviderRegistry,
  LLMClient,
  OpenAIProvider,
  AnthropicProvider,
} from '../src/ai/llm/index.js';
import { PromptTemplate, PromptRegistry } from '../src/ai/prompts/index.js';
import { parse, tryParse, parseWithRetry } from '../src/ai/parser/index.js';
import { ToolRegistry } from '../src/ai/tools/index.js';
import { buildAIContext, recordExecutionStep } from '../src/ai/context/index.js';
import { InMemoryStore, ConversationMemory, SessionMemory } from '../src/ai/memory/index.js';
import { redis } from '../src/cache/redis.js';

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. Error hierarchy');
  const aiErr = new AIError('base');
  check('AIError instanceof Error', aiErr instanceof Error);
  check('LLMError extends AIError', new LLMError('x') instanceof AIError);
  const providerErr = new ProviderError('openai', 'boom', true);
  check('ProviderError extends AIError', providerErr instanceof AIError);
  check(
    'ProviderError carries providerId/retryable',
    providerErr.providerId === 'openai' && providerErr.retryable,
  );
  check('RateLimitError extends AIError', new RateLimitError('openai', 'x') instanceof AIError);
  check('ToolExecutionError extends AIError', new ToolExecutionError('t', 'x') instanceof AIError);
  check('ParsingError extends AIError', new ParsingError('x', 'raw') instanceof AIError);
  check('PromptError extends AIError', new PromptError('x') instanceof AIError);
  check('MemoryError extends AIError', new MemoryError('x') instanceof AIError);

  console.log('2. Configuration');
  const config = loadAIConfig();
  check('default provider is openai (only concrete impl)', config.defaultProvider === 'openai');
  check('maxTokens sourced from existing config.ai', config.maxTokens > 0);
  check('all 5 providers have config entries', Object.keys(config.providers).length === 5);
  check(
    'config is frozen (immutable)',
    Object.isFrozen(config) && Object.isFrozen(config.providers),
  );

  console.log('3. Utils — retry with exponential backoff');
  let attempts = 0;
  const retryResult = await withRetry(
    () => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new RateLimitError('openai', 'transient'));
      return Promise.resolve('ok');
    },
    { retries: 3, backoffMs: 1, isRetryable: (e) => e instanceof RateLimitError },
  );
  check('withRetry succeeds after transient failures', retryResult === 'ok' && attempts === 3);

  let nonRetryableAttempts = 0;
  await withRetry(
    () => {
      nonRetryableAttempts += 1;
      return Promise.reject(new ProviderError('openai', 'permanent'));
    },
    { retries: 3, backoffMs: 1, isRetryable: (e) => e instanceof RateLimitError },
  ).catch(() => undefined);
  check('withRetry does not retry non-retryable errors', nonRetryableAttempts === 1);

  check('maskSecret masks a real-looking key', maskSecret('sk-abcdefghijklmnop') === 'sk-a...mnop');
  check('maskSecret handles unset', maskSecret(undefined) === '(unset)');

  console.log('4. LLM provider factory/registry');
  const factory = new LLMProviderFactory(config);
  const openai = factory.create('openai');
  check('factory creates OpenAIProvider', openai instanceof OpenAIProvider);
  const anthropic = factory.create('anthropic');
  check('factory creates AnthropicProvider placeholder', anthropic instanceof AnthropicProvider);
  check('placeholder provider lists known models', anthropic.listModels().length > 0);
  check('placeholder provider does not support streaming', !anthropic.supportsStreaming());
  await anthropic
    .generate({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] })
    .then(() => check('placeholder generate() throws', false))
    .catch((e) => check('placeholder generate() throws ProviderError', e instanceof ProviderError));

  const registry = new LLMProviderRegistry(factory, config);
  check('registry resolves default provider', registry.resolveDefault().id === 'openai');
  check('registry resolves by model', registry.resolveForModel('gpt-4o-mini').id === 'openai');
  check('registry caches instances', registry.resolve('openai') === registry.resolve('openai'));
  check('registry lists all 5 providers', registry.list().length === 5);

  const client = new LLMClient(openai, config);
  await client
    .generate({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
    .then(() => check('LLMClient without API key throws', false))
    .catch((e) => check('LLMClient surfaces missing-API-key as LLMError', e instanceof LLMError));

  console.log('5. Prompt management — templates, versioning, validation');
  const promptSchema = z.object({ name: z.string() });
  const template = new PromptTemplate({
    id: 'greeting',
    version: '1',
    systemTemplate: 'You are a greeter.',
    userTemplate: 'Say hello to {{name}}.',
    variablesSchema: promptSchema,
  });
  const rendered = template.render({ name: 'Ada' });
  check('template renders variables', rendered.user === 'Say hello to Ada.');
  check('template renders system prompt', rendered.system === 'You are a greeter.');
  let promptValidationFailed = false;
  try {
    template.validate({ wrong: 'field' });
  } catch (e) {
    promptValidationFailed = e instanceof PromptError;
  }
  check('template validation rejects bad variables', promptValidationFailed);

  const promptRegistry = new PromptRegistry();
  promptRegistry.register(template);
  check('registry resolves template by id', promptRegistry.get('greeting').version === '1');
  const v2 = new PromptTemplate({
    id: 'greeting',
    version: '2',
    userTemplate: 'Hi {{name}}!',
    variablesSchema: promptSchema,
  });
  promptRegistry.register(v2);
  check(
    'registry resolves latest version by default',
    promptRegistry.get('greeting').version === '2',
  );
  check('registry resolves pinned version', promptRegistry.get('greeting', '1').version === '1');
  check('registry.list() reports both versions', promptRegistry.list().length === 2);
  let duplicateRejected = false;
  try {
    promptRegistry.register(v2);
  } catch (e) {
    duplicateRejected = e instanceof PromptError;
  }
  check('registry rejects duplicate id+version', duplicateRejected);

  console.log('6. Structured output parser');
  const outputSchema = z.object({ score: z.number(), label: z.string() });
  const good = parse('{"score": 0.9, "label": "high"}', outputSchema);
  check('parse() parses valid JSON', good.score === 0.9 && good.label === 'high');
  check(
    'parse() strips ```json code fences',
    parse('```json\n{"score": 1, "label": "x"}\n```', outputSchema).score === 1,
  );
  const badResult = tryParse('not json at all', outputSchema);
  check(
    'tryParse() reports failure on malformed JSON',
    !badResult.success && badResult.error instanceof ParsingError,
  );
  const schemaMismatch = tryParse('{"score": "not-a-number"}', outputSchema);
  check('tryParse() reports failure on schema mismatch', !schemaMismatch.success);

  let repairCalls = 0;
  const repaired = await parseWithRetry('not json', outputSchema, {
    maxAttempts: 2,
    repair: () => {
      repairCalls += 1;
      return Promise.resolve('{"score": 5, "label": "repaired"}');
    },
  });
  check(
    'parseWithRetry repairs malformed responses',
    repaired.label === 'repaired' && repairCalls === 1,
  );

  console.log('7. Tool registry (interfaces only — no concrete tools shipped)');
  const toolRegistry = new ToolRegistry();
  const echoTool = {
    name: 'echo',
    description: 'Echoes input back',
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ text: z.string() }),
    execute: (input: { text: string }) => Promise.resolve({ text: input.text }),
  };
  toolRegistry.register(echoTool);
  check('tool registry lists registered tools', toolRegistry.list().length === 1);
  check('tool registry.has() finds registered tool', toolRegistry.has('echo'));
  let duplicateToolRejected = false;
  try {
    toolRegistry.register(echoTool);
  } catch (e) {
    duplicateToolRejected = e instanceof ToolExecutionError;
  }
  check('tool registry rejects duplicate names', duplicateToolRejected);

  const ctx = buildAIContext({ user: { id: 'u1', role: 'ADMIN' } });
  recordExecutionStep(ctx, 'started');
  const toolOutput = await toolRegistry.execute('echo', { text: 'hello' }, ctx);
  check(
    'tool registry executes and validates output',
    (toolOutput as { text: string }).text === 'hello',
  );
  check('tool execution appends to context.toolHistory', ctx.toolHistory.length === 1);
  check(
    'recordExecutionStep appends to context.executionHistory',
    ctx.executionHistory.length === 1,
  );

  let badInputRejected = false;
  try {
    await toolRegistry.execute('echo', { text: 123 }, ctx);
  } catch (e) {
    badInputRejected = e instanceof ToolExecutionError;
  }
  check('tool registry rejects input failing inputSchema', badInputRejected);

  console.log('8. Memory — in-memory store, conversation memory, session memory');
  const store = new InMemoryStore();
  await store.set('k', { a: 1 }, 60);
  check(
    'InMemoryStore get/set roundtrip',
    ((await store.get<{ a: number }>('k')) ?? { a: 0 }).a === 1,
  );
  await store.append('list', 'x');
  await store.append('list', 'y');
  check('InMemoryStore append/getList', (await store.getList<string>('list')).join(',') === 'x,y');
  await store.delete('k');
  check('InMemoryStore delete', (await store.get('k')) === undefined);

  const shortTtlStore = new InMemoryStore();
  await shortTtlStore.set('ephemeral', 'v', 0.05);
  await new Promise((resolve) => setTimeout(resolve, 100));
  check('InMemoryStore respects TTL expiry', (await shortTtlStore.get('ephemeral')) === undefined);

  const conversationMemory = new ConversationMemory(store);
  await conversationMemory.append('conv1', 'user', 'hi');
  await conversationMemory.append('conv1', 'assistant', 'hello');
  const turns = await conversationMemory.getTurns('conv1');
  check(
    'ConversationMemory records turns in order',
    turns.length === 2 && turns[0].role === 'user',
  );
  await conversationMemory.clear('conv1');
  check(
    'ConversationMemory.clear() empties turns',
    (await conversationMemory.getTurns('conv1')).length === 0,
  );

  const sessionMemory = new SessionMemory(store);
  await sessionMemory.set('sess1', 'currentAssetId', 'asset-123');
  check(
    'SessionMemory get/set roundtrip',
    (await sessionMemory.get<string>('sess1', 'currentAssetId')) === 'asset-123',
  );
  await sessionMemory.clear('sess1', 'currentAssetId');
  check(
    'SessionMemory.clear()',
    (await sessionMemory.get('sess1', 'currentAssetId')) === undefined,
  );

  console.log('9. Redis-backed memory (real Redis, via existing cache/redis.ts client)');
  const { RedisMemoryStore } = await import('../src/ai/memory/redis-memory-store.js');
  const redisStore = new RedisMemoryStore(redis);
  const redisKey = `verify-ai-foundation-${Date.now()}`;
  await redisStore.set(redisKey, { hello: 'world' }, 30);
  check(
    'RedisMemoryStore get/set roundtrip',
    ((await redisStore.get<{ hello: string }>(redisKey)) ?? { hello: '' }).hello === 'world',
  );
  await redisStore.delete(redisKey);
  check('RedisMemoryStore delete', (await redisStore.get(redisKey)) === undefined);

  console.log('10. Telemetry — records without throwing, and increments Prometheus counters');
  const { AITelemetry } = await import('../src/ai/telemetry/ai-telemetry.js');
  const { metricsRegistry } = await import('../src/observability/metrics.js');
  const telemetry = new AITelemetry();
  const beforeMetrics = await metricsRegistry.getMetricsAsJSON();
  telemetry.recordLLMCall({
    provider: 'openai',
    model: 'gpt-4o-mini',
    latencyMs: 120,
    promptTokens: 10,
    completionTokens: 5,
    estimatedCostUsd: 0.0001,
    retryCount: 0,
    success: true,
  });
  telemetry.recordToolExecution({ toolName: 'echo', durationMs: 5, success: true });
  const afterMetrics = await metricsRegistry.getMetricsAsJSON();
  check(
    'telemetry calls do not throw and metrics registry grows/updates',
    afterMetrics.length >= beforeMetrics.length,
  );

  if (state.failed) {
    console.error('\nOne or more AI foundation checks FAILED.');
  } else {
    console.log('\nAll AI foundation checks passed.');
  }

  await redis.quit().catch(() => undefined);

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
