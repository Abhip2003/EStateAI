import { aiFoundation } from '../../foundation.js';
import { retrievalService } from '../../retrieval/index.js';
import { registerPostgresTools } from './postgres.tool.js';
import { registerGitHubTools } from './github.tool.js';
import { registerFilesystemTools } from './filesystem.tool.js';
import { registerWebSearchTools } from './websearch.tool.js';
import { registerKnowledgeTools } from './knowledge.tool.js';

// Composition root for every generic, agent-agnostic tool (Phase 24) —
// registers Postgres/GitHub/Filesystem/WebSearch/Knowledge tools into
// the shared aiFoundation.toolRegistry, the same registry every agent's
// own *.tool.ts file already registers into. Importing this module (from
// server.ts) is what makes 'postgres_query'/'github_repository_info'/
// 'fs_read_file'/'web_search'/'knowledge_search' resolvable by name —
// mirrors the self-registration side effect every agent's index.ts
// already has.
export function registerBuiltinTools(): void {
  registerPostgresTools(aiFoundation.toolRegistry);
  registerGitHubTools(aiFoundation.toolRegistry);
  registerFilesystemTools(aiFoundation.toolRegistry);
  registerWebSearchTools(aiFoundation.toolRegistry);
  registerKnowledgeTools(aiFoundation.toolRegistry, retrievalService);
}

export * from './postgres.tool.js';
export * from './github.tool.js';
export * from './filesystem.tool.js';
export * from './websearch.provider.js';
export * from './websearch.tool.js';
export * from './knowledge.tool.js';
