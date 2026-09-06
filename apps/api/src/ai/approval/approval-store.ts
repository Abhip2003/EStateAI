import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { ApprovalRequest } from './approval.types.js';

const REQUEST_KEY_PREFIX = 'approval:request:';
const INDEX_KEY = 'approval:index';
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30d — audit trail, kept longer than PlanStore/ReflectionStore's 7d

// Persists ApprovalRequests (the Phase 26 audit trail — spec #8) via the
// same injected MemoryStore pattern as PlanStore/ReflectionStore. Each
// request is its own key (so a decision can update it in place); a
// separate append-only index list of ids is what makes listPending()
// possible, since MemoryStore has no query-by-field primitive.
export class ApprovalStore {
  constructor(private readonly store: MemoryStore) {}

  async save(request: ApprovalRequest): Promise<void> {
    const isNew = (await this.store.get<ApprovalRequest>(this.key(request.id))) === undefined;
    await this.store.set(this.key(request.id), request, TTL_SECONDS);
    if (isNew) {
      await this.store.append(INDEX_KEY, request.id, TTL_SECONDS);
    }
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    return this.store.get<ApprovalRequest>(this.key(id));
  }

  async listPending(): Promise<ApprovalRequest[]> {
    const ids = await this.store.getList<string>(INDEX_KEY);
    const requests = await Promise.all(ids.map((id) => this.get(id)));
    return requests.filter(
      (request): request is ApprovalRequest =>
        request !== undefined && request.status === 'PENDING',
    );
  }

  private key(id: string): string {
    return `${REQUEST_KEY_PREFIX}${id}`;
  }
}
