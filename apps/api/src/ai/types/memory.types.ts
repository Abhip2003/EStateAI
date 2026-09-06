import type { MessageRole } from './common.js';

export interface ConversationTurn {
  role: MessageRole;
  content: string;
  timestamp: string;
}

export interface MemoryEntry<T = unknown> {
  value: T;
  updatedAt: string;
}
