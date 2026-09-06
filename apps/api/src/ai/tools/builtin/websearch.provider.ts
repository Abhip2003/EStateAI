// Provider abstraction for the Web Search Tool (Phase 24 spec #6) — an
// interface only, so a real provider (Bing/Google/Brave/etc.) can plug
// in later without changing web-search.tool.ts, the same "provider
// swappable behind one interface" shape as EmbeddingProvider (Phase 23)
// and LLMProvider (Phase 16).
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly id: string;
  search(query: string, topK: number): Promise<WebSearchResult[]>;
}

// The only implementation shipped in this phase — deterministic, no
// network call, no API key. Returns synthesized-but-clearly-labeled
// results so a caller can never mistake this for a real search (every
// result's url is an example.com placeholder). A future real provider
// (see the interface above) replaces this via the same composition-root
// swap EmbeddingService/LLMClient already use.
export class MockWebSearchProvider implements WebSearchProvider {
  readonly id = 'mock';

  search(query: string, topK: number): Promise<WebSearchResult[]> {
    const results: WebSearchResult[] = Array.from({ length: Math.min(topK, 3) }, (_, i) => ({
      title: `Mock result ${i + 1} for "${query}"`,
      url: `https://example.com/mock-search/${encodeURIComponent(query)}/${i + 1}`,
      snippet: `This is a placeholder search result — no real web search provider is configured. Query was: "${query}".`,
    }));
    return Promise.resolve(results);
  }
}
