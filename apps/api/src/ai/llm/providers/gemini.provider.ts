import { PlaceholderProvider } from './placeholder-provider.js';

export class GeminiProvider extends PlaceholderProvider {
  readonly id = 'gemini' as const;
  protected readonly models = ['gemini-2.0-flash', 'gemini-1.5-pro'];
}
