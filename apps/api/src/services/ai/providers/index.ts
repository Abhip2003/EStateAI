// Side-effect-only import: each provider self-registers into
// aiProviderRegistry on load, same pattern as services/policy/policies/index.ts
// and services/agents/agents/index.ts. Adding a 4th provider means
// creating the file and adding one more import line here; nothing else
// changes.
import { aiProviderRegistry } from '../provider-registry.js';
import { claudeProvider } from './claude.provider.js';
import { openaiProvider } from './openai.provider.js';
import { geminiProvider } from './gemini.provider.js';

aiProviderRegistry.register(claudeProvider);
aiProviderRegistry.register(openaiProvider);
aiProviderRegistry.register(geminiProvider);
