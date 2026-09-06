// One retrieved piece of context, already reshaped into prompt-ready text
// by the retriever that produced it — KnowledgeService never re-derives
// meaning from `raw`, it only merges/dedupes/sorts/trims on the fields
// below.
export interface RetrievedItem {
  type: string;
  // Unique identity — the basis for exact-duplicate removal (e.g. a
  // Resource's id, a Finding's id).
  entityKey: string;
  // Optional collapsing key — items of the same `type` sharing a
  // `groupKey` are candidates for "summarize repeated entities" once their
  // count exceeds config.knowledge.collapseThreshold (e.g. many findings
  // sharing the same ruleCode). Omitted when collapsing doesn't apply.
  groupKey?: string;
  summary: string;
  // 0-100, higher = more relevant. Each retriever defines its own
  // heuristic (recency, severity weight, priority) — KnowledgeService only
  // ever compares these numbers, never recomputes them.
  relevance: number;
  raw?: Record<string, unknown>;
}

export interface RetrievalResult {
  retrieverId: string;
  items: RetrievedItem[];
}
