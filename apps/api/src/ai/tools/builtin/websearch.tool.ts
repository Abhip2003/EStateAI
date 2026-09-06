import { z } from 'zod';
import type { ToolDefinition } from '../tool.types.js';
import type { ToolRegistry } from '../tool-registry.js';
import { MockWebSearchProvider, type WebSearchProvider } from './websearch.provider.js';

const searchInputSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(10).default(3),
});
const searchOutputSchema = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })),
});

// Builds the `web_search` tool over whichever WebSearchProvider is
// injected — a function rather than a fixed constant so a future real
// provider can be wired in at composition-root time (registerBuiltinTools())
// without editing this file.
export function createWebSearchTool(
  provider: WebSearchProvider,
): ToolDefinition<z.infer<typeof searchInputSchema>, z.infer<typeof searchOutputSchema>> {
  return {
    id: 'web_search',
    name: 'web_search',
    description: `Searches the web for a query and returns the top results (title/url/snippet). Provider: ${provider.id}.`,
    permissions: ['read', 'network'],
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    async execute(input) {
      const results = await provider.search(input.query, input.topK);
      return { results };
    },
  };
}

export function registerWebSearchTools(
  toolRegistry: ToolRegistry,
  provider: WebSearchProvider = new MockWebSearchProvider(),
): void {
  toolRegistry.register(createWebSearchTool(provider));
}
