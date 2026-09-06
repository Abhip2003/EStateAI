import { PlaceholderProvider } from './placeholder-provider.js';

export class AzureOpenAIProvider extends PlaceholderProvider {
  readonly id = 'azure-openai' as const;
  protected readonly models = ['gpt-4o', 'gpt-4o-mini'];
}
