import { DebateEngine, debateEngine } from './debate.engine.js';
import { DebateMemory, debateMemory } from './debate.memory.js';
import { DebateTelemetry, debateTelemetry } from './debate.telemetry.js';
import { ConsensusEngine, consensusEngine } from './consensus.engine.js';
import { ConsensusStore, consensusStore } from './consensus.js';

// Composition root — mirrors ai/planner/reasoning.ts's
// createReasoningFoundation()/reasoningFoundation: one object routes can
// import instead of reaching into every individual debate.*/consensus.*
// module. Every piece here is already a process-wide singleton (same
// "instantiate once, at module load, wired to the shared redis client"
// convention every other Phase 25+ composition root uses) — this module
// only groups them.
export interface DebateFoundation {
  engine: DebateEngine;
  memory: DebateMemory;
  telemetry: DebateTelemetry;
  consensusEngine: ConsensusEngine;
  consensusStore: ConsensusStore;
}

export const debateFoundation: DebateFoundation = {
  engine: debateEngine,
  memory: debateMemory,
  telemetry: debateTelemetry,
  consensusEngine,
  consensusStore,
};
