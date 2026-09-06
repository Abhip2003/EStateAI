import { PlaceholderProvider } from './placeholder-provider.js';

// Interface/placeholder only — see placeholder-provider.ts for why. The
// existing services/ai/providers/claude.provider.ts remains the live
// Anthropic integration for /ai/generate and /copilot/chat; this class is
// scaffolding for a future phase to migrate onto this foundation.
export class AnthropicProvider extends PlaceholderProvider {
  readonly id = 'anthropic' as const;
  protected readonly models = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];
}
