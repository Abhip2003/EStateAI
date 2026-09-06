import type { RetrievalRequest } from './dto/retrieval-request.js';
import type { RetrievalResult } from './dto/retrieval-result.js';

// Every retriever is a thin adapter over one or more existing services —
// it must never query Prisma directly and never duplicate a service's
// business logic, only call it and reshape the result into
// RetrievedItem[]. Mirrors the Agent interface's shape from Phase 7A
// (id()/supports()/execute()-equivalent), one layer further down the
// stack.
export interface Retriever {
  id(): string;
  supports(request: RetrievalRequest): boolean;
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}
