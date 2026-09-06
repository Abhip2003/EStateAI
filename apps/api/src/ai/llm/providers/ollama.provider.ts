import { PlaceholderProvider } from './placeholder-provider.js';

export class OllamaProvider extends PlaceholderProvider {
  readonly id = 'ollama' as const;
  protected readonly models = ['llama3', 'mistral', 'qwen2.5'];
}
