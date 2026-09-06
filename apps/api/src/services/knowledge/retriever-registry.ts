import type { Retriever } from './retriever.interface.js';
import type { RetrievalRequest } from './dto/retrieval-request.js';
import { UnsupportedRetrieverError } from './knowledge-errors.js';

// Registry pattern, matching agentRegistry/aiProviderRegistry/policyRegistry
// — KnowledgeService never branches on which retrievers exist, it only
// calls retrieversFor()/resolve() against whatever is registered.
class RetrieverRegistry {
  private readonly retrievers = new Map<string, Retriever>();

  register(retriever: Retriever): void {
    this.retrievers.set(retriever.id(), retriever);
  }

  resolve(retrieverId: string): Retriever {
    const retriever = this.retrievers.get(retrieverId);
    if (!retriever) {
      throw new UnsupportedRetrieverError(retrieverId);
    }
    return retriever;
  }

  retrieversFor(request: RetrievalRequest): Retriever[] {
    return [...this.retrievers.values()].filter((retriever) => retriever.supports(request));
  }

  list(): Retriever[] {
    return [...this.retrievers.values()];
  }
}

export const retrieverRegistry = new RetrieverRegistry();
