// The context every tool's execute() receives is exactly AIContext (who's
// asking, what asset/session/conversation they're in, the running
// toolHistory/executionHistory) — Phase 16 already designed AIContext to
// serve this role. `ToolContext` is an alias, not a new type, so this
// module satisfies the Phase 24 spec's "ToolContext" naming without
// creating a second, parallel context shape every existing tool would
// need to be rewritten to accept.
export type { AIContext as ToolContext } from '../types/context.types.js';
